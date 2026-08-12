"""RunSpace: one-shot code execution proxy + 24/7 always-on jobs
(start/stop/restart, live logs SSE, public URL access control)."""
from typing import Optional, List

from fastapi import APIRouter, Header, HTTPException, Request

from routes.deps import *  # shared kernel (config, helpers, models)


class JobCreateRequest(BaseModel):
    name: str
    language: str
    code: str
    repo_url: Optional[str] = None
    entry: Optional[str] = None
    env: Optional[dict] = None


class JobUpdateRequest(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None
    code: Optional[str] = None
    repo_url: Optional[str] = None
    entry: Optional[str] = None
    env: Optional[dict] = None


class EntryPinPayload(BaseModel):
    path: str


class GithubImportRequest(BaseModel):
    url: str


import asyncio
import json
import logging
import re
import time
from urllib.parse import urlparse

from fastapi.responses import StreamingResponse

from services import runner_client
from services import limits
from services.runner_client import MAX_JOBS_PER_USER

logger = logging.getLogger("codenest.runspace")

# Log-stream safety valves. A stream that cannot end will pin one request (and
# a worker thread per poll in embedded mode) until the server is exhausted.
SSE_POLL_INTERVAL_S = 1.5
SSE_MAX_LIFETIME_S = float(os.getenv("SSE_MAX_LIFETIME_S", "900"))  # 15 min, then reconnect

# Cross-account fingerprint/IP cluster limiting is written and tested
# (services/limits.py) but intentionally DISABLED: current scope is a simple
# per-account cap. Set CLUSTER_LIMITS_ENABLED=1 to switch it back on.
CLUSTER_LIMITS_ENABLED = os.getenv("CLUSTER_LIMITS_ENABLED", "").strip().lower() in ("1", "true", "yes")

router = APIRouter()


class ExecuteCodeRequest(BaseModel):
    language: str
    code: str
    stdin: Optional[str] = None


@router.post("/api/execute")
def execute_code(payload: ExecuteCodeRequest, request: Request, authorization: Optional[str] = Header(None)):
    """Proxy code execution to the separate runner service.

    User → this endpoint (auth required) → runner service (shared secret).
    The user NEVER sees the runner URL or secret — those stay server-side.
    """
    # 1) User must be logged in.
    user, _ = get_current_user_and_session(authorization)

    # 2) Rate limit — per ACCOUNT (never per-IP: CGNAT-shared mobile IPs
    #    would let strangers burn each other's allowance).
    rate_limit_user(user["id"], "exec")

    # 3) Forward to the runner (embedded in-process, or remote when
    #    RUNNER_SERVICE_URL is set). Secret never leaves the server.
    try:
        response = runner_client._runner_http("POST", "/internal/execute", {
            "language": payload.language,
            "code": payload.code,
            "stdin": payload.stdin or "",
        })
    except HTTPException:
        raise
    except Exception:
        logger.error("Runner call failed unexpectedly")
        raise HTTPException(
            status_code=503,
            detail="Code execution service is temporarily unavailable. Please try again later.",
        )

    if response.status_code == 401:
        raise HTTPException(status_code=500, detail="Runner authentication failed. Contact admin.")
    if response.status_code == 403:
        raise HTTPException(status_code=500, detail="Runner secret mismatch. Contact admin.")
    if response.status_code != 200:
        detail = None
        try:
            detail = response.json().get("detail")
        except Exception:
            pass
        raise HTTPException(
            status_code=502,
            detail=detail or "Code execution service returned an error ({}).".format(response.status_code),
        )

    result = response.json()
    # Pass through stdout/stderr/exit_code/execution_time to the user.
    # The runner URL and secret are NEVER in this response.
    return result


# ================================
# ALWAYS-ON JOBS (24/7 background tasks — mini PythonAnywhere)
# ================================
# Job DEFINITIONS live in our DB (survive runner restarts); the PROCESSES run
# inside the runner service. Same secret, same proxy pattern as /api/execute.

def _get_own_job(job_id: int, user: dict) -> dict:
    """Fetch a job row owned by this user or 404."""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id = ? AND user_id = ?", (job_id, user["id"])).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found.")
    return dict(row)


def _worker_of(row) -> str:
    """Which worker this job physically runs on.

    Every per-job call must go to THIS worker, not to whichever one happens to
    be first in the pool. NULL means the row predates the column, and those
    jobs all live on the primary worker — the fallback inside _runner_http.
    """
    try:
        return (dict(row).get("worker_url") or "") or None
    except Exception:
        return None


def _remember_worker(job_db_id: int, resp) -> None:
    """Persist the worker a create landed on, so later calls can find it."""
    placed = getattr(resp, "placed_on", None)
    if not placed or not job_db_id:
        return
    conn = get_db_connection()
    try:
        conn.execute("UPDATE jobs SET worker_url = ? WHERE id = ?", (placed, job_db_id))
        conn.commit()
    except Exception as exc:            # never fail a launch over bookkeeping
        logger.warning("could not record worker for job %s: %s", job_db_id, exc)
    finally:
        conn.close()


