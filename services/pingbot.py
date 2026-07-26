"""
Telegram Bot - Advanced RunSpace Controller (Pure requests)
Features:
- /code → Smart code collection (5 sec buffer)
- Inline buttons after deploy
- Real logs, Uptime, Download DB
"""
import json
import os
import re
import threading
import time
import requests
from collections import defaultdict

BOT_TOKEN = os.getenv("TELEGRAM_PING_BOT_TOKEN", "").strip()
RUNNER_SECRET = os.getenv("RUNNER_SERVICE_SECRET", "")
SITE_BASE = os.getenv("SITE_BASE_URL", "https://ahadorg.onrender.com").rstrip("/")

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}" if BOT_TOKEN else ""

# Code collection buffer
code_buffer = defaultdict(list)       # chat_id -> list of messages
buffer_timer = {}                     # chat_id -> timer

# Chats that ran /code and are now streaming their source in. Telegram splits
# anything over ~4096 chars into SEPARATE messages, so the flag MUST survive
# every chunk — it is cleared only when flush_code() actually deploys.
waiting_for_code = {}                 # chat_id -> True


def _tg(method, **params):
    """Call a Telegram Bot API method.

    POST + JSON body (not GET + query params): nested structures such as
    reply_markup's inline_keyboard cannot survive urlencoding — requests
    flattens them to "reply_markup=inline_keyboard" and the buttons vanish.
    """
    if not TG_API:
        return {}
    try:
        r = requests.post(f"{TG_API}/{method}", json=params, timeout=50)
        return r.json()
    except Exception as e:  # noqa: BLE001
        print(f"Telegram {method} failed: {e}")
        return {}


TG_MAX_UPLOAD_BYTES = 50 * 1024 * 1024   # Telegram bot upload ceiling


def _send_document(chat_id, filepath, caption=""):
    """Upload a real file to the chat (multipart, not the JSON endpoint)."""
    if not TG_API:
        return {}
    try:
        with open(filepath, "rb") as fh:
            r = requests.post(
                f"{TG_API}/sendDocument",
                data={"chat_id": chat_id, "caption": caption[:1024]},
                files={"document": (os.path.basename(filepath), fh)},
                timeout=120,
            )
        return r.json()
    except Exception as e:  # noqa: BLE001
        print("sendDocument failed:", e)
        _send(chat_id, "❌ Upload failed.")
        return {}


