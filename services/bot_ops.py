"""Everything the Telegram bot does to a user's apps, on the SAME rails the
website uses.

WHY THIS EXISTS
---------------
services/pingbot.py called the runner directly. Measured:

    bot deploys a job  ->  rows in jobs table        : 0
                           jobs visible in /admin/jobs: 0
                           runner actually running    : 1

So a bot-deployed app burned real memory while being invisible to the admin
console, exempt from MAX_JOBS_PER_USER, and unable to appear in the owner's own
dashboard. Two deploy paths meant two sets of rules, and only one of them was
enforced.

Everything here goes through the jobs table and runner_client, so a job created
from Telegram is indistinguishable from one created on the site — same cap,
same worker routing, same admin visibility.
"""
import json
import logging
import re

from database import get_db_connection
from routes.deps import now_utc_str
from services import runner_client
from services.runner_client import MAX_JOBS_PER_USER

logger = logging.getLogger("codenest-app")

# Import-time detection of what a snippet needs. Deliberately small: guessing
# wrong installs the wrong package, and the runner already reads a real
# requirements block when the user supplies one.
_LIB_MAP = {
    "requests": "requests", "flask": "flask", "fastapi": "fastapi",
    "pandas": "pandas", "numpy": "numpy", "openai": "openai",
    "telebot": "pyTelegramBotAPI", "telegram": "python-telegram-bot",
    "aiogram": "aiogram", "bs4": "beautifulsoup4", "aiohttp": "aiohttp",
    "dotenv": "python-dotenv", "yaml": "PyYAML", "PIL": "pillow",
}


def detect_libs(code: str) -> list:
    found = []
    for mod in re.findall(r"^\s*(?:import|from)\s+([A-Za-z0-9_]+)", code or "",
                          re.MULTILINE):
        pkg = _LIB_MAP.get(mod) or _LIB_MAP.get(mod.lower())
        if pkg and pkg not in found:
            found.append(pkg)
    return found


def detect_language(code: str) -> str:
    c = (code or "").lower()
    if "<html" in c or "<!doctype html" in c:
        return "html"
    if "console.log" in c or "require(" in c or "module.exports" in c:
        return "javascript"
    return "python"


def slugify_name(raw: str) -> str:
    """A job name the site would also accept."""
    s = re.sub(r"[^A-Za-z0-9 _-]+", "", (raw or "")).strip()
    s = re.sub(r"\s+", "-", s).strip("-")
    return s[:40]


def unique_name(user_id: int, wanted: str) -> str:
    """Make `wanted` unique for this account, the way the site requires.

    The site rejects a duplicate name with a 409 and tells the user to pick
    another. In a chat that is a dead end — the code has already been sent —
    so a numeric suffix is appended instead.
    """
    base = slugify_name(wanted) or "bot"
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT LOWER(name) AS n FROM jobs WHERE user_id = ?", (user_id,)
        ).fetchall()
        taken = {dict(r)["n"] for r in rows}
    finally:
        conn.close()
    if base.lower() not in taken:
        return base
    for i in range(2, 100):
        cand = f"{base}-{i}"
        if cand.lower() not in taken:
            return cand
    return f"{base}-{int(__import__('time').time())}"


def list_apps(user_id: int) -> list:
    """This account's apps, with live status from the worker holding each."""
    conn = get_db_connection()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, name, language, runner_job_id, worker_url, created_at "
            "FROM jobs WHERE user_id = ? ORDER BY id DESC", (user_id,)
        ).fetchall()]
    finally:
        conn.close()
    live = runner_client.fleet_jobs()
    for r in rows:
        info = live.get(r.get("runner_job_id")) or {}
        r["status"] = info.get("status") or ("offline" if r.get("runner_job_id") else "stopped")
        r["mem_mb"] = info.get("mem_mb")
        r["uptime_s"] = info.get("uptime_s")
        r["restarts"] = info.get("restarts")
        r["last_exit_reason"] = info.get("last_exit_reason")
    return rows


