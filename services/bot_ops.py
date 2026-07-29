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

Everything here goes through the jobs table and runner_client, so an app acted
on from Telegram behaves exactly as it does on the site — same worker routing,
same admin visibility.

CREATION AND CODE EDITING ARE DELIBERATELY ABSENT. deploy() and update_code()
lived here while the bot accepted pasted snippets; both are gone. A Telegram
message caps at ~4096 characters and offers no editor, so that path could only
ever serve toy scripts while looking like a real way to work. Apps are created
and edited in the Mini App and the website — one UI, one create path
(POST /api/jobs). What remains here is lifecycle and read-only status, which
is what a chat is actually good at.
"""
import logging
import re

from database import get_db_connection
from routes.deps import now_utc_str
from services import runner_client
# Re-exported: pingbot reads bot_ops.MAX_JOBS_PER_USER when showing how many
# slots an account has left, so there is one value, not two.
from services.runner_client import MAX_JOBS_PER_USER  # noqa: F401

logger = logging.getLogger("codenest-app")

def slugify_name(raw: str) -> str:
    """A job name the site would also accept. Used by /rename."""
    s = re.sub(r"[^A-Za-z0-9 _-]+", "", (raw or "")).strip()
    s = re.sub(r"\s+", "-", s).strip("-")
    return s[:40]


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