def _send(chat_id, text, reply_markup=None):
    data = {"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}
    if reply_markup:
        # Telegram expects reply_markup as a JSON-serialised string.
        data["reply_markup"] = json.dumps(reply_markup)
    _tg("sendMessage", **data)


# ==================== /ping ====================
def handle_ping(chat_id, text):
    target = text.split()[1] if len(text.split()) > 1 else "https://ahadorg.onrender.com"
    try:
        t0 = time.time()
        r = requests.head(target, timeout=8, allow_redirects=True)
        ms = round((time.time() - t0) * 1000, 1)
        _send(chat_id, f"🟢 {ms}ms | HTTP {r.status_code}")
    except Exception as e:
        _send(chat_id, f"❌ {str(e)}")


# ==================== SMART CODE COLLECTION ====================
def flush_code(chat_id, first_name):
    """Fired 5s after the LAST chunk arrived — join everything and deploy."""
    if chat_id not in code_buffer:
        waiting_for_code.pop(chat_id, None)
        return
    code = "\n".join(code_buffer[chat_id])
    del code_buffer[chat_id]
    buffer_timer.pop(chat_id, None)
    # Collection is over — the next plain message is NOT code any more.
    waiting_for_code.pop(chat_id, None)
    if not code.strip():
        _send(chat_id, "❌ Kono code paini. Abar /code likhun.")
        return
    deploy_code(code, chat_id, first_name)


def collect_code(chat_id, text, first_name):
    code_buffer[chat_id].append(text)

    # Reset timer
    if chat_id in buffer_timer:
        buffer_timer[chat_id].cancel()

    timer = threading.Timer(5.0, flush_code, args=[chat_id, first_name])
    timer.start()
    buffer_timer[chat_id] = timer


# ==================== DEPLOY + INLINE BUTTONS ====================
def detect_libs(code):
    imports = re.findall(r'^\s*(?:import|from)\s+([a-zA-Z0-9_]+)', code, re.MULTILINE)
    common = {"requests": "requests", "flask": "flask", "fastapi": "fastapi",
              "pandas": "pandas", "openai": "openai", "telebot": "pyTelegramBotAPI"}
    return [common.get(i.lower()) for i in imports if i.lower() in common]


def get_job_buttons(runner_id, url):
    return {
        "inline_keyboard": [
            [
                {"text": "📜 Logs", "callback_data": f"logs:{runner_id}"},
                {"text": "⏱ Uptime", "callback_data": f"uptime:{runner_id}"}
            ],
            [
                {"text": "📥 Download DB", "callback_data": f"db:{runner_id}"},
                {"text": "🔄 Restart", "callback_data": f"restart:{runner_id}"}
            ],
            [{"text": "🌐 Open Live URL", "url": url}]
        ]
    }


def deploy_code(code, chat_id, first_name):
    libs = detect_libs(code)
    lang = "python"
    if "console.log" in code.lower():
        lang = "javascript"
    elif "<html" in code.lower():
        lang = "html"

    username = first_name.lower().replace(" ", "_")[:10]
    job_name = f"tg-{username}-{int(time.time())}"

    msg = f"✅ *Code Received*\nLanguage: `{lang}`"
    if libs:
        msg += f"\nInstalling: `{', '.join(libs)}`"
    msg += f"\n\nDeploying `{job_name}`..."
    _send(chat_id, msg)

    payload = {"name": job_name, "language": lang, "code": code}
    if libs:
        payload["requirements"] = "\n".join(libs)

    try:
        from services.runner_client import _runner_http

        resp = _runner_http("POST", "/internal/jobs", payload)
        if resp.status_code != 201:
            _send(chat_id, f"❌ {resp.json().get('detail', 'Failed')}")
            return

        job = resp.json()
        runner_id = job.get("id")
        url = job.get("web_url") or f"{SITE_BASE}/live/{job_name}"

        _send(chat_id, f"🚀 *Deployed!*\n\nLive URL: {url}", 
              reply_markup=get_job_buttons(runner_id, url))

    except Exception as e:
        _send(chat_id, f"Error: {str(e)}")


# ==================== CALLBACK HANDLER ====================
def handle_callback(chat_id, data):
    try:
        action, runner_id = data.split(":")
    except:
        return

    from services.runner_client import _runner_http

    if action == "logs":
        try:
            r = _runner_http("GET", f"/internal/jobs/{runner_id}")
            logs = r.json().get("logs", "No logs yet")[-500:]
            _send(chat_id, f"📜 *Latest Logs:*\n```\n{logs}\n```")
        except:
            _send(chat_id, "❌ Could not fetch logs")

    elif action == "uptime":
        try:
            r = _runner_http("GET", f"/internal/jobs/{runner_id}")
            data = r.json()
            uptime = data.get("uptime_s", 0)
            status = data.get("status", "unknown")
            _send(chat_id, f"⏱ *Uptime:* {uptime}s\nStatus: `{status}`")
        except:
            _send(chat_id, "❌ Could not get status")

    elif action == "db":
        # Real implementation (this used to be a dead "coming soon" button):
        # find the job's data file in its workspace and upload it to Telegram.
        try:
            r = _runner_http("GET", f"/internal/jobs/{runner_id}")
            jdir = (r.json() or {}).get("dir") or ""
            if not jdir or not os.path.isdir(jdir):
                _send(chat_id, "❌ Workspace not found (job may have been deleted).")
                return
            best, best_size = None, -1
            for root, dirs, files in os.walk(jdir):
                dirs[:] = [d for d in dirs if d not in
                           ("__pycache__", ".git", "node_modules", "pylibs", ".cache")]
                for fn in files:
                    if not fn.lower().endswith((".db", ".sqlite", ".sqlite3", ".json")):
                        continue
                    fp = os.path.join(root, fn)
                    try:
                        sz = os.path.getsize(fp)
                    except OSError:
                        continue
                    if sz > best_size:
                        best, best_size = fp, sz
            if not best:
                _send(chat_id, "📭 No database file found yet — the bot hasn't created one.")
                return
            if best_size > TG_MAX_UPLOAD_BYTES:
                _send(chat_id, f"❌ `{os.path.basename(best)}` is {best_size // (1024*1024)} MB — "
                               f"over Telegram's 50 MB limit. Download it from the dashboard.")
                return
            _send_document(chat_id, best, caption=f"📥 {os.path.basename(best)} ({best_size} bytes)")
        except Exception as e:  # noqa: BLE001
            print("db download failed:", e)
            _send(chat_id, "❌ Could not fetch the database file.")

    elif action == "restart":
        try:
            _runner_http("POST", f"/internal/jobs/{runner_id}/restart")
            _send(chat_id, "🔄 Restart requested!")
        except:
            _send(chat_id, "❌ Restart failed")


# ==================== MAIN LOOP ====================
def poll_loop():
    if not BOT_TOKEN:
        return
    print("🤖 Advanced Bot starting...")
    offset = 0

    while True:
        try:
            updates = _tg("getUpdates", offset=offset, timeout=40)
            if not updates or not updates.get("ok"):
                time.sleep(1)
                continue

            for upd in updates.get("result", []):
                offset = upd["update_id"] + 1

                if "message" in upd:
                    msg = upd["message"]
                    chat_id = msg["chat"]["id"]
                    text = msg.get("text", "") or ""
                    first_name = msg.get("from", {}).get("first_name", "user")

                    if text.startswith("/start"):
                        _send(chat_id, f"👋 Hi {first_name}!\n\nUse /ping or /code")

                    elif text.startswith("/ping"):
                        handle_ping(chat_id, text)

                    elif text.startswith("/code"):
                        waiting_for_code[chat_id] = True
                        code_buffer.pop(chat_id, None)
                        _send(chat_id, "✅ Send your code (any size)")

                    elif chat_id in waiting_for_code:
                        # Keep the flag set: long files arrive as SEVERAL
                        # messages and every one of them must land in the
                        # buffer. flush_code() clears it after deploying.
                        collect_code(chat_id, text, first_name)

                elif "callback_query" in upd:
                    cb = upd["callback_query"]
                    handle_callback(cb["message"]["chat"]["id"], cb["data"])
                    _tg("answerCallbackQuery", callback_query_id=cb["id"])

        except Exception as e:
            print("Poll error:", e)
            time.sleep(3)


def start_bot():
    if not BOT_TOKEN:
        print("TELEGRAM_PING_BOT_TOKEN not set")
        return
    t = threading.Thread(target=poll_loop, daemon=True)
    t.start()
    print("✅ Advanced Bot started (with 5s buffer + inline controls)")