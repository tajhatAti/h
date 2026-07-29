"""Admin console (owner-only, 404-stealth for everyone else) plus the
public abuse inbox. Destructive actions re-verify the admin's own 2FA."""
from typing import Optional, List

from fastapi import APIRouter, Header, HTTPException, Request

from routes.deps import *  # shared kernel (config, helpers, models)


from fastapi.responses import HTMLResponse

from services import runner_client
from services import limits
from services.runner_client import MAX_JOBS_PER_USER
from services.twofa import _verify_second_factor

# "Active now" window. Long enough that someone reading logs still counts,
# short enough that it means present rather than "visited today".
ACTIVE_WINDOW_MIN = int(os.getenv("ADMIN_ACTIVE_WINDOW_MIN", "15"))

# How stale a worker-health reading the console will accept. Below the 10s
# poll interval, so consecutive refreshes still show movement, but a burst of
# refreshes (or two admins looking at once) collapses into one probe.
ADMIN_HEALTH_MAX_AGE_S = float(os.getenv("ADMIN_HEALTH_MAX_AGE_S", "8"))

router = APIRouter()


def require_admin(authorization):
    """404 for everyone else — the console's existence stays private.

    404 for the UNAUTHENTICATED case too. Letting a missing token answer 401
    while a valid non-admin token answers 404 is itself a signal: it tells a
    stranger the route is real and merely gated. Every non-admin caller now
    gets the identical response an unknown URL would give.
    """
    try:
        user, session = get_current_user_and_session(authorization)
    except HTTPException:
        raise HTTPException(status_code=404, detail="Not found.")
    if not ("is_admin" in user.keys() and user["is_admin"]):
        raise HTTPException(status_code=404, detail="Not found.")
    return user, session


def _admin_audit(conn, admin_id: int, action: str, target: str = "", details: str = ""):
    conn.execute(
        "INSERT INTO admin_audit_log (admin_id, action, target, details, created_at) VALUES (?,?,?,?,?)",
        (admin_id, action, target, details, now_utc_str()),
    )


def _stop_user_jobs_best_effort(user_id: int):
    """On suspend: tell the runner to stop every job the account deployed."""
    try:
        conn = get_db_connection()
        try:
            rows = conn.execute(
                "SELECT runner_job_id FROM jobs WHERE user_id=? AND runner_job_id IS NOT NULL",
                (user_id,),
            ).fetchall()
            rids = [dict(r)["runner_job_id"] for r in rows if dict(r).get("runner_job_id")]
        finally:
            conn.close()
        for rid in rids:
            try:
                runner_client._runner_http("POST", f"/internal/jobs/{rid}/stop")
            except Exception:
                pass
    except Exception:
        pass


class AdminSuspend(BaseModel):
    user_id: int
    suspended: bool
    code: Optional[str] = None


class AbuseReportIn(BaseModel):
    url: str
    reason: Optional[str] = ""




@router.get("/admin/panel-html", include_in_schema=False)
def admin_panel_html(authorization: Optional[str] = Header(None)):
    """The console's MARKUP, behind the same 404 gate as its data.

    index.html no longer ships this section — it was readable in the page
    source by any anonymous visitor, which advertised the console's existence.
    The SPA fetches it here once it knows the session is an admin one, so a
    non-admin gets the same 404 they get for every other admin route.
    """
    require_admin(authorization)
    from fastapi.responses import HTMLResponse
    from pathlib import Path
    frag = Path(__file__).resolve().parent.parent / "templates" / "admin_panel.html"
    if not frag.exists():
        raise HTTPException(status_code=404, detail="Not found.")
    return HTMLResponse(frag.read_text(encoding="utf-8"),
                        headers={"Cache-Control": "no-store"})


