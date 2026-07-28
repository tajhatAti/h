"""Client for the RunSpace runner (job execution + management) — TWO modes:

  • EMBEDDED (default): RUNNER_SERVICE_URL unset → the runner lives INSIDE
    this process (single Render web service). Calls go through an in-process
    ASGI client (fastapi.testclient.TestClient) — identical request/response
    semantics, zero network, zero second service.

  • REMOTE: RUNNER_SERVICE_URL set → classic server-to-server HTTPS calls to
    the separate runner service (kept for anyone running the two-service
    layout; the runner/ folder still ships standalone).

Runner URL/secret stay server-side; the browser never sees them. Test drivers
monkeypatch runner_client._runner_http — call it module-attr style.
"""
import os
import logging

import requests
from fastapi import HTTPException

logger = logging.getLogger("codenest-app")

# Per-ACCOUNT fairness limit, enforced by the main site. Distinct from the
# runner's MAX_BG_JOBS, which is a per-container RAM limit. Env-tunable so the
# ceiling can move with capacity without a code change.
MAX_JOBS_PER_USER = int(os.getenv("MAX_JOBS_PER_USER", "3"))


def runner_pool() -> list:
    """Every runner this site can place jobs on, in preference order.

    Capacity scales by ADDING SERVICES, not by raising a limit past the RAM a
    container actually has. Each Render free instance is 512MB and holds
    ~MAX_BG_JOBS bots; a second URL doubles the ceiling, a third triples it.

        RUNNER_SERVICE_URL   = https://runner-a.onrender.com
        RUNNER_SERVICE_URLS  = https://runner-b.onrender.com,https://runner-c...

    Both are read so existing single-runner deployments keep working
    untouched. Order is stable and duplicates are dropped, so a job lands on
    the first runner with room rather than bouncing between them.
    """
    urls = []
    primary = os.getenv("RUNNER_SERVICE_URL", "").strip().rstrip("/")
    if primary:
        urls.append(primary)
    for raw in os.getenv("RUNNER_SERVICE_URLS", "").replace(" ", ",").split(","):
        u = raw.strip().rstrip("/")
        if u and u not in urls:
            urls.append(u)
    return urls


def runner_cfg():
    """The PRIMARY runner (url, secret). Kept for callers that address one
    runner; placement across the pool goes through _runner_http."""
    pool = runner_pool()
    url = pool[0] if pool else ""
    secret = os.getenv("RUNNER_SERVICE_SECRET", "").strip()
    return url, secret


def embedded_mode() -> bool:
    """Single-service deployment → the runner runs in-process."""
    return not runner_pool()


def public_base_url() -> str:
    """Where /live/* is publicly reachable.
    Embedded → this main service. Remote → the runner service."""
    runner_url = os.getenv("RUNNER_SERVICE_URL", "").strip().rstrip("/")
    if runner_url:
        return runner_url
    base = (
        os.getenv("SITE_BASE_URL", "").strip()
        or os.getenv("PUBLIC_BASE_URL", "").strip()
        or os.getenv("RENDER_EXTERNAL_URL", "").strip()
    )
    if not base:  # local dev fallback
        base = "http://127.0.0.1:{}".format(os.getenv("PORT", "8000"))
    return base.rstrip("/")


_tc = None


def _embedded_client():
    """In-process ASGI client bound to the runner app. Created lazily so the
    app module itself can decide activation order (secret generation first)."""
    global _tc
    if _tc is None:
        from fastapi.testclient import TestClient
        import runner.app as rapp
        _tc = TestClient(rapp.app, raise_server_exceptions=False)
    return _tc


# ---------------------------------------------------------------------------
# WORKER REGISTRY  —  cached health, least-loaded placement
# ---------------------------------------------------------------------------
# Deliberately in memory, not a database table. The set of workers is CONFIG
# (an env var you edit in the Render dashboard), not user data; a table would
# add CRUD, an admin UI and a migration while answering the same question.
# The cache exists so job creation never waits on a health round-trip.
_HEALTH_TTL_S = int(os.getenv("WORKER_HEALTH_TTL_S", "45"))
_health_cache = {}          # url -> {"at": ts, "free": int, "load": float, "online": bool}


def _probe_worker(url: str) -> dict:
    """Ask one worker how loaded it is. Never raises."""
    try:
        r = requests.get(url + "/health", timeout=6)
        if r.status_code != 200:
            return {"online": False, "free": 0, "load": 1.0}
        d = r.json()
        return {
            "online": True,
            "free": int(d.get("free", 0)),
            "load": float(d.get("load", 1.0)),
            "jobs": int(d.get("jobs", 0)),
            "capacity": int(d.get("capacity", 0)),
            "mem_mb": float(d.get("mem_mb", 0.0)),
        }
    except Exception:
        # Offline, asleep, or too old to expose /health load fields.
        return {"online": False, "free": 0, "load": 1.0}


def worker_health(refresh: bool = False) -> dict:
    """Cached health for every worker in the pool."""
    import time
    now = time.time()
    out = {}
    for url in runner_pool():
        cached = _health_cache.get(url)
        if not refresh and cached and now - cached["at"] < _HEALTH_TTL_S:
            out[url] = cached
            continue
        info = _probe_worker(url)
        info["at"] = now
        _health_cache[url] = info
        out[url] = info
    return out


