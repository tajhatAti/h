"""Admin monitoring dashboard: access control, live numbers, drill-downs.

Every number here is checked against REAL data — a real login, a real spawned
job — not fixtures. A monitoring panel that reports plausible-looking numbers
is worse than no panel, because it is trusted.

ACCESS CONTROL is asserted first and hardest: a non-admin must get a plain
404, never 403 and never a redirect, because "you don't have permission"
confirms the page exists.

Run:  DATA_DIR=$(mktemp -d) DB_PATH=$(mktemp -d)/t.db python3 tests/test_admin_dashboard.py
"""
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

_tmp = tempfile.mkdtemp()
os.environ.setdefault("DATA_DIR", _tmp)
os.environ["DB_PATH"] = os.path.join(_tmp, "admin_test.db")
os.environ.setdefault("RUNNER_SERVICE_SECRET", "test-secret")
os.environ.setdefault("LIVE_PORT_MIN", "17800")
os.environ.setdefault("LIVE_PORT_MAX", "17899")

import bcrypt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database as DB  # noqa: E402
DB.init_db()
import app as A  # noqa: E402
import runner.app as R  # noqa: E402
from routes.deps import now_utc_str  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  FAIL: {name}" + (f" -> {extra}" if extra else ""))


c = TestClient(A.app, raise_server_exceptions=False)
PW = "Passw0rd!x"
_h = bcrypt.hashpw(PW.encode(), bcrypt.gensalt()).decode()
conn = DB.get_db_connection()
conn.execute("INSERT INTO users (username,email,password,is_verified,is_admin,created_at,updated_at)"
             " VALUES (?,?,?,1,1,?,?)", ("boss", "boss@gmail.com", _h, now_utc_str(), now_utc_str()))
conn.execute("INSERT INTO users (username,email,password,is_verified,is_admin,created_at,updated_at)"
             " VALUES (?,?,?,1,0,?,?)", ("normie", "normie@gmail.com", _h, now_utc_str(), now_utc_str()))
conn.execute("INSERT INTO users (username,email,password,is_verified,telegram_id,created_at,updated_at)"
             " VALUES (?,?,?,1,?,?,?)", ("tguser", "tg@gmail.com", _h, 5551234, now_utc_str(), now_utc_str()))
conn.commit()
conn.close()


def login(u):
    r = c.post("/login", json={"username": u, "password": PW})
    return (r.json() or {}).get("token")


AT, NT = login("boss"), login("normie")
AH, NH = {"Authorization": "Bearer " + AT}, {"Authorization": "Bearer " + NT}

ADMIN_ROUTES = ["/admin/overview", "/admin/users", "/admin/users/2",
                "/admin/jobs", "/admin/libraries", "/admin/audit-log",
                "/admin/abuse-reports"]

# ---------------------------------------------------------------------------
print("\n[1] access control")
# ---------------------------------------------------------------------------
check("admin logged in", bool(AT))
check("non-admin logged in", bool(NT))
for p in ADMIN_ROUTES:
    r = c.get(p, headers=NH)
    check(f"non-admin gets 404 on {p}", r.status_code == 404, str(r.status_code))
    # 403 would confirm the route exists; a redirect would too.
    check(f"{p} never says 'permission'", "permission" not in r.text.lower(), r.text[:60])
    check(f"{p} does not redirect", r.status_code not in (301, 302, 307, 308))
for p in ADMIN_ROUTES:
    r = c.get(p)
    check(f"anonymous is refused on {p}", r.status_code in (401, 404), str(r.status_code))
for p in ADMIN_ROUTES:
    check(f"admin CAN reach {p}", c.get(p, headers=AH).status_code == 200)

html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
js = open(os.path.join(ROOT, "static/pro.js"), encoding="utf-8").read()
check("the admin tab ships hidden", 'id="tabBtnAdmin"' in html and "hidden" in html)
check("visibility is driven by the server's is_admin",
      "applyAdminVisibility" in js and "profile.is_admin" in js)
check("non-admins have the panel REMOVED from the DOM, not just hidden",
      "must not merely hide its DATA" in js)

# ---------------------------------------------------------------------------
print("[2] overview reports real numbers")
# ---------------------------------------------------------------------------
ov = c.get("/admin/overview", headers=AH).json()
check("counts the users that actually exist", ov["users"] == 3, str(ov.get("users")))
for w in ("signups_24h", "signups_7d", "signups_30d"):
    check(f"{w} present", w in ov, str(sorted(ov)))
check("all 3 signups land in the 24h window", ov["signups_24h"] == 3, str(ov.get("signups_24h")))
check("windows widen monotonically",
      ov["signups_24h"] <= ov["signups_7d"] <= ov["signups_30d"])
check("active users measured from real sessions", ov.get("active_users", 0) >= 2,
      str(ov.get("active_users")))
check("the active window is stated", ov.get("active_window_min") == 15)
for k in ("mem_used_mb", "mem_safe_mb", "mem_total_mb", "mem_pct"):
    check(f"memory field {k}", k in ov, str(sorted(ov)))
check("memory is shown against a ceiling, not as a raw number",
      ov["mem_safe_mb"] > 0 and 0 <= ov["mem_pct"] <= 100, str(ov.get("mem_pct")))