def find_app(user_id: int, ref: str) -> dict:
    """Resolve a name or numeric id to one of THIS user's apps.

    Scoped to user_id on purpose: a bot command must never be able to address
    someone else's job by guessing an id.
    """
    ref = (ref or "").strip()
    if not ref:
        return None
    conn = get_db_connection()
    try:
        row = None
        if ref.isdigit():
            row = conn.execute(
                "SELECT * FROM jobs WHERE user_id = ? AND id = ?",
                (user_id, int(ref))).fetchone()
        if not row:
            row = conn.execute(
                "SELECT * FROM jobs WHERE user_id = ? AND LOWER(name) = LOWER(?)",
                (user_id, ref)).fetchone()
        if not row:
            # Partial match, so "/logs mybot" works when the app is
            # "mybot-2" — but only when it is unambiguous.
            hits = conn.execute(
                "SELECT * FROM jobs WHERE user_id = ? AND LOWER(name) LIKE LOWER(?)",
                (user_id, f"%{ref}%")).fetchall()
            if len(hits) == 1:
                row = hits[0]
    finally:
        conn.close()
    return dict(row) if row else None


def _worker_of(row) -> str:
    try:
        return (dict(row).get("worker_url") or "") or None
    except Exception:
        return None


def active_count(user_id: int) -> int:
    """Apps the runner reports as alive. Counting rows would lock an account
    out after MAX_JOBS_PER_USER lifetime jobs even with all of them stopped."""
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT runner_job_id FROM jobs WHERE user_id = ?", (user_id,)
        ).fetchall()
    finally:
        conn.close()
    live = set(runner_client.fleet_jobs())
    if not live:
        return len(rows)
    return sum(1 for r in rows if dict(r).get("runner_job_id") in live)


def deploy(user_id: int, name: str, code: str, language: str = "",
           libs: list = None) -> dict:
    """Create an app for this account. Same rules as POST /api/jobs.

    Returns {"ok": True, "job": {...}} or {"ok": False, "error": "..."}.
    """
    code = code or ""
    if not code.strip():
        return {"ok": False, "error": "There was no code in that message."}

    used = active_count(user_id)
    if used >= MAX_JOBS_PER_USER:
        return {"ok": False, "error":
                f"You already have {used} of {MAX_JOBS_PER_USER} apps running. "
                f"Stop one first — /apps shows them."}

    language = language or detect_language(code)
    name = unique_name(user_id, name)
    libs = libs if libs is not None else detect_libs(code)

    body = {"language": language, "code": code, "name": f"u{user_id}-{name}",
            "env": {}}
    if libs:
        body["requirements"] = "\n".join(libs)
    try:
        resp = runner_client._runner_http("POST", "/internal/jobs", body)
    except Exception as exc:
        logger.warning("bot deploy: runner call failed (%s)", exc)
        return {"ok": False, "error": "The job engine is waking up. Try again in a minute."}
    if resp is None or resp.status_code != 201:
        detail = "The job engine refused it."
        try:
            detail = (resp.json() or {}).get("detail") or detail
        except Exception:
            pass
        return {"ok": False, "error": detail}

    info = resp.json() or {}
    now = now_utc_str()
    conn = get_db_connection()
    try:
        cur = conn.execute(
            "INSERT INTO jobs (user_id, name, language, code, runner_job_id, "
            "worker_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (user_id, name, language, code, info.get("id"),
             getattr(resp, "placed_on", None), now, now),
        )
        conn.commit()
        job_id = cur.lastrowid
    finally:
        conn.close()

    info.update(runner_client._job_web_fields(info, getattr(resp, "placed_on", None)))
    return {"ok": True, "job": {"id": job_id, "name": name, "language": language,
                                "runner_job_id": info.get("id"),
                                "web_url": info.get("web_url"),
                                "libs": libs}}


def _act(user_id: int, ref: str, verb: str) -> dict:
    row = find_app(user_id, ref)
    if not row:
        return {"ok": False, "error": f"No app called “{ref}”. /apps lists yours."}
    rid = row.get("runner_job_id")
    if not rid:
        return {"ok": False, "error": f"“{row['name']}” was never deployed."}
    path = {"restart": f"/internal/jobs/{rid}/restart",
            "stop": f"/internal/jobs/{rid}/stop"}[verb]
    try:
        runner_client._runner_http("POST", path, worker=_worker_of(row))
    except Exception as exc:
        logger.warning("bot %s failed for job %s: %s", verb, row.get("id"), exc)
        return {"ok": False, "error": "The worker did not answer. Try again shortly."}
    return {"ok": True, "job": row}


