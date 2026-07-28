"""Multi-worker routing: jobs must stay on the worker that runs them.

THE BUG THIS EXISTS FOR
services/runner_client.py placed a new job on any worker in the pool, but sent
every FOLLOW-UP call to pool[:1] — always the first one. Reproduced before the
fix:

    job created on   : https://worker-b.test/internal/jobs
    restart sent to  : https://worker-a.test/internal/jobs/job99/restart

worker-A answers "job not found", so the site reports a perfectly healthy bot
as dead, and Stop/Delete silently do nothing. Harmless with one worker in the
pool; guaranteed the moment a second is added.

The same mistake existed in _job_web_fields(), which built every public
/live/{slug}/ URL from runner_cfg()[0] — the PRIMARY worker — so a job on
worker-B advertised a URL that 404s.

Run:  DATA_DIR=$(mktemp -d) python3 tests/test_multi_worker.py
"""
import importlib
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("RUNNER_SERVICE_SECRET", "test-secret")
os.environ.setdefault("LIVE_PORT_MIN", "14700")
os.environ.setdefault("LIVE_PORT_MAX", "14799")

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  FAIL: {name}" + (f" -> {extra}" if extra else ""))


class Resp:
    def __init__(self, code, headers=None, body=None):
        self.status_code = code
        self.headers = headers or {}
        self._b = body or {}

    def json(self):
        return self._b


def fresh(**env):
    for k in ("RUNNER_SERVICE_URL", "RUNNER_SERVICE_URLS", "WORKER_HEALTH_TTL_S"):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in env.items() if v is not None})
    import services.runner_client as rc
    rc = importlib.reload(rc)
    rc._health_cache.clear()
    return rc


A, B = "https://worker-a.test", "https://worker-b.test"

# ---------------------------------------------------------------------------
print("\n[1] a job's follow-up calls go to ITS worker")
# ---------------------------------------------------------------------------
rc = fresh(RUNNER_SERVICE_URL=A, RUNNER_SERVICE_URLS=B)
calls = []


def a_full(method, url, **kw):
    calls.append(url)
    if url.startswith(A):
        return Resp(503, {"X-Runner-Full": "1"})
    return Resp(201, {}, {"id": "job99", "web_slug": "mybot"})


rc.requests.request = a_full
resp = rc._runner_http("POST", "/internal/jobs", {"code": "x"})
check("create landed on the second worker", resp.status_code == 201)
check("the response records which worker took it",
      getattr(resp, "placed_on", None) == B, str(getattr(resp, "placed_on", None)))

calls.clear()
rc.requests.request = lambda m, u, **k: (calls.append(u), Resp(200, {}, {}))[1]
rc._runner_http("POST", "/internal/jobs/job99/restart", worker=B)
check("restart went to the RECORDED worker, not the first",
      len(calls) == 1 and calls[0].startswith(B), str(calls))

# Regression control: without the worker argument it still hits the primary.
calls.clear()
rc._runner_http("POST", "/internal/jobs/job99/restart")
check("control: no recorded worker falls back to the primary",
      calls[0].startswith(A), str(calls))

# A worker dropped from the pool must still be reachable for its own jobs.
calls.clear()
rc._runner_http("POST", "/internal/jobs/job99/stop", worker="https://retired.test")
check("a job on a de-pooled worker is not orphaned",
      calls[0].startswith("https://retired.test"), str(calls))

# ---------------------------------------------------------------------------
print("[2] the public URL points at the right worker")
# ---------------------------------------------------------------------------
info = {"web": True, "web_slug": "mybot", "web_public": True}
fields = rc._job_web_fields(info, B)
check("live URL uses the job's worker", fields["web_url"].startswith(B),
      fields.get("web_url"))
fields_primary = rc._job_web_fields(info)
check("control: with no worker it falls back to the primary",
      fields_primary["web_url"].startswith(A), fields_primary.get("web_url"))

# ---------------------------------------------------------------------------
print("[3] least-loaded placement")
# ---------------------------------------------------------------------------
rc = fresh(RUNNER_SERVICE_URL=A, RUNNER_SERVICE_URLS=B)


def health(method_or_url, *a, **kw):
    url = method_or_url
    if url.startswith(A):
        return Resp(200, {}, {"free": 1, "load": 0.9, "jobs": 11, "capacity": 12})
    return Resp(200, {}, {"free": 10, "load": 0.16, "jobs": 2, "capacity": 12})


rc.requests.get = health
order = rc._placement_order()
check("the emptier worker is tried first", order[0] == B, str(order))
check("both workers stay in the order", set(order) == {A, B}, str(order))

# Health is cached, so a create never blocks on probing every worker.
probes = []
rc._health_cache.clear()
rc.requests.get = lambda u, **k: (probes.append(u), Resp(200, {}, {"free": 5}))[1]
rc._placement_order()
first = len(probes)
rc._placement_order()
check("health is cached between placements", len(probes) == first, str(len(probes)))

# An offline worker sorts last but is not silently dropped.
rc._health_cache.clear()


def a_down(u, **k):
    if u.startswith(A):
        raise rc.requests.ConnectionError("down")
    return Resp(200, {}, {"free": 4, "load": 0.5})


rc.requests.get = a_down
order = rc._placement_order()
check("an offline worker is tried last", order[-1] == A, str(order))
check("but it is still attempted as a fallback", A in order, str(order))