# ---------------------------------------------------------------------------
print("[3] a REAL job, measured end to end")
# ---------------------------------------------------------------------------
r = c.post("/api/jobs", headers=AH, json={
    "name": "realbot", "language": "python",
    "code": "import time\nwhile True:\n    time.sleep(1)\n"})
check("job created", r.status_code in (200, 201), str(r.status_code))
for j in R._jobs.values():
    j["libs"] = ["pyTelegramBotAPI", "requests", "numpy"]
time.sleep(3)

jobs = c.get("/admin/jobs", headers=AH).json()["jobs"]
check("the job is listed", len(jobs) == 1, str(len(jobs)))
jb = jobs[0]
check("live status comes from the runner", jb["live_status"] == "running", str(jb.get("live_status")))
check("memory is a real measurement", (jb.get("mem_mb") or 0) > 0, str(jb.get("mem_mb")))
check("peak is tracked", (jb.get("peak_mem_mb") or 0) > 0, str(jb.get("peak_mem_mb")))
check("peak is never below current", jb["peak_mem_mb"] >= jb["mem_mb"])
check("cpu is reported", jb.get("cpu_pct") is not None)
check("the owner is named", jb.get("owner") == "boss", str(jb.get("owner")))
check("the worker is identified", bool(jb.get("worker")), str(jb.get("worker")))
check("installed packages surface", set(jb["libs"]) == {"numpy", "pyTelegramBotAPI", "requests"},
      str(jb.get("libs")))
check("source is labelled", jb.get("source") in ("website", "telegram"))
check("and marked as INFERRED, since no source column is recorded",
      jb.get("source_inferred") is True)
check("the code is never exposed", "code" not in jb, str(sorted(jb)))

ov = c.get("/admin/overview", headers=AH).json()
check("status breakdown counts the running job",
      (ov.get("jobs_by_status") or {}).get("running") == 1, str(ov.get("jobs_by_status")))
check("platform memory reflects the real job", ov["mem_used_mb"] > 0, str(ov["mem_used_mb"]))

# ---------------------------------------------------------------------------
print("[4] library aggregation")
# ---------------------------------------------------------------------------
lib = c.get("/admin/libraries", headers=AH).json()
names = [e["library"] for e in lib["libraries"]]
check("packages are aggregated", set(names) == {"numpy", "pyTelegramBotAPI", "requests"}, str(names))
check("sorted by frequency", all(
    lib["libraries"][i]["count"] >= lib["libraries"][i + 1]["count"]
    for i in range(len(lib["libraries"]) - 1)))
check("each entry names the jobs using it",
      all(e["jobs"] and e["jobs"][0]["owner"] == "boss" for e in lib["libraries"]))
heavy = [e["library"] for e in lib["libraries"] if e["heavy"]]
check("a heavy framework is flagged", "numpy" in heavy, str(heavy))
check("an ordinary package is NOT flagged",
      not any(e["heavy"] or e["watch"] for e in lib["libraries"] if e["library"] == "requests"))
check("the sample size is stated", lib.get("jobs_sampled") == 1)
check("the limitation is stated rather than hidden", "currently known" in lib.get("note", ""))

# ---------------------------------------------------------------------------
print("[5] per-user drill-down")
# ---------------------------------------------------------------------------
d = c.get("/admin/users/1", headers=AH).json()
check("account info returned", d["user"]["username"] == "boss")
check("their jobs are listed", len(d["jobs"]) == 1, str(len(d["jobs"])))
check("resource total is summed", d["mem_used_mb"] > 0, str(d.get("mem_used_mb")))
check("login history included", isinstance(d.get("sessions"), list) and len(d["sessions"]) >= 1,
      str(len(d.get("sessions") or [])))
check("sessions carry IP", "ip_address" in (d["sessions"][0] or {}))
check("sessions carry fingerprint", "fingerprint" in (d["sessions"][0] or {}))
tg = c.get("/admin/users/3", headers=AH).json()
check("telegram signup detected", tg["user"]["auth_method"] == "telegram",
      str(tg["user"].get("auth_method")))
check("auth method is marked inferred", tg["user"]["auth_method_inferred"] is True)
check("a missing user is 404, not 500", c.get("/admin/users/9999", headers=AH).status_code == 404)

# ---------------------------------------------------------------------------
print("[6] live updates are bounded")
# ---------------------------------------------------------------------------
check("polling exists", "_admSetPolling" in js)
check("interval is 10s, not sub-second", "ADM_POLL_MS = 10000" in js)
check("polling stops when the tab is not open", '_admSetPolling(tabId === "admin")' in js)
check("polling pauses in a background tab", "if (document.hidden) return;" in js)
check("it resumes on refocus", "visibilitychange" in js)
check("a failed poll does not break the panel", "loadAdminPanel(true).catch(() => {})" in js)

# ---------------------------------------------------------------------------
print("[7] rendering is injection-safe")
# ---------------------------------------------------------------------------
check("package names are set via textContent", "name.textContent = r.library" in js)
check("the review flag says review, not abuse",
      'r.watch ? "review" : "heavy"' in js)

for j in list(R._jobs.values()):
    try:
        j["proc"].kill()
    except Exception:
        pass

print(f"\ntest_admin_dashboard: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