@router.get("/admin/telegram-diagnostic")
def admin_telegram_diagnostic(authorization: Optional[str] = Header(None)):
    """Is the server holding the same bot the Mini App is opened from?

    A bad_hash means the HMAC did not match, and the server cannot tell a
    forged payload from a token belonging to a different bot. Every other
    check could only report the token's SHAPE. This asks Telegram directly
    with getMe, which is the only thing that proves whose token it is.

    Admin-gated: getMe is a network call, so leaving it public would let a
    stranger make this server hammer api.telegram.org.
    """
    require_admin(authorization)
    from services import miniapp_auth
    shape = miniapp_auth.token_shape()
    who = miniapp_auth.whoami()
    out = {"configured_bot_id": shape.get("bot_id"),
           "token_looks_valid": shape.get("looks_valid"),
           "telegram_says": who}
    if who.get("ok"):
        out["bot_username"] = who.get("username")
        out["open_this_bot"] = f"https://t.me/{who.get('username')}"
        out["next_step"] = (
            f"Open the Mini App from @{who.get('username')} — that is the bot "
            f"this server can verify. Opening it from any other bot gives "
            f"bad_hash.")
    else:
        out["next_step"] = (
            "Telegram did not accept TELEGRAM_PING_BOT_TOKEN. Copy it again "
            "from @BotFather for the bot whose Mini App you are opening.")
    # Also report what the site tells the browser, since a mismatch between
    # these two is its own bug: the login widget would point at one bot while
    # verification expects another.
    out["TELEGRAM_BOT_USERNAME_env"] = os.getenv("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@") or None
    if out.get("bot_username") and out["TELEGRAM_BOT_USERNAME_env"] \
            and out["bot_username"].lower() != out["TELEGRAM_BOT_USERNAME_env"].lower():
        out["warning"] = (
            f"TELEGRAM_BOT_USERNAME is @{out['TELEGRAM_BOT_USERNAME_env']} but "
            f"the token belongs to @{out['bot_username']}. These must be the "
            f"same bot.")
    return out