# A single-worker pool must not pay for health probing at all.
rc = fresh(RUNNER_SERVICE_URL=A)
probes.clear()
rc.requests.get = lambda u, **k: (probes.append(u), Resp(200, {}, {}))[1]
check("single-worker pool skips health probing", rc._placement_order() == [A]
      and not probes, str(probes))

# ---------------------------------------------------------------------------
print("[4] the worker reports its own load")
# ---------------------------------------------------------------------------
import runner.app as R  # noqa: E402


class FakeProc:
    def poll(self):
        return None


R._jobs.clear()
h = R.health()
check("/health needs no auth (it must answer when the secret is wrong)",
      h.get("status") == "ok")
for field in ("jobs", "capacity", "free", "full", "load", "mem_mb"):
    check(f"/health exposes {field}", field in h, str(sorted(h)))
check("empty worker is not full", h["full"] is False and h["free"] == R.MAX_BG_JOBS)

R._jobs.clear()
R._jobs.update({f"j{i}": {"proc": FakeProc()} for i in range(R.MAX_BG_JOBS)})
h = R.health()
check("a saturated worker reports full", h["full"] is True, str(h))
check("free hits zero", h["free"] == 0, str(h))
check("load hits 1.0", h["load"] == 1.0, str(h))
check("load is clamped even if adopted jobs exceed capacity",
      R.health()["load"] <= 1.0, str(R.health()["load"]))
R._jobs.clear()

# It must never leak what is running, only how much.
h = R.health()
check("/health leaks no job names or code",
      not any(k in h for k in ("names", "code", "env", "jobs_list")), str(sorted(h)))

# ---------------------------------------------------------------------------
print("[5] the database records placement")
# ---------------------------------------------------------------------------
import database as DB  # noqa: E402
ddl = "\n".join(DB._SCHEMA_TABLES)
check("jobs table has worker_url", "worker_url TEXT" in ddl)
src = open(os.path.join(ROOT, "database.py"), encoding="utf-8").read()
check("existing databases get the column via ALTER",
      'ALTER TABLE jobs ADD COLUMN worker_url' in src)

rs = open(os.path.join(ROOT, "routes/runspace.py"), encoding="utf-8").read()
check("a helper reads the recorded worker", "def _worker_of(" in rs)
check("creates persist it", "_remember_worker(" in rs)
check("cold-start re-creates persist it too",
      rs.count("worker_url = ?") >= 2, str(rs.count("worker_url = ?")))
check("per-job calls pass the worker through",
      rs.count("worker=_worker_of(row)") >= 10,
      str(rs.count("worker=_worker_of(row)")))
check("recording a worker never breaks a launch",
      "never fail a launch over bookkeeping" in rs)

# ---------------------------------------------------------------------------
print("[6] an unreachable worker is not reported as stopped")
# ---------------------------------------------------------------------------
check("unreachable maps to 'unknown', not 'offline'",
      'row["status"] = "unknown"' in rs)
check("only a real 404 from a live worker means gone",
      'Runner is up and says this job does not exist' in rs)
check("the UI is told the status is stale", 'status_stale' in rs)

# ---------------------------------------------------------------------------
print("[7] per-user limit still spans all workers")
# ---------------------------------------------------------------------------
check("the cap counts rows in the control-plane DB, not per worker",
      "SELECT runner_job_id FROM jobs WHERE user_id = ?" in rs)
check("the limit is applied before placement",
      rs.index("MAX_JOBS_PER_USER") < rs.index('_runner_http("POST", "/internal/jobs"'))

# ---------------------------------------------------------------------------
print("[8] every _worker_of() call has its variable in scope")
# ---------------------------------------------------------------------------
# I shipped two NameErrors doing this by hand: _worker_of(row) inside a loop
# whose variable is `r`, and again inside a helper that has no `row` at all.
# The first 500'd GET /api/jobs; the second sat inside a try/except and would
# have failed cold-start restores SILENTLY. Compile the module and walk the
# AST rather than trusting a grep.
import ast as _ast

_src = open(os.path.join(ROOT, "routes/runspace.py"), encoding="utf-8").read()
_tree = _ast.parse(_src)
_unbound = []
for _fn in [n for n in _ast.walk(_tree)
            if isinstance(n, (_ast.FunctionDef, _ast.AsyncFunctionDef))]:
    # Names bound anywhere in this function: params, assignments, for-targets.
    bound = {a.arg for a in _fn.args.args}
    bound |= {a.arg for a in getattr(_fn.args, "kwonlyargs", [])}
    for node in _ast.walk(_fn):
        if isinstance(node, _ast.Name) and isinstance(node.ctx, _ast.Store):
            bound.add(node.id)
        elif isinstance(node, (_ast.For, _ast.comprehension)):
            tgt = getattr(node, "target", None)
            if isinstance(tgt, _ast.Name):
                bound.add(tgt.id)
        elif isinstance(node, _ast.withitem) and isinstance(node.optional_vars, _ast.Name):
            bound.add(node.optional_vars.id)
    # Any call to _worker_of(x) must use a name bound in this function.
    for node in _ast.walk(_fn):
        if (isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name)
                and node.func.id == "_worker_of" and node.args
                and isinstance(node.args[0], _ast.Name)):
            if node.args[0].id not in bound:
                _unbound.append(f"{_fn.name}() uses _worker_of({node.args[0].id})")
check("no _worker_of() call references an unbound name",
      not _unbound, "; ".join(_unbound))

print(f"\ntest_multi_worker: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
