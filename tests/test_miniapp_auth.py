"""Telegram Mini App auto-login.

WHY A SEPARATE VERIFIER — measured, not assumed. The Login Widget and the Mini
App prove the same identity but derive the HMAC key differently. Same
data-check string, same bot token:

    Login Widget  secret = sha256(token)             -> b1a8455e4830…
    Mini App      secret = HMAC("WebAppData", token) -> 3b019fac3ba6…

So initData posted to /auth/telegram is rejected as tampered. Reusing that
route would either fail every Mini App login or, if loosened to accept both,
turn one endpoint into two trust rules.

The point of the feature is ZERO taps: if a user still has to log in, the Mini
App offers nothing over a link to the website. So the tests below assert the
whole chain — verified signature, session issued, and the SAME account as
every other door onto the platform.

Run:  DATA_DIR=$(mktemp -d) python3 tests/test_miniapp_auth.py
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
from urllib.parse import urlencode

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

_tmp = tempfile.mkdtemp()
os.environ.setdefault("DATA_DIR", _tmp)
os.environ["DB_PATH"] = os.path.join(_tmp, "miniapp.db")
TOKEN = "123456:AAFakeBotTokenForTests"
os.environ["TELEGRAM_PING_BOT_TOKEN"] = TOKEN
os.environ.setdefault("TELEGRAM_BOT_USERNAME", "MyCodeNestBot")
os.environ.setdefault("RUNNER_SERVICE_SECRET", "test-secret")
os.environ.setdefault("LIVE_PORT_MIN", "17300")
os.environ.setdefault("LIVE_PORT_MAX", "17399")

from fastapi.testclient import TestClient  # noqa: E402

import database as DB  # noqa: E402
DB.init_db()
import app as A  # noqa: E402
from services import miniapp_auth as MA  # noqa: E402

PASS = FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  FAIL: {name}" + (f" -> {extra}" if extra else ""))


c = TestClient(A.app, raise_server_exceptions=False)


def init_data(uid=555, uname="ahadxyz", first="Ahad", when=None, token=TOKEN,
              extra=None, drop_user=False):
    """Build a genuinely signed initData string, exactly as Telegram does."""
    d = {"chat_instance": "-1", "chat_type": "private",
         "auth_date": str(int(when if when is not None else time.time()))}
    if not drop_user:
        u = {"id": uid, "first_name": first}
        if uname:
            u["username"] = uname
        d["user"] = json.dumps(u, separators=(",", ":"))
    if extra:
        d.update(extra)
    check_str = "\n".join(f"{k}={d[k]}" for k in sorted(d))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    d["hash"] = hmac.new(secret, check_str.encode(), hashlib.sha256).hexdigest()
    return urlencode(d)


from routes.deps import _attempts  # noqa: E402


def login(data, fresh=True):
    """POST initData.

    The route is IP rate-limited (correctly — it is an auth endpoint), and
    this file makes dozens of calls from one client. Clearing the bucket keeps
    the test measuring verification rather than the limiter; [3b] asserts the
    limiter itself, deliberately, instead of letting it leak into every case.
    """
    if fresh:
        _attempts.clear()
    return c.post("/auth/telegram/miniapp", json={"init_data": data})


# ---------------------------------------------------------------------------
print("\n[1] the two Telegram specs really are different")
# ---------------------------------------------------------------------------
fields = {"auth_date": 1700000000, "first_name": "Ahad", "id": 555}
cs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
widget = hmac.new(hashlib.sha256(TOKEN.encode()).digest(), cs.encode(),
                  hashlib.sha256).hexdigest()
mini = hmac.new(hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest(),
                cs.encode(), hashlib.sha256).hexdigest()
check("the same data signs to two different hashes", widget != mini)
check("so a Mini App payload cannot use the widget route",
      login(urlencode({**fields, "hash": widget})).status_code == 400)

# ---------------------------------------------------------------------------
print("[2] a genuine open signs the user in with zero taps")
# ---------------------------------------------------------------------------
r = login(init_data())
check("verification succeeds", r.status_code == 200, r.text[:120])
body = r.json()
check("a session token comes back", bool(body.get("token")))
check("the account was created on first open", body.get("created") is True)
check("with a stable tg_<id> username", body.get("username") == "tg_555",
      str(body.get("username")))

# The token must be a REAL session, not a placeholder.
H = {"Authorization": "Bearer " + body["token"]}
prof = c.get("/profile", headers=H)
check("the token authenticates against the normal API", prof.status_code == 200,
      str(prof.status_code))
check("and resolves to that account", prof.json().get("username") == "tg_555")

r2 = login(init_data())
check("a second open reuses the account", r2.json().get("created") is False)
conn = DB.get_db_connection()
n = dict(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone())["c"]
conn.close()
check("no duplicate account is created", n == 1, str(n))

# ---------------------------------------------------------------------------
print("[3] forged, stale and malformed data are all refused")
# ---------------------------------------------------------------------------
good = init_data()
check("a flipped hash is rejected",
      login(good[:-1] + ("0" if good[-1] != "0" else "1")).status_code == 400)
check("data signed with another bot's token is rejected",
      login(init_data(token="999999:SomeOtherBotToken")).status_code == 400)
check("a payload with no hash is rejected",
      login(urlencode({"auth_date": str(int(time.time())), "user": "{}"})).status_code == 400)
check("an old payload cannot be replayed",
      login(init_data(when=time.time() - 90000)).status_code == 400)
check("a payload from the future is rejected",
      login(init_data(when=time.time() + 4000)).status_code == 400)
check("empty initData is rejected", login("").status_code == 400)
check("garbage is rejected, not crashed on", login("not-a-query-string").status_code == 400)

# Changing ONE character of the signed content must invalidate it — this is
# what stops someone editing the user id to log in as another account.
tampered = init_data().replace("%22id%22%3A555", "%22id%22%3A999")
check("editing the user id after signing is caught",
      login(tampered).status_code == 400, str(login(tampered).status_code))

# Every failure gets the same message. Telling a forger that the hash was fine
# but the timestamp was stale is a hint about what to fix next.
_rejects = [login(x) for x in
            (good[:-1] + ("0" if good[-1] != "0" else "1"),
             init_data(when=time.time() - 90000), "garbage")]
check("every one of them is refused",
      all(r.status_code == 400 for r in _rejects),
      str([r.status_code for r in _rejects]))
msgs = {r.json().get("detail") for r in _rejects}
check("all rejections read identically", len(msgs) == 1,
      str(msgs) + " codes=" + str([r.status_code for r in _rejects]))

print("[3b] the endpoint is rate limited, like every other auth route")
_attempts.clear()
codes = [login(init_data(token="999:WRONG"), fresh=False).status_code
         for _ in range(30)]
check("a forger cannot hammer it forever", 429 in codes,
      str(sorted(set(codes))))
check("and legitimate calls still work once the window clears",
      login(init_data()).status_code == 200)

# ---------------------------------------------------------------------------
print("[4] the verifier's own edge cases")
# ---------------------------------------------------------------------------
try:
    MA.verify_init_data(init_data(drop_user=True))
    ok = False
except ValueError as e:
    ok = str(e) == "no_user"
check("initData with no user (inline/channel open) is refused", ok)

# Telegram is rolling out a `signature` field for third-party validation. It
# is NOT part of the HMAC data-check string; leaving it in breaks every login.
signed = init_data(extra=None)
pairs = dict(x.split("=", 1) for x in signed.split("&"))
with_sig = signed + "&signature=" + "abc123"
try:
    got = MA.verify_init_data(with_sig)
    sig_ok = got["id"] == 555
except ValueError as e:
    sig_ok = False
check("an added `signature` field does not break verification", sig_ok)

def _reason(data, token=None):
    """The ValueError reason verify_init_data raises, or None on success."""
    try:
        MA.verify_init_data(data) if token is None else MA.verify_init_data(data, token)
        return None
    except ValueError as exc:
        return str(exc)


check("an oversized blob is refused before any parsing",
      _reason("x" * 9000) == "too_large", str(_reason("x" * 9000)))
check("a missing bot token is reported distinctly, not as a bad signature",
      _reason(init_data(), token="") == "not_configured",
      str(_reason(init_data(), token="")))
check("a bad auth_date is named as such, not as a bad hash",
      _reason(init_data(when=time.time() - 90000)) == "expired")
check("no hash means no_hash",
      _reason(urlencode({"auth_date": "1", "user": "{}"})) == "no_hash")

# ---------------------------------------------------------------------------
print("[5] one identity across every door")
# ---------------------------------------------------------------------------
# The Mini App, the website's Telegram Login and the bot must all land on the
# same row when the Telegram id matches. Two accounts for one person would
# split their job list and double their quota.
wf = {"auth_date": int(time.time()), "first_name": "Ahad", "id": 555,
      "username": "ahadxyz", "photo_url": ""}
wcs = "\n".join(f"{k}={v}" for k, v in sorted(wf.items()) if v not in (None, ""))
wf["hash"] = hmac.new(hashlib.sha256(TOKEN.encode()).digest(), wcs.encode(),
                      hashlib.sha256).hexdigest()
rw = c.post("/auth/telegram", json=wf)
check("the website widget still works", rw.status_code == 200, rw.text[:120])
check("and lands on the SAME username", rw.json().get("username") == "tg_555")
conn = DB.get_db_connection()
n2 = dict(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone())["c"]
conn.close()
check("still one account, not two", n2 == 1, str(n2))

check("the Telegram handle is cached for the dashboard",
      c.get("/profile/telegram", headers=H).json().get("telegram_name") == "@ahadxyz",
      str(c.get("/profile/telegram", headers=H).json()))

# A user who renames themselves on Telegram must not show a stale handle.
login(init_data(uname="newhandle"))
check("the cached handle refreshes on a later open",
      c.get("/profile/telegram", headers=H).json().get("telegram_name") == "@newhandle",
      str(c.get("/profile/telegram", headers=H).json().get("telegram_name")))

# A suspended account must not gain a new way in.
conn = DB.get_db_connection()
conn.execute("UPDATE users SET is_suspended = 1 WHERE telegram_id = 555")
conn.commit()
conn.close()
check("a suspended account cannot sign in via the Mini App",
      login(init_data()).status_code == 403, str(login(init_data()).status_code))
conn = DB.get_db_connection()
conn.execute("UPDATE users SET is_suspended = 0 WHERE telegram_id = 555")
conn.commit()
conn.close()

# ---------------------------------------------------------------------------
print("[6] the same limits apply, whichever door was used")
# ---------------------------------------------------------------------------
from services.runner_client import MAX_JOBS_PER_USER  # noqa: E402
from services import bot_ops  # noqa: E402
src_rs = open(os.path.join(ROOT, "routes/runspace.py"), encoding="utf-8").read()
check("the web create path enforces the cap", "MAX_JOBS_PER_USER" in src_rs)
check("and bot_ops enforces the same constant",
      "MAX_JOBS_PER_USER" in open(os.path.join(ROOT, "services/bot_ops.py"),
                                  encoding="utf-8").read())
check("there is only ONE cap value", MAX_JOBS_PER_USER == bot_ops.MAX_JOBS_PER_USER)
# The Mini App is the website, so it uses POST /api/jobs — no third path.
src_ma = open(os.path.join(ROOT, "static/miniapp.js"), encoding="utf-8").read()
check("the Mini App adds no second job-creation path",
      "/internal/jobs" not in src_ma and "/api/jobs" not in src_ma)

# ---------------------------------------------------------------------------
print("[7] the bot's Mini App entry point")
# ---------------------------------------------------------------------------
import services.pingbot as PB  # noqa: E402
SENT = []
PB._tg = lambda m, **p: (SENT.append((m, p)), {"ok": True})[1]

PB.SITE_BASE = "https://ahadorg.onrender.com"
btn = PB._open_button()
check("the launch button is a web_app button", "web_app" in (btn or {}), str(btn))
check("pointing at the dashboard",
      (btn or {}).get("web_app", {}).get("url", "").endswith("/dashboard"), str(btn))

# Telegram REFUSES a web_app button on http:// and drops the whole keyboard.
PB.SITE_BASE = "http://localhost:8000"
btn2 = PB._open_button()
check("an http site falls back to a plain link rather than a rejected button",
      "url" in (btn2 or {}) and "web_app" not in (btn2 or {}), str(btn2))
check("and the menu button is not registered at all on http",
      PB.set_menu_button() is False)
PB.SITE_BASE = "https://ahadorg.onrender.com"

SENT.clear()
check("the menu button registration calls the right API",
      PB.set_menu_button() is True and SENT[0][0] == "setChatMenuButton",
      str(SENT[:1]))
check("with type web_app",
      SENT[0][1]["menu_button"]["type"] == "web_app", str(SENT[0][1]))

src_pb = open(os.path.join(ROOT, "services/pingbot.py"), encoding="utf-8").read()
src_ops = open(os.path.join(ROOT, "services/bot_ops.py"), encoding="utf-8").read()
# Chat-based code deploy is removed outright, so the Mini App is the ONLY
# place code is written — there is no cheaper-looking path competing with it.
check("no /code command", 'startswith("/code")' not in src_pb)
check("no /deploy command", 'startswith("/deploy")' not in src_pb)
check("no /update command", 'startswith("/update")' not in src_pb)
check("no message can reach the runner as a job",
      '"/internal/jobs"' not in src_pb and '"/internal/jobs"' not in src_ops)
check("/jobs is accepted as well as /apps",
      'text.startswith("/jobs")' in src_pb)

# /start: exactly one button, and no URL as text.
SENT.clear()
PB.telegram_link.user_for_chat = lambda cid: None      # unlinked visitor
PB.handle_start(424242, "Stranger")
_msg = [p for m, p in SENT if m == "sendMessage"][-1]
_kb = json.loads(_msg["reply_markup"])["inline_keyboard"]
_btns = [b for row in _kb for b in row]
check("/start shows exactly one button", len(_btns) == 1, str(_btns))
check("labelled Open CodeNest", "Open CodeNest" in _btns[0]["text"], str(_btns[0]))
check("and it is a web_app button, not a link", "web_app" in _btns[0], str(_btns[0]))
check("no URL is printed in the text", "http" not in _msg["text"], _msg["text"][:120])
check("and no code command is advertised",
      not any(x in _msg["text"] for x in ("/code", "/deploy", "/update")),
      _msg["text"][:160])

# ---------------------------------------------------------------------------
print("[8] a normal browser is untouched")
# ---------------------------------------------------------------------------
html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
check("the SDK is loaded", "telegram-web-app.js" in html)
# "pro.js" first appears inside a COMMENT further up the file, so a plain
# indexOf compares against the wrong position. Match the real script tags.
import re as _re  # noqa: E402
_tags = _re.findall(r'<script src="/static/(miniapp|pro)\.js', html)
check("miniapp.js loads BEFORE pro.js, which reads its globals",
      _tags[:2] == ["miniapp", "pro"], str(_tags))
check("the SDK's mere presence is not treated as being inside Telegram",
      "TG.initData.length > 0" in src_ma)
check("outside Telegram the module does nothing and returns early",
      "if (!inTelegram)" in src_ma and "return;" in src_ma)
check("an existing session is reused rather than re-authenticated",
      'localStorage.getItem("ahad_token")' in src_ma)
_pro = open(os.path.join(ROOT, "static/pro.js"), encoding="utf-8").read()
# The FIRST "__tgAutoLogin" is the `typeof` guard; the branch bodies come
# after the call. Slice from the call itself.
_boot = _pro[_pro.index("window.__tgAutoLogin()"):][:1200]
check("a failed verification falls back to the normal login screen",
      'showScreen("screen-landing")' in _boot, _boot[:200])
check("a thrown error does too, rather than leaving a blank page",
      _boot.count('showScreen("screen-landing")') >= 2, _boot[:400])
check("and the boot splash is always cleared",
      "bootSplash" in _boot and "finally" in _boot)
check("theme colours are validated before being injected into CSS",
      "/^#[0-9a-f]{3,8}$/i" in src_ma)

print(f"\ntest_miniapp_auth: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