def _row_env(row) -> dict:
    """Env vars saved for a job row (empty when unset / unparsable)."""
    try:
        raw = dict(row).get("env")
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def _restore_then_restart(job_id: int, info: dict, worker: str = None) -> dict:
    """After a COLD start, push the last snapshot into the fresh workspace.

    A cold start means the runner lost the directory (a deploy on the free
    tier). The job is already running at this point, against an empty dir — a
    bot that opened database.db has just created a blank one. So we restore the
    saved data files and restart the process in place so it re-opens them.

    Entirely best-effort: if there is no snapshot, or the runner refuses, the
    job keeps running exactly as it did before this feature existed.
    """
    rid = info.get("id")
    if not rid:
        return info
    try:
        from services import snapshots
        res = snapshots.restore_snapshot(job_id, rid, overwrite=True)
        if res.get("restored"):
            r = runner_client._runner_http("POST", f"/internal/jobs/{rid}/restart", worker=worker)
            if r.status_code == 200:
                fresh = r.json()
                fresh["restored_files"] = res["restored"]
                return fresh
            info["restored_files"] = res["restored"]
    except Exception as exc:  # never block a start on a restore problem
        logging.getLogger(__name__).warning(
            "snapshot restore after cold start failed (job %s): %s", job_id, exc)
    return info


_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_ENV_BLOCKED = {
    "PATH", "PYTHONPATH", "PORT", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH",
    "PYTHONSTARTUP", "PYTHONHOME", "BASH_ENV", "ENV", "SHELL", "IFS",
    "RUNNER_SERVICE_SECRET", "DATABASE_URL",
}


def _clean_env_map(raw) -> dict:
    """Validate env vars here too — never trust the browser to have done it."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        k = str(k).strip()
        if not _ENV_KEY_RE.match(k) or k.upper() in _ENV_BLOCKED:
            continue
        out[k] = ("" if v is None else str(v))[:4096]
        if len(out) >= 40:
            break
    return out


@router.post("/api/jobs")
def create_job(payload: JobCreateRequest, request: Request, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    rate_limit_user(user["id"], "exec")

    # Device/IP are still RECORDED (cheap, and useful for future abuse work),
    # but cross-account cluster limiting is OFF by default: the current scope is
    # a simple per-account cap. The fingerprint/IP cluster implementation lives
    # in services/limits.py and is re-enabled with CLUSTER_LIMITS_ENABLED=1.
    fp = normalise_fingerprint(request.headers.get("X-Fingerprint", "")[:4000])
    ip = client_ip(request)

    conn = get_db_connection()
    try:
        conn.execute(
            "UPDATE users SET fingerprint = COALESCE(NULLIF(?, ''), fingerprint), last_ip = ? WHERE id = ?",
            (fp, ip, user["id"]),
        )
        conn.commit()
        if CLUSTER_LIMITS_ENABLED:
            limits.check_job_quota(conn, user["id"], fp, ip)
    finally:
        conn.close()

    name = (payload.name or "").strip()[:60]
    repo_url = (payload.repo_url or "").strip()
    entry = (payload.entry or "").strip()
    if not name and repo_url:
        m = re.search(r"github\.com/[^/]+/([^/]+)", repo_url)
        name = (m.group(1) if m else "repo").replace(".git","")[:60]
    if not name:
        raise HTTPException(status_code=422, detail="Give the job a name.")
    if not (payload.code or "").strip() and not repo_url:
        raise HTTPException(status_code=422, detail="Provide code or a repo URL.")

    # Per-user name uniqueness (case-insensitive)
    conn = get_db_connection()
    try:
        dup = conn.execute(
            "SELECT id FROM jobs WHERE user_id = ? AND LOWER(name) = LOWER(?)",
            (user["id"], name),
        ).fetchone()
        if dup:
            conn.close()
            raise HTTPException(status_code=409, detail=f"You already have a job named \u201c{name}\u201d \u2014 choose a different name.")
        # Per-account cap on CONCURRENT jobs (§2). Counting every row ever
        # created would permanently lock a user out after 3 lifetime jobs even
        # if all of them were stopped, so only jobs the runner reports as alive
        # count. If the runner is unreachable we fall back to the row count
        # rather than letting the cap disappear entirely.
        rows = conn.execute(
            "SELECT runner_job_id FROM jobs WHERE user_id = ?", (user["id"],)
        ).fetchall()
        live_ids = limits.running_runner_ids()
        if live_ids:
            active = sum(1 for r in rows if dict(r).get("runner_job_id") in live_ids)
        else:
            active = len(rows)
        if active >= MAX_JOBS_PER_USER:
            conn.close()
            raise HTTPException(
                status_code=429,
                detail=(f"You already have {active} of {MAX_JOBS_PER_USER} RunSpace jobs "
                        f"running — stop one before starting another."),
            )
    except HTTPException:
        raise

    env_map = _clean_env_map(payload.env)
    body = {
        "language": payload.language or "python",
        "code": payload.code or "",
        "name": f"u{user['id']}-{name}",
        "env": env_map,
    }
    if repo_url:
        body["repo_url"] = repo_url
        if entry: body["entry"] = entry
    resp = runner_client._runner_http("POST", "/internal/jobs", body)
    if resp.status_code == 201:
        info = resp.json()
    elif resp.status_code in (401, 403):
        raise HTTPException(status_code=500, detail="Runner secret mismatch. Contact admin.")
    else:
        try:
            detail = resp.json().get("detail", "Runner rejected the job.")
        except Exception:
            detail = "Runner rejected the job."
        raise HTTPException(status_code=resp.status_code if 400 <= resp.status_code < 500 else 502, detail=detail)

    now = now_utc_str()
    conn = get_db_connection()
    try:
        cursor = conn.execute(
            """
            INSERT INTO jobs (user_id, name, language, code, runner_job_id, env, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (user["id"], name, payload.language, payload.code, info["id"],
             json.dumps(env_map) if env_map else None, now, now),
        )
        conn.commit()
        info["job_db_id"] = cursor.lastrowid
        # Remember WHICH worker accepted this job. Every later restart / stop /
        # log call reads it back, so a job on worker-B is never addressed to
        # worker-A once a second worker exists.
        _remember_worker(cursor.lastrowid, resp)
        info.update(runner_client._job_web_fields(info, getattr(resp, "placed_on", None)))  # web / web_url
        return info
    finally:
        conn.close()