def _placement_order() -> list:
    """Workers to try for a NEW job, least-loaded first.

    Falls back to pool order when nothing has been probed yet, so a cold start
    still places jobs instead of refusing them.
    """
    pool = runner_pool()
    if len(pool) < 2:
        return pool
    health = worker_health()
    def key(u):
        h = health.get(u) or {}
        # Offline last; then most free slots; then pool order for stability.
        return (0 if h.get("online") else 1, -h.get("free", 0), pool.index(u))
    return sorted(pool, key=key)


def _runner_http(method: str, path: str, json_body=None, worker: str = None):
    """Call the runner (embedded or remote) with the shared secret; map every
    transport failure to a clean HTTPException the frontend can display."""
    if embedded_mode():
        secret = os.getenv("RUNNER_SERVICE_SECRET", "").strip()
        if not secret:
            raise HTTPException(status_code=503, detail="Runner is not configured.")
        try:
            return _embedded_client().request(
                method, path, json=json_body,
                headers={"Authorization": "Bearer " + secret},
                timeout=130,
            )
        except HTTPException:
            raise
        except Exception as exc:  # in-process — a failure here means the runner itself blew up
            logger.exception("embedded runner call failed: %s %s", method, path)
            raise HTTPException(status_code=503, detail=f"Job engine error — please try again. ({type(exc).__name__})")

    pool = runner_pool()
    runner_secret = os.getenv("RUNNER_SERVICE_SECRET", "").strip()
    if not pool or not runner_secret:
        raise HTTPException(status_code=503, detail="Jobs are not configured. Set RUNNER_SERVICE_URL and RUNNER_SERVICE_SECRET.")

    def _call(base):
        return requests.request(
            method, base + path,
            json=json_body,
            headers={"Authorization": "Bearer " + runner_secret},
            timeout=20,
        )

    # Creating a job is the only PLACEMENT decision — every other call targets
    # a job that already lives on ONE specific worker and must go there.
    #
    # BUG THIS FIXES: `targets = pool[:1]` sent every follow-up call to the
    # FIRST worker regardless of where the job actually ran. With one worker
    # that is harmless; with two, a restart for a job on worker-B hit worker-A,
    # got "job not found", and the site reported a healthy bot as dead.
    # Callers now pass worker= from the jobs table.
    creating = method.upper() == "POST" and path == "/internal/jobs"
    if creating:
        # Least-loaded first. Placement is the only decision that benefits from
        # health data, and it reads the CACHE — a create never blocks on a
        # round-trip to every worker.
        targets = _placement_order()
    elif worker:
        # Honour the recorded worker even if it has since been dropped from
        # the pool — the job is still there, and refusing to talk to it would
        # orphan a running bot.
        targets = [worker.rstrip("/")]
    else:
        # No recorded worker: a job created before this column existed. Those
        # all live on the primary.
        targets = pool[:1]

    last_exc = None
    last_full = None
    for i, base in enumerate(targets):
        try:
            resp = _call(base)
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_exc = exc
            continue                     # asleep or unreachable — try the next
        # 503 + X-Runner-Full means that container is at its RAM ceiling.
        # Roll to the next runner instead of telling the user the site is full.
        if creating and resp.status_code == 503 and resp.headers.get("X-Runner-Full"):
            last_full = resp
            logger.info("runner %s full, trying next of %d", base, len(targets))
            continue
        if creating and i:
            logger.info("job placed on overflow runner %s", base)
        if creating:
            # Stamp the winning worker onto the response so create_job() can
            # persist it. An attribute keeps requests.Response duck-typing
            # intact for every existing caller and test double.
            try:
                resp.placed_on = base
            except Exception:
                pass
        return resp

    if last_full is not None:
        return last_full                 # every runner full — report it honestly
    if isinstance(last_exc, requests.Timeout):
        raise HTTPException(status_code=504, detail="Waking up your RunSpace... this can take up to a minute on the free tier.")
    raise HTTPException(status_code=503, detail="Waking up your RunSpace... this can take up to a minute on the free tier.")


def _job_web_fields(info: dict, worker: str = None) -> dict:
    """Translate a runner job view into frontend web fields (public URL etc.).

    In embedded mode the /live gateway is served by THIS main service, so the
    public URL is <site-base>/live/{slug}/; in remote mode it is served by the
    worker the job actually runs on.

    BUG THIS FIXES: this used runner_cfg()[0], i.e. always the PRIMARY worker.
    A job placed on worker-B was handed worker-A's public URL, so its live page
    404'd even though the bot was running fine.
    """
    slug = (info or {}).get("web_slug")
    if embedded_mode():
        base = public_base_url()
    else:
        base = (worker or "").rstrip("/") or runner_cfg()[0]
    if not slug or not base:
        return {}
    out = {
        "web": bool(info.get("web")),
        "web_public": bool(info.get("web_public", True)),
        "web_url": f"{base}/live/{slug}/",
    }
    key = info.get("access_key")
    if not out["web_public"] and key:
        out["web_private_url"] = out["web_url"] + "?key=" + key
    return out