def restart(user_id: int, ref: str) -> dict:
    return _act(user_id, ref, "restart")


def stop(user_id: int, ref: str) -> dict:
    return _act(user_id, ref, "stop")


def delete(user_id: int, ref: str) -> dict:
    """Remove the app entirely — runner first, then the row."""
    row = find_app(user_id, ref)
    if not row:
        return {"ok": False, "error": f"No app called “{ref}”. /apps lists yours."}
    rid = row.get("runner_job_id")
    if rid:
        try:
            runner_client._runner_http("DELETE", f"/internal/jobs/{rid}",
                                       worker=_worker_of(row))
        except Exception as exc:
            # Best effort: a worker that is asleep must not strand the row
            # forever, or the user can never get back under their cap.
            logger.warning("bot delete: runner call failed for %s: %s", rid, exc)
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM jobs WHERE id = ? AND user_id = ?",
                     (row["id"], user_id))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "job": row}


def rename(user_id: int, ref: str, new_name: str) -> dict:
    row = find_app(user_id, ref)
    if not row:
        return {"ok": False, "error": f"No app called “{ref}”. /apps lists yours."}
    clean = slugify_name(new_name)
    if not clean:
        return {"ok": False, "error": "That name has no usable characters."}
    conn = get_db_connection()
    try:
        dup = conn.execute(
            "SELECT id FROM jobs WHERE user_id = ? AND LOWER(name) = LOWER(?) AND id != ?",
            (user_id, clean, row["id"])).fetchone()
        if dup:
            return {"ok": False, "error": f"You already have an app called “{clean}”."}
        conn.execute("UPDATE jobs SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                     (clean, now_utc_str(), row["id"], user_id))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "old": row["name"], "name": clean}


def update_code(user_id: int, ref: str, code: str) -> dict:
    """Replace an app's code and restart it on the SAME worker.

    Rebuild, not recreate: the runner keeps the job's persistent workspace
    directory keyed by its id, so a bot that has written a SQLite file keeps it.
    Deleting and re-creating would silently wipe that.
    """
    row = find_app(user_id, ref)
    if not row:
        return {"ok": False, "error": f"No app called “{ref}”. /apps lists yours."}
    if not (code or "").strip():
        return {"ok": False, "error": "There was no code in that message."}
    rid = row.get("runner_job_id")
    if not rid:
        return {"ok": False, "error": f"“{row['name']}” was never deployed."}

    libs = detect_libs(code)
    body = {"code": code, "language": row.get("language") or detect_language(code)}
    if libs:
        body["requirements"] = "\n".join(libs)
    try:
        resp = runner_client._runner_http(
            "POST", f"/internal/jobs/{rid}/restart", body, worker=_worker_of(row))
    except Exception as exc:
        logger.warning("bot update: restart failed for %s: %s", rid, exc)
        return {"ok": False, "error": "The worker did not answer. Try again shortly."}
    if resp is not None and resp.status_code >= 400:
        detail = "The job engine refused the update."
        try:
            detail = (resp.json() or {}).get("detail") or detail
        except Exception:
            pass
        return {"ok": False, "error": detail}

    conn = get_db_connection()
    try:
        conn.execute("UPDATE jobs SET code = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                     (code, now_utc_str(), row["id"], user_id))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "job": row, "libs": libs}


def logs(user_id: int, ref: str, lines: int = 40) -> dict:
    row = find_app(user_id, ref)
    if not row:
        return {"ok": False, "error": f"No app called “{ref}”. /apps lists yours."}
    rid = row.get("runner_job_id")
    if not rid:
        return {"ok": False, "error": f"“{row['name']}” was never deployed."}
    try:
        resp = runner_client._runner_http(
            "GET", f"/internal/jobs/{rid}", worker=_worker_of(row))
    except Exception as exc:
        logger.warning("bot logs: worker unreachable for %s: %s", rid, exc)
        return {"ok": False, "error": "The worker did not answer."}
    if resp is None or resp.status_code != 200:
        return {"ok": False, "error": "That app is not on the worker any more."}
    info = resp.json() or {}
    text = (info.get("logs") or "").splitlines()
    return {"ok": True, "job": row, "info": info,
            "logs": "\n".join(text[-lines:]),
            "truncated": len(text) > lines}