@router.get("/api/jobs")
def list_jobs(authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        rows = conn.execute("SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC", (user["id"],)).fetchall()
    finally:
        conn.close()

    # Live status from the runner — best effort (it may be asleep/restarted).
    live, runner_state = {}, "ok"
    runner_ok = False          # did the runner actually answer?
    try:
        resp = runner_client._runner_http("GET", "/internal/jobs")
        if resp.status_code == 200:
            live = {j["id"]: j for j in resp.json().get("jobs", [])}
            runner_ok = True
        else:
            runner_state = "Waking up your RunSpace... this can take up to a minute on the free tier"
    except HTTPException as e:
        runner_state = e.detail

    jobs = []
    for r in rows:
        r = dict(r)
        rid = r.get("runner_job_id")
        if rid and rid in live:
            info = live[rid]
            r.update({"status": info["status"], "uptime_s": info.get("uptime_s", 0),
                      "restarts": info.get("restarts", 0), "port": info.get("port"),
                      "cpu_pct": info.get("cpu_pct"), "mem_mb": info.get("mem_mb")})
            r.update(runner_client._job_web_fields(info, _worker_of(r)))     # web / web_url / access
        elif runner_ok:
            # The runner answered and did not list this job -> genuinely down.
            r.update({"status": "offline", "uptime_s": 0, "restarts": 0})
        else:
            # Runner unreachable: we do NOT know the state. Saying "offline"
            # here is what made running jobs appear stopped after a tab switch.
            r.update({"status": "unknown", "status_stale": True})
        r["env"] = _row_env(r)          # saved env vars (Details page)
        r.pop("code", None)  # never ship stored code back in list payloads
        jobs.append(r)
    return {"jobs": jobs, "runner": runner_state, "max_per_user": MAX_JOBS_PER_USER}


@router.get("/api/jobs/{job_id}")
def get_job(job_id: int, authorization: Optional[str] = Header(None)):
    """Return a single job WITH its saved code (for the Edit button)."""
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    row = dict(row)
    # Attach live status. CRITICAL: never report a RUNNING job as "offline"
    # just because the runner was momentarily unreachable (free-tier cold
    # start returns 503). That lie is what made a tab show "not running" after
    # switching away and back. "unknown" tells the client to keep what it has
    # and retry, instead of painting a wrong state.
    rid = row.get("runner_job_id")
    row["status_stale"] = False
    if rid:
        try:
            resp = runner_client._runner_http("GET", f"/internal/jobs/{rid}", worker=_worker_of(row))
            if resp.status_code == 200:
                info = resp.json()
                row["status"] = info.get("status")
                row["uptime_s"] = info.get("uptime_s", 0)
                row["restarts"] = info.get("restarts", 0)
                row["port"] = info.get("port")
                row["cpu_pct"] = info.get("cpu_pct")
                row["mem_mb"] = info.get("mem_mb")
                # Populate web URL fields
                info2 = dict(info)
                info2.update(runner_client._job_web_fields(info, _worker_of(row)))
                row["web"] = info2.get("web")
                row["web_url"] = info2.get("web_url")
                row["web_private_url"] = info2.get("web_private_url")
                row["web_public"] = info2.get("web_public", True)
            elif resp.status_code == 404:
                # Runner is up and says this job does not exist -> truly gone.
                row["status"] = "offline"
            else:
                row["status"] = "unknown"
                row["status_stale"] = True
        except HTTPException:
            # Runner unreachable / waking up — we simply do not know yet.
            row["status"] = "unknown"
            row["status_stale"] = True
    else:
        row["status"] = "offline"
    row["env"] = _row_env(row)
    return row


# ── FILE BROWSER ───────────────────────────────────────────────────────────
# Thin pass-throughs to the runner. Ownership is checked here via
# _get_own_job(); the runner only ever sees its own job id, so one user can
# never read another's workspace.

@router.get("/api/jobs/{job_id}/files")
def job_files(job_id: int, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        return {"files": [], "entry": None, "truncated": False}
    resp = runner_client._runner_http("GET", f"/internal/jobs/{rid}/files",
                                      worker=_worker_of(row))
    if resp.status_code == 404:
        return {"files": [], "entry": None, "truncated": False,
                "note": "runner restarted — press Restart to relaunch"}
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not list files.")
    return resp.json()


@router.get("/api/jobs/{job_id}/file")
def job_file_read(job_id: int, path: str, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=409, detail="Job is not running.")
    from urllib.parse import quote
    resp = runner_client._runner_http(
        "GET", f"/internal/jobs/{rid}/file?path={quote(path, safe='')}",
        worker=_worker_of(row))
    if resp.status_code != 200:
        # Forward the runner's own explanation (too big / binary / missing)
        # rather than flattening every case into one unhelpful 502.
        try:
            detail = resp.json().get("detail") or "Could not read that file."
        except Exception:
            detail = "Could not read that file."
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


@router.post("/api/jobs/{job_id}/entry")
def job_set_entry(job_id: int, payload: EntryPinPayload,
                  authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=409, detail="Start the job once first.")
    resp = runner_client._runner_http(
        "POST", f"/internal/jobs/{rid}/entry", json_body={"path": payload.path},
        worker=_worker_of(row))
    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail") or "Could not set the entry point."
        except Exception:
            detail = "Could not set the entry point."
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()


@router.get("/api/jobs/{job_id}/logs")
def job_logs(job_id: int, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        return {"status": "offline", "logs": "(never started)"}
    resp = runner_client._runner_http("GET", f"/internal/jobs/{rid}", worker=_worker_of(row))
    if resp.status_code == 404:
        return {"status": "offline", "logs": "(runner restarted — press ▶ Restart to relaunch)"}
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not fetch logs from runner.")
    info = resp.json()
    return {"status": info.get("status"), "logs": info.get("logs", ""), "uptime_s": info.get("uptime_s", 0), "restarts": info.get("restarts", 0)}


@router.get("/api/jobs/{job_id}/logs/stream")
async def job_logs_stream(job_id: int, request: Request, token: Optional[str] = None):
    """Server-Sent Events: push a job's logs to the dashboard in real time.

    EventSource can't send Authorization headers, so the session token comes
    as a ?token= query param; we validate it against the sessions table the
    same way get_current_user_and_session does.
    """
    token = (token or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    conn = get_db_connection()
    try:
        # Match deps.get_current_user_and_session: lazy migrate + honour expiry
        from routes.deps import _ensure_expires_column
        _ensure_expires_column(conn)
        session_row = conn.execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()
        if not session_row:
            raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
        try:
            from datetime import datetime, timezone, timedelta
            exp = session_row["expires_at"] if "expires_at" in session_row.keys() else None
            if exp:
                exp_dt = datetime.strptime(exp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) > exp_dt:
                    conn.execute("DELETE FROM sessions WHERE id = ?", (session_row["id"],))
                    conn.commit()
                    raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
        except HTTPException:
            raise
        except Exception:
            pass
        conn.execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (now_utc_str(), session_row["id"]))
        # Sliding expiry mirror (same logic as get_current_user_and_session)
        try:
            from datetime import datetime, timezone, timedelta as _td
            from routes.deps import SESSION_TTL_DAYS
            exp_str = session_row["expires_at"] if "expires_at" in session_row.keys() else None
            if exp_str:
                exp_d = datetime.strptime(exp_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                now_d = datetime.now(timezone.utc)
                if exp_d - now_d < _td(days=SESSION_TTL_DAYS - 1):
                    new_exp = (now_d + _td(days=SESSION_TTL_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
                    conn.execute("UPDATE sessions SET expires_at = ? WHERE id = ?", (new_exp, session_row["id"]))
        except Exception:
            pass
        conn.commit()
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (session_row["user_id"],)).fetchone()
        if not user_row:
            raise HTTPException(status_code=401, detail="Account not found.")
        if "is_suspended" in user_row.keys() and user_row["is_suspended"]:
            raise HTTPException(status_code=401, detail="This account is suspended.")
    finally:
        conn.close()

    row = _get_own_job(job_id, user_row)
    rid = row.get("runner_job_id")

    async def gen():
        """Push status+logs until the client goes away.

        This loop MUST be able to end. Without a disconnect check it ran
        forever: every job a user opened pinned one request (and, in embedded
        mode, a worker thread per poll) until the server ran out of capacity
        and the whole RunSpace UI froze. Closing a browser tab does not raise
        inside the generator, so we poll request.is_disconnected() and also
        cap the total lifetime — the client reconnects automatically, which is
        exactly what EventSource is designed to do.
        """
        last = None
        started = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    break
                if time.monotonic() - started > SSE_MAX_LIFETIME_S:
                    # Tell the client to reconnect, then close this one cleanly.
                    yield "event: reconnect\ndata: {}\n\n"
                    break

                info = None
                if rid:
                    try:
                        resp = await asyncio.to_thread(_runner_http, "GET", f"/internal/jobs/{rid}")
                        if resp.status_code == 200:
                            info = resp.json()
                    except Exception:
                        info = None
                payload = {
                    "status": (info or {}).get("status", "offline"),
                    "logs": (info or {}).get("logs", "(Waking up your RunSpace... this can take up to a minute on the free tier)"),
                    "uptime_s": (info or {}).get("uptime_s", 0),
                    "restarts": (info or {}).get("restarts", 0),
                }
                blob = json.dumps(payload, ensure_ascii=False)
                if blob != last:
                    last = blob
                    yield f"data: {blob}\n\n"
                else:
                    # Comment frame doubles as a keep-alive AND as the write
                    # that surfaces a dead peer to the transport.
                    yield ": ping\n\n"
                await asyncio.sleep(SSE_POLL_INTERVAL_S)
        except asyncio.CancelledError:  # client aborted mid-write
            raise
        except Exception as exc:  # noqa: BLE001 — never leak a stack trace into the stream
            logger.warning("log stream for job %s ended: %s", job_id, exc)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/jobs/{job_id}/files")
def list_job_files(job_id: int, authorization: Optional[str] = Header(None)):
    """List candidate downloadable files from the job workspace (best-effort).
    Walks the runner job dir and returns regular files with sizes. Used by the
    drawer "Download database" button to offer the most-likely DB file first.
    """
    import os
    from pathlib import Path
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    out = []
    if rid:
        try:
            resp = runner_client._runner_http("GET", f"/internal/jobs/{rid}", worker=_worker_of(row))
            if resp.status_code == 200:
                info = resp.json()
                jdir = info.get("dir") or ""
                if jdir and os.path.isdir(jdir):
                    # Skip system/hidden dirs (pylibs, .git, node_modules)
                    skip_dirs = {"pylibs", ".git", "node_modules", "__pycache__", ".venv", "venv"}
                    root = Path(jdir)
                    for p in root.rglob("*"):
                        try:
                            if not p.is_file(): continue
                            rel = p.relative_to(root)
                            if any(part in skip_dirs for part in rel.parts): continue
                            size = p.stat().st_size
                            if size > 32 * 1024 * 1024: continue  # cap at 32MB
                            out.append({"path": str(rel).replace(os.sep, "/"), "size": size})
                        except Exception:
                            pass
        except Exception:
            pass
    # Sort databases (.db/.sqlite/.sqlite3) first, then by path
    out.sort(key=lambda f: (0 if f["path"].lower().endswith((".db",".sqlite",".sqlite3",".json")) else 1, f["path"]))
    return {"files": out}


@router.get("/api/jobs/{job_id}/files/{file_path:path}")
def download_job_file(job_id: int, file_path: str, authorization: Optional[str] = Header(None)):
    """Download a single file from the job workspace."""
    import os
    import mimetypes
    from pathlib import Path
    from fastapi.responses import FileResponse
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=404, detail="Job not running.")
    resp = runner_client._runner_http("GET", f"/internal/jobs/{rid}", worker=_worker_of(row))
    if resp.status_code != 200:
        raise HTTPException(status_code=404, detail="Job workspace unavailable.")
    info = resp.json()
    jdir = info.get("dir") or ""
    # Prevent path traversal
    target = (Path(jdir) / file_path).resolve()
    jroot = Path(jdir).resolve()
    if not str(target).startswith(str(jroot) + os.sep) and target != jroot:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    ctype, _ = mimetypes.guess_type(str(target))
    return FileResponse(str(target), filename=target.name,
                        media_type=ctype or "application/octet-stream")


@router.get("/api/jobs/{job_id}/snapshot")
def get_job_snapshot_status(job_id: int, authorization: Optional[str] = Header(None)):
    """When was this job's data last backed up, and how big is it?"""
    user, _ = get_current_user_and_session(authorization)
    _get_own_job(job_id, user)
    from services import snapshots
    meta = snapshots.snapshot_meta(job_id)
    return {
        "enabled": snapshots.SNAPSHOTS_ENABLED,
        "snapshot": meta,
        "interval_s": snapshots.SNAPSHOT_INTERVAL_S,
    }


@router.post("/api/jobs/{job_id}/snapshot")
def create_job_snapshot(job_id: int, authorization: Optional[str] = Header(None)):
    """Back up this job's data files right now (the "Backup data" button)."""
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=409, detail="Job is not deployed yet.")
    from services import snapshots
    res = snapshots.save_snapshot(job_id, rid)
    if not res.get("saved"):
        reason = res.get("reason") or "nothing to back up"
        # "no data files" is a normal state for a bot that hasn't written
        # anything yet — say so plainly instead of returning a scary error.
        raise HTTPException(status_code=409, detail=f"No backup taken — {reason}.")
    return res


@router.post("/api/jobs/{job_id}/snapshot/restore")
def restore_job_snapshot(job_id: int, authorization: Optional[str] = Header(None)):
    """Force-restore the stored data over the live workspace, then restart.

    Destructive on purpose (overwrite=True) — this is the "my bot wiped its own
    database, put yesterday's copy back" button, so the caller means it.
    """
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=409, detail="Job is not deployed yet.")
    from services import snapshots
    if not snapshots.load_snapshot(job_id):
        raise HTTPException(status_code=404, detail="No backup stored for this job.")
    res = snapshots.restore_snapshot(job_id, rid, overwrite=True)
    if not res.get("restored"):
        raise HTTPException(status_code=502,
                            detail=f"Restore failed — {res.get('reason') or 'unknown error'}.")
    try:
        runner_client._runner_http("POST", f"/internal/jobs/{rid}/restart", worker=_worker_of(row))
    except Exception as exc:
        logger.warning("restart after restore failed (job %s): %s", job_id, exc)
    return res


@router.get("/api/jobs/{job_id}/download")
def download_job_workspace(job_id: int, authorization: Optional[str] = Header(None)):
    """Download the whole workspace (database + data files) as one .tar.gz.

    Serves the live workspace when the runner can reach it, and falls back to
    the last stored snapshot when it cannot — so a download still works after a
    deploy has wiped the container, which is exactly when a user panics and
    wants their data.
    """
    import base64 as _b64
    from fastapi.responses import Response as _Response
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", (row.get("name") or "job")).strip("-") or "job"

    b64 = None
    if rid:
        try:
            resp = runner_client._runner_http("GET", f"/internal/jobs/{rid}/snapshot", worker=_worker_of(row))
            if resp.status_code == 200:
                data = resp.json()
                if not data.get("empty"):
                    b64 = data.get("tarball_b64")
        except Exception as exc:
            logger.info("live workspace unavailable for download (job %s): %s", job_id, exc)
    if not b64:
        from services import snapshots
        snap = snapshots.load_snapshot(job_id)
        if snap:
            b64 = snap.get("tarball_b64")
    if not b64:
        raise HTTPException(status_code=404,
                            detail="No data files yet — this job hasn't written a database.")
    try:
        raw = _b64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=500, detail="Stored backup is corrupt.")
    return _Response(
        content=raw,
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{safe}-data.tar.gz"'},
    )


@router.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: int, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if rid:
        # Snapshot while the files are still there. A stopped job is the most
        # likely one to be sitting idle when the next deploy wipes the disk.
        try:
            from services import snapshots
            snapshots.save_snapshot(job_id, rid)
        except Exception as exc:
            logger.warning("pre-stop snapshot failed for job %s: %s", job_id, exc)
        resp = runner_client._runner_http("POST", f"/internal/jobs/{rid}/stop", worker=_worker_of(row))
        if resp.status_code not in (200, 404):
            raise HTTPException(status_code=502, detail="Runner refused to stop the job.")
    return {"status": "stopped"}


@router.post("/api/jobs/{job_id}/restart")
def restart_job(job_id: int, request: Request, authorization: Optional[str] = Header(None)):
    """Restart a job — IN-PLACE when the runner still knows about it (preserves
    workspace / database.db / session files). Cold-start (fresh worker slot)
    only as a fallback after a full runner restart."""
    user, _ = get_current_user_and_session(authorization)
    rate_limit_user(user["id"], "exec")
    row = _get_own_job(job_id, user)

    rid = row.get("runner_job_id")
    info = None

    if rid:
        # Fast path: in-place restart on the SAME job id/dir/port/slug.
        # This is what keeps referral-bot databases alive across restarts.
        resp = runner_client._runner_http("POST", f"/internal/jobs/{rid}/restart", worker=_worker_of(row))
        if resp.status_code == 200:
            info = resp.json()

    if info is None:
        # Cold-start fallback: the runner was rebuilt (a deploy) and lost both
        # its in-memory record AND — on the free tier — the workspace itself.
        # This is THE moment a referral bot used to lose its database.db, so we
        # create the job, restore the last snapshot into the fresh empty dir,
        # and only then let it run.
        resp = runner_client._runner_http("POST", "/internal/jobs", {
            "language": row["language"], "code": row["code"],
            "name": f"u{user['id']}-{row['name']}",
            # Replay saved env, otherwise a cold restart silently loses the
            # job's API keys / bot tokens and it crash-loops.
            "env": _row_env(row),
        })
        if resp.status_code == 201:
            info = resp.json()
        else:
            try:
                detail = resp.json().get("detail", "Runner rejected the job.")
            except Exception:
                detail = "Runner rejected the job."
            raise HTTPException(status_code=502, detail=detail)
        conn = get_db_connection()
        try:
            conn.execute(
                "UPDATE jobs SET runner_job_id = ?, worker_url = ?, updated_at = ? WHERE id = ?",
                (info["id"], getattr(resp, "placed_on", None), now_utc_str(), job_id),
            )
            conn.commit()
        finally:
            conn.close()
        _restore_then_restart(job_id, info, getattr(resp, "placed_on", None))

    info["job_db_id"] = job_id
    info.update(runner_client._job_web_fields(info, _worker_of(row)))
    return info


class JobAccessToggle(BaseModel):
    public: bool = True


@router.patch("/api/jobs/{job_id}")
def update_job(job_id: int, payload: JobUpdateRequest, request: Request, authorization: Optional[str] = Header(None)):
    """Edit + redeploy a job IN PLACE — preserves the runner job id, its
    /live/{slug}/ URL, reserved port, and most importantly the bot's
    persistent workspace (SQLite DBs, session files, referral counts, …).
    Use this for bug fixes / feature adds: users' data NEVER gets wiped."""
    user, _ = get_current_user_and_session(authorization)
    rate_limit_user(user["id"], "exec")
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=409, detail="Job has no runner id — press Restart once, then retry edit.")

    # Persist the new code/name/language in our DB FIRST (source of truth
    # for future restarts after a full runner redeploy).
    new_name = (payload.name or row["name"]).strip()[:60]
    new_lang = (payload.language or row["language"]).strip()
    new_code = payload.code if payload.code is not None else row["code"]
    new_repo = (payload.repo_url or "").strip()
    new_entry = (payload.entry or "").strip()
    # env omitted from the request => keep what is already saved.
    new_env = _clean_env_map(payload.env) if payload.env is not None else _row_env(row)
    now = now_utc_str()
    if new_name != (row["name"] or ""):
        conn0 = get_db_connection()
        try:
            dup = conn0.execute(
                "SELECT id FROM jobs WHERE user_id = ? AND id != ? AND LOWER(name) = LOWER(?)",
                (user["id"], job_id, new_name),
            ).fetchone()
            if dup:
                raise HTTPException(status_code=409, detail=f"You already have a job named \u201c{new_name}\u201d \u2014 choose a different name.")
        finally:
            conn0.close()
    conn = get_db_connection()
    try:
        conn.execute(
            "UPDATE jobs SET name = ?, language = ?, code = ?, env = ?, updated_at = ? WHERE id = ?",
            (new_name, new_lang, new_code,
             json.dumps(new_env) if new_env else None, now, job_id),
        )
        conn.commit()
    finally:
        conn.close()

    # Back the workspace up BEFORE touching the running job. An edit is the
    # most common moment to lose data (the runner may 404 below and force a
    # cold start into an empty dir), so this is the cheapest place to make the
    # data recoverable. Best-effort — a failed backup must not block the edit.
    try:
        from services import snapshots
        snapshots.save_snapshot(job_id, rid)
    except Exception as exc:
        logger.warning("pre-update snapshot failed for job %s: %s", job_id, exc)

    # Forward to runner for in-place update (same dir, same slug, same port).
    patch_body = {"name": new_name, "language": new_lang, "code": new_code, "env": new_env}
    if new_repo:
        patch_body["repo_url"] = new_repo
        if new_entry: patch_body["entry"] = new_entry
    resp = runner_client._runner_http("PATCH", f"/internal/jobs/{rid}", patch_body, worker=_worker_of(row))
    if resp.status_code == 200:
        info = resp.json()
    elif resp.status_code == 404:
        # Runner restarted — fall back to cold-start Restart path.
        create_body = {"language": new_lang, "code": new_code,
                       "name": f"u{user['id']}-{new_name}", "env": new_env}
        if new_repo:
            create_body["repo_url"] = new_repo
            if new_entry: create_body["entry"] = new_entry
        resp2 = runner_client._runner_http("POST", "/internal/jobs", create_body)
        if resp2.status_code != 201:
            try:
                detail = resp2.json().get("detail", "Runner rejected the job.")
            except Exception:
                detail = "Runner rejected the job."
            raise HTTPException(status_code=502, detail=detail)
        info = resp2.json()
        conn = get_db_connection()
        try:
            conn.execute("UPDATE jobs SET runner_job_id = ?, worker_url = ?, updated_at = ? WHERE id = ?",
                         (info["id"], getattr(resp2, "placed_on", None), now_utc_str(), job_id))
            conn.commit()
        finally:
            conn.close()
        # Same cold-start recovery as restart_job(): the new workspace is
        # empty, so replay the snapshot we just took (or an older one).
        info = _restore_then_restart(job_id, info, getattr(resp2, "placed_on", None))
    else:
        try:
            detail = resp.json().get("detail", "Runner rejected the update.")
        except Exception:
            detail = "Runner rejected the update."
        raise HTTPException(status_code=502, detail=detail)

    info["job_db_id"] = job_id
    info.update(runner_client._job_web_fields(info, _worker_of(row)))
    return info