@router.get("/admin/overview")
def admin_overview_route(authorization: Optional[str] = Header(None)):
    require_admin(authorization)
    conn = get_db_connection()
    try:
        users = dict(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone())["c"]
        suspended = dict(conn.execute("SELECT COUNT(*) AS c FROM users WHERE is_suspended=1").fetchone())["c"]
        verified = dict(conn.execute("SELECT COUNT(*) AS c FROM users WHERE is_verified=1").fetchone())["c"]
        jobs_total = dict(conn.execute("SELECT COUNT(*) AS c FROM jobs").fetchone())["c"]
        deployed = dict(conn.execute("SELECT COUNT(*) AS c FROM jobs WHERE runner_job_id IS NOT NULL").fetchone())["c"]
        threshold = (now_utc() - timedelta(days=13)).strftime("%Y-%m-%d")
        rows = conn.execute(
            "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS c "
            "FROM users WHERE created_at >= ? GROUP BY day ORDER BY day",
            (threshold,),
        ).fetchall()
        series = [{"day": dict(r)["day"], "count": dict(r)["c"]} for r in rows]
        # Signups over rolling windows. Computed in SQL rather than by walking
        # the daily series, which only covers 13 days and would silently
        # under-report the 30-day figure.
        def _since(days):
            cutoff = (now_utc() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
            r = conn.execute(
                "SELECT COUNT(*) AS c FROM users WHERE created_at >= ?", (cutoff,)
            ).fetchone()
            return dict(r)["c"]

        # Users seen recently. sessions.last_seen is refreshed on authenticated
        # requests, so this is "who is actually using the platform", not "who
        # ever registered".
        active_cut = (now_utc() - timedelta(minutes=ACTIVE_WINDOW_MIN)).strftime("%Y-%m-%d %H:%M:%S")
        active_users = dict(conn.execute(
            "SELECT COUNT(DISTINCT user_id) AS c FROM sessions WHERE last_seen >= ?",
            (active_cut,),
        ).fetchone())["c"]

        # Telegram reach. The bot is a second front door onto the same
        # platform, so "how many accounts can drive it" belongs next to the
        # user count rather than buried in a per-user view.
        tg_linked = dict(conn.execute(
            "SELECT COUNT(*) AS c FROM users WHERE telegram_id IS NOT NULL"
        ).fetchone())["c"]

        out = {
            "users": users, "suspended": suspended, "verified": verified,
            "jobs_total": jobs_total, "jobs_deployed": deployed,
            "jobs_max_per_user": MAX_JOBS_PER_USER,
            "capacity_max": users * MAX_JOBS_PER_USER,
            "signups_daily": series,
            "signups_24h": _since(1),
            "signups_7d": _since(7),
            "signups_30d": _since(30),
            "active_users": active_users,
            "active_window_min": ACTIVE_WINDOW_MIN,
            "telegram_linked": tg_linked,
        }
    finally:
        conn.close()
    # Fleet capacity, reported as MEMORY rather than slots. A slot count was
    # misleading: 20 idle bots and 3 heavy ones can occupy the same RAM, so the
    # number that predicts whether the next job fits is megabytes, not jobs.
    workers = []
    used_mb = safe_mb = total_mb = 0.0
    running_total = 0
    try:
        # A few seconds of staleness, not a forced re-probe of every worker on
        # every 10s poll.
        health = runner_client.worker_health(max_age_s=ADMIN_HEALTH_MAX_AGE_S) or {}
        for url, h in health.items():
            workers.append({
                "url": url,
                "online": bool(h.get("online")),
                "jobs": h.get("jobs", 0),
                "mem_mb": h.get("mem_mb", 0.0),
                "safe_mb": h.get("safe_mb", 0),
                "total_mb": h.get("total_mb", 0),
                "full": bool(h.get("full")),
            })
            if h.get("online"):
                used_mb += float(h.get("mem_mb") or 0)
                safe_mb += float(h.get("safe_mb") or 0)
                total_mb += float(h.get("total_mb") or 0)
                running_total += int(h.get("jobs") or 0)
    except Exception:
        pass
    if not workers:
        # Embedded single-service mode: no pool to poll, so ask the in-process
        # runner directly.
        try:
            r = runner_client._runner_http("GET", "/health")
            h = r.json() if r is not None else {}
            used_mb = float(h.get("mem_mb") or 0)
            safe_mb = float(h.get("safe_mb") or 0)
            total_mb = float(h.get("total_mb") or 0)
            running_total = int(h.get("jobs") or 0)
            workers.append({"url": "embedded", "online": True,
                            "jobs": running_total, "mem_mb": used_mb,
                            "safe_mb": safe_mb, "total_mb": total_mb,
                            "full": bool(h.get("full"))})
        except Exception:
            pass
    # Live status breakdown. The DB knows a job EXISTS; only the runner knows
    # whether it is running, and a count of rows would call a crashed bot
    # "deployed".
    try:
        jl = list(runner_client.fleet_jobs().values())
        by = {}
        for j in jl:
            by[j.get("status") or "unknown"] = by.get(j.get("status") or "unknown", 0) + 1
        out["jobs_by_status"] = by
        out["jobs_running"] = by.get("running", 0)
    except Exception:
        pass

    if safe_mb:
        out["mem_used_mb"] = round(used_mb, 1)
        out["mem_safe_mb"] = round(safe_mb)
        out["mem_total_mb"] = round(total_mb)
        out["mem_pct"] = round(min(used_mb / safe_mb, 1.0) * 100)
        out["runner_running"] = running_total
        out["workers"] = workers
        out["workers_online"] = sum(1 for w in workers if w["online"])
    return out


@router.get("/admin/users")
def admin_users_route(authorization: Optional[str] = Header(None)):
    require_admin(authorization)
    conn = get_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.email, u.is_verified, u.is_suspended, u.is_admin,
                   u.created_at, u.telegram_id, u.telegram_name,
                   (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id) AS job_count
            FROM users u ORDER BY u.id DESC LIMIT 200
            """
        ).fetchall()
        return {"users": [dict(r) for r in rows]}
    finally:
        conn.close()


@router.get("/admin/users/{user_id}")
def admin_user_detail_route(user_id: int, authorization: Optional[str] = Header(None)):
    """One account in full: profile, jobs, sessions, security events."""
    require_admin(authorization)
    conn = get_db_connection()
    try:
        u = conn.execute(
            "SELECT id, username, email, is_verified, is_suspended, is_admin, "
            "       created_at, updated_at, telegram_id, telegram_name, "
            "       fingerprint, last_ip "
            "FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not u:
            raise HTTPException(status_code=404, detail="Not found.")
        user = dict(u)
        # How they signed up. Inferred from which credential exists, since no
        # explicit auth_method column was ever recorded.
        user["auth_method"] = "telegram" if user.get("telegram_id") else "email"
        user["auth_method_inferred"] = True

        jobs = [dict(r) for r in conn.execute(
            "SELECT id, name, language, runner_job_id, worker_url, created_at, updated_at "
            "FROM jobs WHERE user_id = ? ORDER BY id DESC", (user_id,)
        ).fetchall()]

        # Login history. IP + fingerprint are exactly what makes duplicate
        # accounts visible, which is the point of this view.
        sessions = [dict(r) for r in conn.execute(
            "SELECT id, ip_address, device_info, fingerprint, created_at, last_seen, expires_at "
            "FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 50", (user_id,)
        ).fetchall()]

        events = []
        try:
            events = [dict(r) for r in conn.execute(
                "SELECT action, details, ip_address, created_at FROM activity_log "
                "WHERE user_id = ? ORDER BY id DESC LIMIT 50", (user_id,)
            ).fetchall()]
        except Exception:
            pass
    finally:
        conn.close()

    # Live resource usage for this user's jobs.
    live = runner_client.fleet_jobs()
    total_mem = 0.0
    for j in jobs:
        info = live.get(j.get("runner_job_id")) or {}
        j["live_status"] = info.get("status")
        j["mem_mb"] = info.get("mem_mb")
        j["peak_mem_mb"] = info.get("peak_mem_mb")
        j["uptime_s"] = info.get("uptime_s")
        j["libs"] = info.get("libs") or []
        total_mem += float(info.get("mem_mb") or 0)

    # Distinct devices and networks this account has logged in from. The raw
    # session list already carried these, but a 50-row table does not answer
    # "is this one person or a farm" — a count does.
    fps = {(sdict.get("fingerprint") or "").strip()
           for sdict in sessions if (sdict.get("fingerprint") or "").strip()}
    ips = {(sdict.get("ip_address") or "").strip()
           for sdict in sessions if (sdict.get("ip_address") or "").strip()}

    # OTHER accounts reachable from the same device or network. This is the
    # whole point of a per-user view on a free host: one person with six
    # accounts is invisible in a user list and obvious here.
    siblings = []
    try:
        conn = get_db_connection()
        try:
            ids = limits.cluster_user_ids(
                conn,
                fingerprint=(user.get("fingerprint") or ""),
                ip=(user.get("last_ip") or ""),
            )
            ids.discard(user_id)
            for other in sorted(ids)[:20]:
                r = conn.execute(
                    "SELECT id, username, email, is_suspended, created_at FROM users WHERE id = ?",
                    (other,),
                ).fetchone()
                if r:
                    siblings.append(dict(r))
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("admin user detail: cluster lookup failed for %s (%s)", user_id, exc)

    return {
        "user": user,
        "jobs": jobs,
        "jobs_running": sum(1 for j in jobs if j.get("live_status") == "running"),
        "mem_used_mb": round(total_mem, 1),
        "sessions": sessions,
        "devices": len(fps),
        "networks": len(ips),
        "events": events,
        "linked_accounts": siblings,
        # Shared IP is weak evidence on its own — a household, an office and a
        # mobile carrier all look like this. Said here so the console can
        # phrase it as a prompt to look rather than as a verdict.
        "linked_note": "Same device fingerprint or IP. Shared networks are common; this is a prompt to look, not proof.",
    }


@router.get("/admin/jobs")
def admin_jobs_route(authorization: Optional[str] = Header(None)):
    """Job METADATA only (+ live status/uptime from the runner, best-effort) —
    never the code. Privacy stays intact."""
    require_admin(authorization)
    conn = get_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT j.id, j.name, j.language, j.created_at, j.runner_job_id,
                   j.worker_url, j.user_id,
                   u.username AS owner, u.telegram_id AS owner_telegram,
                   u.telegram_name AS owner_telegram_name,
                   u.is_suspended AS owner_suspended
            FROM jobs j JOIN users u ON u.id = j.user_id
            ORDER BY j.id DESC LIMIT 300
            """
        ).fetchall()
        jobs = [dict(r) for r in rows]
    finally:
        conn.close()
    # Enrich with the runner's live view (status/uptime). Best-effort: if the
    # runner is asleep or unreachable the metadata list still answers.
    live = runner_client.fleet_jobs()
    for row in jobs:
        info = live.get(row.get("runner_job_id")) or {}
        row["live_status"] = info.get("status")
        row["uptime_s"] = info.get("uptime_s")
        row["web_slug"] = info.get("web_slug")
        # Resource picture. mem_mb is now; peak_mem_mb is the high-water mark
        # for this run, which is what explains an OOM after the process has
        # already shrunk back or died.
        row["mem_mb"] = info.get("mem_mb")
        row["peak_mem_mb"] = info.get("peak_mem_mb")
        row["cpu_pct"] = info.get("cpu_pct")
        row["restarts"] = info.get("restarts")
        row["last_exit_reason"] = info.get("last_exit_reason")
        row["libs"] = info.get("libs") or []
        # Which physical worker. NULL means it predates multi-worker routing
        # and therefore lives on the primary.
        row["worker"] = row.get("worker_url") or "primary"
        # Website vs Telegram bot. There is no source column, so this is
        # INFERRED from whether the account was created through Telegram —
        # labelled as an inference rather than presented as recorded fact.
        # Whether the OWNER has Telegram connected. Still an inference about
        # where the app came from — there is no source column — but now it can
        # also name the account, which is what makes it actionable.
        row["source"] = "telegram" if row.get("owner_telegram") else "website"
        row["source_inferred"] = True
        row["owner_telegram_name"] = row.get("owner_telegram_name")
        row.pop("owner_telegram", None)
    return {"jobs": jobs}


@router.get("/admin/jobs/{job_id}")
def admin_job_detail_route(job_id: int, authorization: Optional[str] = Header(None)):
    """One app, in full — everything that explains why it is behaving that way.

    The list view answers "what exists"; this answers "what is wrong with it".
    That means the resource picture (now AND peak), the restart history, the
    reason it last died, its packages, which physical worker holds it, and its
    recent log.

    LOGS ARE INCLUDED DELIBERATELY. The platform owner has said privacy is not
    a concern here, and a monitoring console that cannot read the traceback of
    a crashing job is decoration. The SOURCE CODE is still not returned — the
    log is the job's own output, the code is the user's work.
    """
    require_admin(authorization)
    conn = get_db_connection()
    try:
        row = conn.execute(
            """
            SELECT j.id, j.name, j.language, j.created_at, j.updated_at,
                   j.runner_job_id, j.worker_url, j.user_id,
                   u.username AS owner, u.email AS owner_email,
                   u.telegram_id AS owner_telegram,
                   u.telegram_name AS owner_telegram_name,
                   u.is_suspended AS owner_suspended
            FROM jobs j JOIN users u ON u.id = j.user_id
            WHERE j.id = ?
            """,
            (job_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found.")
        job = dict(row)
        # How many OTHER apps this owner runs — the context that turns "one
        # heavy job" into "this account is the load".
        job["owner_job_count"] = dict(conn.execute(
            "SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?", (job["user_id"],)
        ).fetchone())["c"]
    finally:
        conn.close()

    job["source"] = "telegram" if job.get("owner_telegram") else "website"
    job["source_inferred"] = True
    job.pop("owner_telegram", None)
    worker = job.get("worker_url") or None
    job["worker"] = worker or "primary"

    # Ask the worker that actually holds this job. Going to pool[0] would
    # report a perfectly healthy app on an overflow worker as missing.
    live, logs, reachable = {}, "", False
    try:
        rid = job.get("runner_job_id")
        if rid:
            resp = runner_client._runner_http(
                "GET", f"/internal/jobs/{rid}", worker=worker)
            if resp is not None and resp.status_code == 200:
                live = resp.json() or {}
                reachable = True
            elif resp is not None and resp.status_code == 404:
                # The worker answered and does not know it: genuinely gone,
                # as opposed to unreachable.
                reachable = True
    except Exception as exc:
        logger.warning("admin job detail: runner unreachable for %s (%s)", job_id, exc)

    logs = live.pop("logs", "") or ""
    for k in ("status", "uptime_s", "restarts", "mem_mb", "peak_mem_mb",
              "cpu_pct", "port", "web", "web_slug", "web_public",
              "last_exit_reason", "started_at"):
        job[k] = live.get(k)
    job["libs"] = live.get("libs") or []
    # Env VALUES hold bot tokens. Only the key names are ever returned, and
    # this is the one place the distinction matters enough to name it.
    job["env_keys"] = live.get("env_keys") or []
    # "offline" is a claim about the job; "unknown" is an admission about us.
    # Reporting an unreachable worker's job as stopped is how a monitoring
    # panel manufactures a false alarm.
    if not reachable:
        job["status"] = "unknown"
        job["status_stale"] = True
    elif not job.get("status"):
        job["status"] = "offline" if job.get("runner_job_id") else "stopped"

    return {
        "job": job,
        # Tail, not the whole ring buffer: the last screenful is what explains
        # a crash, and the full history would dominate the response.
        "logs": "\n".join(logs.splitlines()[-200:]),
        "log_truncated": len(logs.splitlines()) > 200,
        "runner_reachable": reachable,
    }


@router.get("/admin/libraries")
def admin_libraries_route(authorization: Optional[str] = Header(None)):
    """Every package installed across every job, by frequency.

    Answers "which jobs pulled in opencv-python?" without grepping logs, and
    surfaces heavy or odd dependencies for a look. The HEAVY list is a prompt
    for human review, not an accusation — plenty of legitimate bots use numpy.
    """
    require_admin(authorization)

    # Frameworks that dominate a 512MB box, plus categories worth a glance on a
    # free bot host. Matched on the package name only.
    HEAVY = {
        "tensorflow", "torch", "pytorch", "jax", "keras", "transformers",
        "opencv-python", "opencv-contrib-python", "scipy", "pandas", "numpy",
        "scikit-learn", "sklearn", "matplotlib", "playwright", "selenium",
    }
    WATCH = {
        # Mining / hashing adjacent, and remote-control tooling. Presence is
        # not proof of anything; it is a reason to read the job.
        "pycryptodome", "ecdsa", "web3", "eth-account", "bitcoinlib",
        "paramiko", "pyngrok", "requests-html",
    }

    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT j.id, j.name, j.runner_job_id, u.username AS owner "
            "FROM jobs j JOIN users u ON u.id = j.user_id"
        ).fetchall()
        meta = {dict(r)["runner_job_id"]: dict(r) for r in rows if dict(r)["runner_job_id"]}
    finally:
        conn.close()

    live = runner_client.fleet_jobs()

    counts = {}
    for rid, j in live.items():
        m = meta.get(rid) or {}
        # RAM held by the jobs that imported this package. A count answers
        # "how popular", which is trivia on a 512MB box; the question that
        # actually decides anything is "what is eating the memory".
        # ATTRIBUTED, NOT CAUSED: a job importing both numpy and requests adds
        # its full RSS to both, so the column does not sum to the platform
        # total and must never be presented as if it did.
        mem = float(j.get("mem_mb") or 0.0)
        for lib in (j.get("libs") or []):
            e = counts.setdefault(lib, {"library": lib, "count": 0,
                                        "mem_mb": 0.0, "jobs": []})
            e["count"] += 1
            e["mem_mb"] += mem
            e["jobs"].append({
                "job_id": m.get("id"),
                "name": m.get("name") or j.get("name"),
                "owner": m.get("owner"),
                "mem_mb": round(mem, 1),
                "status": j.get("status"),
            })

    # Sorted by MEMORY, not by count: the top of this list should be the thing
    # worth looking at, and a package in 6 tiny bots is not that.
    out = sorted(counts.values(), key=lambda e: (-e["mem_mb"], -e["count"], e["library"]))
    for e in out:
        name = e["library"].lower()
        e["heavy"] = name in HEAVY
        e["watch"] = name in WATCH
        e["mem_mb"] = round(e["mem_mb"], 1)
        e["jobs"].sort(key=lambda x: -(x["mem_mb"] or 0))
    total_jobs = len(live) or 1
    for e in out:
        e["pct_of_jobs"] = round(e["count"] / total_jobs * 100)
    return {
        "libraries": out,
        "jobs_sampled": len(live),
        # Named so the UI cannot accidentally present attributed memory as a
        # breakdown that adds up.
        "mem_attributed": True,
        # Stated plainly: only RUNNING jobs report their packages, because the
        # list lives on the runner's in-memory record. A stopped job's
        # libraries are not known, and pretending otherwise would make the
        # percentages quietly wrong.
        "note": "Counts cover jobs currently known to the runner.",
    }


@router.post("/admin/users/set-suspended")
def admin_set_suspended(payload: AdminSuspend, authorization: Optional[str] = Header(None)):
    admin, _ = require_admin(authorization)
    if payload.user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot suspend your own account.")
    conn = get_db_connection()
    try:
        # Destructive actions demand the admin's own second factor, every time.
        row = conn.execute("SELECT is_enabled FROM user_2fa WHERE user_id=?", (admin["id"],)).fetchone()
        if not row or not row["is_enabled"]:
            raise HTTPException(
                status_code=409,
                detail="Enable 2FA on your admin account first — destructive actions require it.")
        _verify_second_factor(conn, admin["id"], payload.code or "")
        target = conn.execute("SELECT id, username FROM users WHERE id=?", (payload.user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found.")
        conn.execute(
            "UPDATE users SET is_suspended=?, updated_at=? WHERE id=?",
            (1 if payload.suspended else 0, now_utc_str(), payload.user_id),
        )
        if payload.suspended:
            conn.execute("DELETE FROM sessions WHERE user_id=?", (payload.user_id,))
        _admin_audit(conn, admin["id"], "suspend" if payload.suspended else "reactivate", target["username"], "")
        conn.commit()
    finally:
        conn.close()
    if payload.suspended:
        _stop_user_jobs_best_effort(payload.user_id)
    return {"message": ("Account suspended. Their sessions are closed and jobs are stopping."
                        if payload.suspended else "Account reactivated.")}


@router.get("/admin/audit-log")
def admin_audit_route(authorization: Optional[str] = Header(None)):
    require_admin(authorization)
    conn = get_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT a.id, a.action, a.target, a.details, a.created_at, u.username AS admin_name
            FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id
            ORDER BY a.id DESC LIMIT 100
            """
        ).fetchall()
        return {"audit": [dict(r) for r in rows]}
    finally:
        conn.close()


@router.get("/admin/abuse-reports")
def admin_abuse_route(authorization: Optional[str] = Header(None)):
    require_admin(authorization)
    conn = get_db_connection()
    try:
        rows = conn.execute(
            "SELECT id, url, reason, ip, status, created_at FROM abuse_reports ORDER BY id DESC LIMIT 100"
        ).fetchall()
        return {"reports": [dict(r) for r in rows]}
    finally:
        conn.close()


# ---- public abuse inbox ----


# ---- public abuse inbox ----
@router.get("/report-abuse", include_in_schema=False)
def report_abuse_page():
    html = """<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report abuse · CodeNest</title>
<style>
body{margin:0;font-family:Inter,system-ui,sans-serif;background:#0B0C14;color:#F5F5FA;display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box}
.card{max-width:460px;width:100%;background:#14152a;border:1px solid #262852;border-radius:18px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{color:#A0A0B2;font-size:13.5px;line-height:1.6;margin:0 0 16px}
input,textarea{width:100%;box-sizing:border-box;background:#0B0C14;border:1px solid #262852;color:#F5F5FA;border-radius:10px;padding:11px 13px;font-size:14px;margin-bottom:10px;font-family:inherit}
textarea{min-height:90px;resize:vertical}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#7C6CF6;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#msg{margin-top:12px;font-size:13.5px;text-align:center;min-height:18px}
.ok{color:#2FD9C4}.err{color:#ff7b7b}
</style></head><body><div class="card">
<h1>Report abuse</h1>
<p>Saw a live page hosted on RunSpace doing something shady — phishing, spam, malware, crypto-mining? Tell us. The site owner reviews every report and can suspend the account.</p>
<input id="url" placeholder="https://… (the page or job URL)">
<textarea id="reason" placeholder="What's wrong with it? (optional, but helps)"></textarea>
<button id="btn">Send report</button>
<div id="msg"></div>
</div>
<script>
const urlInp = document.getElementById("url");
const q = new URLSearchParams(location.search).get("url");
if (q) urlInp.value = q;
document.getElementById("btn").addEventListener("click", async () => {
  const btn = document.getElementById("btn"), msg = document.getElementById("msg");
  if (!urlInp.value.trim()) { msg.className = "err"; msg.textContent = "Paste the URL first."; return; }
  btn.disabled = true; btn.textContent = "Sending…"; msg.textContent = "";
  try {
    const r = await fetch("/report-abuse", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlInp.value.trim(), reason: document.getElementById("reason").value }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { msg.className = "ok"; msg.textContent = "Thanks — the report reached the site owner."; btn.textContent = "Sent ✓"; }
    else { msg.className = "err"; msg.textContent = j.detail || "Could not send. Try again."; btn.disabled = false; btn.textContent = "Send report"; }
  } catch (e) { msg.className = "err"; msg.textContent = "Network error — try again."; btn.disabled = false; btn.textContent = "Send report"; }
});
</script></body></html>"""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(html)


@router.post("/report-abuse")
def report_abuse_submit(payload: AbuseReportIn, request: Request):
    rate_limit_custom(
        f"{client_ip(request)}:abuse", 3600, 5,
        "Too many reports from this network. Try again later.")
    url = (payload.url or "").strip()
    if not url or len(url) > 500:
        raise HTTPException(status_code=400, detail="A valid page URL is required.")
    reason = (payload.reason or "").strip()[:800]
    conn = get_db_connection()
    try:
        conn.execute(
            "INSERT INTO abuse_reports (url, reason, ip, created_at) VALUES (?,?,?,?)",
            (url, reason, client_ip(request), now_utc_str()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"message": "Thanks — the report reached the site owner."}


# ================================
# GLOBAL SEARCH (snippets + RunSpace apps)
# ================================

@router.get("/admin/fingerprint-clusters")
def get_fingerprint_clusters(authorization: Optional[str] = Header(None)):
    """Accounts grouped by device fingerprint, with live job counts (§6).

    Sorted by cluster size so the largest — most suspicious — device clusters
    surface first. Uses require_admin() for 404-stealth like every other admin
    route, and avoids GROUP_CONCAT (SQLite-only) so it also runs on Postgres.
    """
    require_admin(authorization)

    conn = get_db_connection()
    try:
        live = limits.running_runner_ids()
        rows = conn.execute(
            "SELECT id, username, email, fingerprint, last_ip, created_at, "
            "       COALESCE(is_suspended, 0) AS is_suspended "
            "FROM users WHERE fingerprint IS NOT NULL AND fingerprint != '' "
            "ORDER BY id"
        ).fetchall()

        bursts = signup_burst_counts()
        by_fp = {}
        for r in rows:
            r = dict(r)
            by_fp.setdefault(r["fingerprint"], []).append(r)

        clusters = []
        for fp, members in by_fp.items():
            uids = {m["id"] for m in members}
            clusters.append({
                "fingerprint": fp[:16] + "…",
                "fingerprint_full": fp,
                "account_count": len(members),
                "running_jobs": limits.count_running_for_users(conn, uids, live),
                "job_limit": limits.FINGERPRINT_JOB_LIMIT,
                "over_limit": limits.count_running_for_users(conn, uids, live) > limits.FINGERPRINT_JOB_LIMIT,
                "signup_burst": bursts.get(fp, 0) >= SIGNUP_BURST_MAX,
                "recent_signups": bursts.get(fp, 0),
                "accounts": [
                    {"id": m["id"], "username": m["username"], "email": m["email"],
                     "last_ip": m["last_ip"], "created_at": m["created_at"],
                     "is_suspended": bool(m["is_suspended"])}
                    for m in members[:25]
                ],
            })
        clusters.sort(key=lambda c: (c["account_count"], c["running_jobs"]), reverse=True)
        return {
            "clusters": clusters,
            "total": len(clusters),
            "shared_only": [c for c in clusters if c["account_count"] > 1],
        }
    finally:
        conn.close()


@router.get("/admin/ip-clusters")
def get_ip_clusters(authorization: Optional[str] = Header(None)):
    """Accounts grouped by IP address, with live job counts (§6)."""
    require_admin(authorization)

    conn = get_db_connection()
    try:
        live = limits.running_runner_ids()
        rows = conn.execute(
            "SELECT id, username, email, last_ip, fingerprint, created_at, "
            "       COALESCE(is_suspended, 0) AS is_suspended "
            "FROM users WHERE last_ip IS NOT NULL AND last_ip != '' "
            "ORDER BY id"
        ).fetchall()

        by_ip = {}
        for r in rows:
            r = dict(r)
            by_ip.setdefault(r["last_ip"], []).append(r)

        clusters = []
        for ip, members in by_ip.items():
            uids = {m["id"] for m in members}
            running = limits.count_running_for_users(conn, uids, live)
            clusters.append({
                "ip": ip,
                "account_count": len(members),
                "device_count": len({m["fingerprint"] for m in members if m["fingerprint"]}),
                "running_jobs": running,
                "job_limit": limits.IP_JOB_LIMIT,
                "over_limit": running > limits.IP_JOB_LIMIT,
                "accounts": [
                    {"id": m["id"], "username": m["username"], "email": m["email"],
                     "created_at": m["created_at"], "is_suspended": bool(m["is_suspended"])}
                    for m in members[:25]
                ],
            })
        clusters.sort(key=lambda c: (c["account_count"], c["running_jobs"]), reverse=True)
        return {"clusters": clusters, "total": len(clusters)}
    finally:
        conn.close()


@router.get("/admin/signup-flags")
def get_signup_flags(authorization: Optional[str] = Header(None)):
    """Devices showing rapid-signup-burst patterns (§5 — flagged, never auto-blocked)."""
    require_admin(authorization)

    counts = signup_burst_counts()
    conn = get_db_connection()
    try:
        flags = []
        for fp, n in sorted(counts.items(), key=lambda kv: kv[1], reverse=True):
            if n < SIGNUP_BURST_MAX:
                continue
            rows = conn.execute(
                "SELECT id, username, email, created_at FROM users WHERE fingerprint = ? ORDER BY id DESC LIMIT 25",
                (fp,),
            ).fetchall()
            flags.append({
                "fingerprint": fp[:16] + "…",
                "fingerprint_full": fp,
                "signups_in_window": n,
                "window_seconds": SIGNUP_BURST_WINDOW_S,
                "threshold": SIGNUP_BURST_MAX,
                "accounts": [dict(r) for r in rows],
            })
        return {
            "flags": flags,
            "total": len(flags),
            "note": "Flagged for review only — no account is auto-blocked.",
        }
    finally:
        conn.close()