@router.delete("/api/jobs/{job_id}")
def delete_job(job_id: int, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if rid:
        # Hard delete on the runner too — wipes the persistent workspace.
        try:
            runner_client._runner_http("DELETE", f"/internal/jobs/{rid}", worker=_worker_of(row))
        except HTTPException:
            pass
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.commit()
    finally:
        conn.close()
    return {"message": "Job deleted."}


@router.post("/api/jobs/{job_id}/access")
def toggle_job_access(job_id: int, payload: JobAccessToggle, authorization: Optional[str] = Header(None)):
    """Public ⇄ Private toggle for a job's live web URL."""
    user, _ = get_current_user_and_session(authorization)
    row = _get_own_job(job_id, user)
    rid = row.get("runner_job_id")
    if not rid:
        raise HTTPException(status_code=409, detail="Job is not up on the runner — press Restart first.")
    resp = runner_client._runner_http("POST", f"/internal/jobs/{rid}/access", {"public": payload.public}, worker=_worker_of(row))
    if resp.status_code == 404:
        raise HTTPException(status_code=409, detail="Runner restarted — press Restart to relaunch, then retry.")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Runner refused the access change.")
    info = resp.json()
    info.update(runner_client._job_web_fields(info, _worker_of(row)))
    info["job_db_id"] = job_id
    return info





# ================================
# USER PREFERENCES
# ================================

# ================================
# GITHUB IMPORT — fetch a single file or repo tree into editor
# ================================

_GH_RAW_HOSTS = ("raw.githubusercontent.com",)
_GH_WEB_RE = re.compile(
    r"^https?://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)"
    r"(?:/(?:blob|tree)/(?P<ref>[^/]+)/(?P<path>.+))?/?$"
)

_LANG_GUESS = {
    ".py": "python", ".js": "javascript", ".mjs": "javascript",
    ".ts": "javascript", ".sh": "bash", ".bash": "bash",
    ".zsh": "bash", ".rb": "ruby", ".php": "php",
    ".html": "htmlmixed", ".htm": "htmlmixed",
    ".css": "css", ".md": "markdown",
}


def _http_get_text(url: str, timeout: float = 12.0) -> tuple[int, str]:
    """Small blocking GET using stdlib — only called for raw.github content."""
    import urllib.request, urllib.error, ssl
    req = urllib.request.Request(url, headers={
        "User-Agent": "codenest-runspace/1.0",
        "Accept": "text/plain,application/vnd.github.raw+json,*/*",
    })
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8", errors="replace")
        except Exception: body = ""
        return e.code, body
    except Exception as e:
        return 0, str(e)


@router.post("/api/import/github")
def import_github(payload: GithubImportRequest, authorization: Optional[str] = Header(None)):
    """Fetch raw code from a GitHub URL (file or repo default-branch main file).
    Returns { name, language, code, source_url } for prefilling the editor.
    """
    user, _ = get_current_user_and_session(authorization)
    url = (payload.url or "").strip()
    if not url:
        raise HTTPException(422, "Paste a GitHub URL first.")
    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        raise HTTPException(422, "URL must start with https://")
    host = (u.hostname or "").lower()

    code = ""
    name = ""
    language = "python"
    source_url = url

    # Case 1: already a raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
    if host in _GH_RAW_HOSTS:
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 4:
            owner, repo, ref = parts[0], parts[1], parts[2]
            path = "/".join(parts[3:])
            status, body = _http_get_text(url)
            if status != 200:
                raise HTTPException(400, f"GitHub fetch failed ({status}). Is the repo/file public?")
            code = body
            fname = parts[-1]
            name = repo
            ext = "." + fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
            language = _LANG_GUESS.get(ext, "python")
        else:
            raise HTTPException(422, "Raw URL path looks off — give a full file link.")

    # Case 2: github.com web URL
    elif host == "github.com":
        m = _GH_WEB_RE.match(url.split("#")[0].split("?")[0])
        if not m:
            raise HTTPException(422, "That doesn't look like a GitHub file or repo URL.")
        owner = m.group("owner")
        repo  = m.group("repo")
        ref   = m.group("ref")
        path  = m.group("path")
        name = repo

        if not path:
            # Repo root — try to fetch README.md / main.py / app.py / index.js
            if not ref:
                # Detect default branch via GitHub API (best-effort)
                st, body = _http_get_text(f"https://api.github.com/repos/{owner}/{repo}", timeout=8)
                if st == 200:
                    try:
                        meta = json.loads(body)
                        ref = meta.get("default_branch") or "main"
                    except Exception:
                        ref = "main"
                else:
                    ref = "main"
            candidates = ["main.py", "app.py", "bot.py", "index.js", "server.js",
                          "index.php", "main.sh", "README.md"]
            fetched = None
            for cand in candidates:
                raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{cand}"
                st, body = _http_get_text(raw, timeout=8)
                if st == 200 and body.strip():
                    fetched = (cand, body, raw); break
            if not fetched:
                raise HTTPException(400, "No main.py/app.py/bot.py/index.js found in repo root. Link directly to a file instead.")
            fname, code, source_url = fetched
            ext = "." + fname.rsplit(".",1)[-1].lower()
            language = _LANG_GUESS.get(ext, "python")
        else:
            # Direct file URL like /owner/repo/blob/HEAD/main.py
            if not ref: ref = "main"
            raw = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}"
            st, body = _http_get_text(raw)
            if st != 200:
                raise HTTPException(400, f"Couldn't fetch file ({st}) — is the file public?")
            code = body
            source_url = raw
            fname = path.rsplit("/",1)[-1]
            ext = "." + fname.rsplit(".",1)[-1].lower() if "." in fname else ""
            language = _LANG_GUESS.get(ext, "python")
    else:
        raise HTTPException(422, "Only github.com URLs are supported for now.")

    # Cap at ~256KB to prevent dumping huge repos into the editor
    if len(code) > 256 * 1024:
        raise HTTPException(400, "File is too large (>256KB). Paste smaller files only.")

    # Slugify name slightly
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-") or "github-import"
    return {"name": name[:60], "language": language, "code": code, "source_url": source_url}
