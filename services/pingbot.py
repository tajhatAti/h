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
# Every command that DOES something is gated on this: the chat must be bound
# to a CodeNest account. Before it existed, an unknown chat could deploy code
# — reproduced, a stranger's os.system('whoami') ran on the server.
from services import telegram_link  # noqa: E402
from services import bot_ops  # noqa: E402
from services import runner_client  # noqa: E402

import logging
logger = logging.getLogger("codenest-app")

# CODE NEVER ARRIVES THROUGH CHAT.
#
# The bot used to accept a pasted snippet and deploy it. That is removed: a
# Telegram message caps at ~4096 characters, there is no editor, no syntax
# help and no file tree, so it could only ever serve toy scripts while looking
# like a real way to work. Writing, editing and deploying happen in the Mini
# App and the website — which are the same UI.
#
# What the bot keeps is what a chat is actually good at: a launch button,
# read-only status, and push notifications.
RUNNER_SECRET = os.getenv("RUNNER_SERVICE_SECRET", "")
SITE_BASE = os.getenv("SITE_BASE_URL", "https://ahadorg.onrender.com").rstrip("/")

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}" if BOT_TOKEN else ""




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


# ==================== IDENTITY ====================
# An unlinked chat gets the SAME reply as an unknown command. Saying "you need
# to link first" confirms the bot is attached to something worth attacking;
# saying nothing useful costs a legitimate user one visit to /start, which
# does explain the link step — but only to a chat that asked for help, not to
# one probing for a deploy endpoint.
UNKNOWN_REPLY = "🤔 Unknown command. Send /start to see what I can do."


def _require_link(chat_id):
    """The account this chat speaks for, or None (and the chat is answered).

    Returns None for unlinked AND for suspended accounts, so a suspension
    closes the Telegram door too — otherwise suspending someone on the web
    would leave them a second way in.
    """
    user = telegram_link.user_for_chat(chat_id)
    if not user:
        _send(chat_id, UNKNOWN_REPLY)
        return None
    return user


def handle_link(chat_id, text, display_name=""):
    """/link 123456 — redeem a code issued by the website."""
    parts = (text or "").split()
    if len(parts) < 2:
        _send(chat_id,
              "🔗 *Connect your account*\n\n"
              "Open your CodeNest dashboard → Settings → *Connect Telegram* "
              "and tap the button. It brings you back here and connects you "
              "automatically — nothing to type.",
              reply_markup=_menu_buttons())
        return

    already = telegram_link.user_for_chat(chat_id)
    if already:
        _send(chat_id, f"✅ This chat is already connected to *{already['username']}*.")
        return

    # A 6-digit code is a million wide; without a per-chat cap the bot itself
    # becomes the brute-force tool.
    guard = _link_rate_ok(chat_id)
    if not guard:
        _send(chat_id, "⏳ Too many attempts. Wait a few minutes and try again.")
        return

    res = telegram_link.redeem_code(parts[1], chat_id, display_name)
    if res.get("ok"):
        # A button back, because the user arrived here FROM the dashboard and
        # the dashboard is where the connection now shows up. Telling them to
        # "go back" without a link is how a two-tap flow becomes a hunt again.
        rows = [[{"text": "📦 Open dashboard", "url": f"{SITE_BASE}/dashboard"}]] \
            if SITE_BASE else []
        _send(chat_id,
              f"✅ Connected to *{res['username']}*.\n\n" +
              _help_text({"username": res["username"]}).split("\n\n", 1)[1],
              reply_markup={"inline_keyboard": rows} if rows else None)
        return

    telegram_link.note_failed_attempt(parts[1])
    reason = res.get("reason")
    if reason == "chat_already_linked":
        _send(chat_id, "❌ This Telegram account is already connected to another CodeNest account.")
    elif reason == "expired":
        _send(chat_id, "⌛ That code has expired. Generate a new one on the site.")
    elif reason == "suspended":
        _send(chat_id, "❌ That account is suspended.")
    else:
        # "unknown" and "malformed" get one message on purpose: telling a
        # guesser that a code was well-formed but wrong is a hint.
        _send(chat_id, "❌ That code is not valid. Generate a fresh one on the site.")


def _cmd_arg(text):
    """Everything after the command word. "/logs my bot" -> "my bot"."""
    parts = (text or "").split(None, 1)
    return parts[1].strip() if len(parts) > 1 else ""


def _tg_display(msg):
    """A human label for whoever sent this message.

    Prefers @username because that is what a person recognises; falls back to
    the first name, which Telegram always provides.
    """
    frm = (msg or {}).get("from") or {}
    uname = (frm.get("username") or "").strip()
    if uname:
        return "@" + uname
    return (frm.get("first_name") or "").strip()


# A Mini App button needs an HTTPS URL — Telegram refuses http:// and refuses
# to render the button at all, so a local dev SITE_BASE must fall back to a
# plain link rather than producing a keyboard Telegram will reject.
def _miniapp_ok() -> bool:
    return SITE_BASE.startswith("https://")


def _open_button(label="🚀 Open CodeNest"):
    """The Mini App launch button, or a plain link when that is not possible.

    `web_app` opens the existing site INSIDE Telegram, where initData signs
    the user in automatically. `url` opens a browser, where they would have to
    log in — the same destination, a worse trip, but better than no button.
    """
    if not SITE_BASE:
        return None
    if _miniapp_ok():
        return {"text": label, "web_app": {"url": f"{SITE_BASE}/dashboard"}}
    return {"text": label, "url": f"{SITE_BASE}/dashboard"}


def _open_kb(label="🚀 Open CodeNest"):
    """A keyboard holding just the launch button, or None."""
    btn = _open_button(label)
    return {"inline_keyboard": [[btn]]} if btn else None


def _menu_buttons():
    """Kept as the name older call sites use; same single button."""
    return _open_kb()


def set_menu_button():
    """Register the persistent 'Open CodeNest' button next to the input box.

    This is the always-available entry point — it does not depend on the user
    finding an old message with an inline button in it.
    """
    if not BOT_TOKEN or not _miniapp_ok():
        return False
    res = _tg("setChatMenuButton", menu_button={
        "type": "web_app",
        "text": "Open CodeNest",
        "web_app": {"url": f"{SITE_BASE}/dashboard"},
    })
    ok = bool((res or {}).get("ok"))
    if not ok:
        print("menu button not set:", res)
    return ok


def _help_text(user):
    """What the bot can do — which is no longer "write code".

    Every command here is read-only or a lifecycle action on an app that
    already exists. Creating and editing happens in the Mini App.
    """
    return (
        f"👋 Hi *{user['username']}*!\n\n"
        "Tap *Open CodeNest* to write, edit and deploy — it opens right here "
        "in Telegram and signs you in automatically.\n\n"
        "*From chat you can also:*\n"
        "`/apps` — everything you have, with live status\n"
        "`/status [name]` — account summary, or one app in full\n"
        "`/logs <name>` — the last lines it printed\n"
        "`/restart <name>`  `/stop <name>`  `/delete <name>`\n"
        "`/rename <name> <new>`\n"
        "`/ping [url]` — check a URL\n"
        "`/unlink` — disconnect this chat\n\n"
        "I message you if an app stops on its own."
    )


def handle_start(chat_id, first_name, payload=""):
    """/start, with or without a deep-link payload.

    Telegram delivers "t.me/<bot>?start=CODE" as the literal message
    "/start CODE" once the user taps START. Handling that payload is what
    turns the old nine-step flow — read a code, leave the site, find the bot,
    retype the code from memory — into two taps. The three steps a human could
    get wrong are exactly the three this removes.

    The payload is redeemed through the SAME redeem_code() the typed command
    uses. A shortcut that took a different path would be a second front door
    with its own rules to get wrong.
    """
    payload = (payload or "").strip()
    if payload:
        # Deliberately BEFORE the already-linked check: someone re-linking a
        # chat should hear that it is already connected, which handle_link
        # says, rather than have their tap silently ignored.
        handle_link(chat_id, f"/link {payload}", first_name)
        return

    user = telegram_link.user_for_chat(chat_id)
    if user:
        _send(chat_id, _help_text(user), reply_markup=_open_kb())
        return

    # UNLINKED: one button, and no instructions at all.
    #
    # There is nothing left to explain. Opening the Mini App verifies the same
    # Telegram identity and writes the same telegram_id the /link code used to
    # write — verified: user_for_chat() returns None before the first open and
    # the account straight after. So the button IS the connect step, and a
    # printed URL would only offer a worse route to the same place (a browser,
    # where the user would have to log in by hand).
    _send(chat_id,
          f"👋 Hi {first_name}!\n\n"
          "Tap below to open CodeNest — writing, editing and deploying all "
          "happen there, and you are signed in automatically.",
          reply_markup=_open_kb())


def handle_unlink(chat_id):
    user = telegram_link.user_for_chat(chat_id)
    if not user:
        _send(chat_id, UNKNOWN_REPLY)
        return
    telegram_link.unlink(user["id"])
    _send(chat_id,
          "🔌 Disconnected. This chat can no longer deploy or see your apps.\n\n"
          "Your apps keep running — nothing was stopped.",
          reply_markup=_menu_buttons())


_link_attempts = defaultdict(list)
LINK_TRIES_PER_HOUR = int(os.getenv("TELEGRAM_LINK_TRIES_PER_HOUR", "8"))


def _link_rate_ok(chat_id):
    now = time.time()
    _link_attempts[chat_id] = [t for t in _link_attempts[chat_id] if now - t < 3600]
    if len(_link_attempts[chat_id]) >= LINK_TRIES_PER_HOUR:
        return False
    _link_attempts[chat_id].append(now)
    return True


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


# ==================== APP BUTTONS ====================
def _app_buttons(job_id, url=""):
    """Buttons keyed on the SITE job id, not the runner id.

    The runner id changes when a job is recreated, so buttons attached to an
    old message silently stopped working. The site id is stable for the life
    of the app, and it is also what scopes every action to its owner.
    """
    rows = [
        [{"text": "📜 Logs", "callback_data": f"logs:{job_id}"},
         {"text": "📊 Status", "callback_data": f"stat:{job_id}"}],
        [{"text": "🔄 Restart", "callback_data": f"restart:{job_id}"},
         {"text": "⏹ Stop", "callback_data": f"stop:{job_id}"}],
        [{"text": "📥 Download data", "callback_data": f"db:{job_id}"}],
    ]
    if url:
        rows.append([{"text": "🌐 Open live URL", "url": url}])
    btn = _open_button("🚀 Open in CodeNest")
    if btn:
        rows.append([btn])
    return {"inline_keyboard": rows}


# Kept under its old name: the reply_markup regression test drives it, and
# that regression (a nested dict urlencoded into "reply_markup=inline_keyboard"
# so every button vanished) is still worth guarding.
def get_job_buttons(runner_id, url):
    return _app_buttons(runner_id, url)


# ==================== APP COMMANDS ====================
def _fmt_uptime(sec):
    sec = int(sec or 0)
    if sec <= 0:
        return "—"
    d, h, m = sec // 86400, (sec % 86400) // 3600, (sec % 3600) // 60
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m {sec % 60}s"


_ICON = {"running": "🟢", "crashed": "🔴", "installing": "🟡",
         "starting": "🟡", "restarting": "🟡", "stopped": "⚪", "offline": "⚪"}


def cmd_apps(chat_id, user):
    apps = bot_ops.list_apps(user["id"])
    if not apps:
        _send(chat_id, "You have no apps yet. Send /code with your source.")
        return
    lines = [f"*Your apps* ({len(apps)}/{bot_ops.MAX_JOBS_PER_USER} running slots)\n"]
    for a in apps:
        icon = _ICON.get(a["status"], "⚪")
        bits = [f"{icon} *{a['name']}* — {a['status']}"]
        if a.get("mem_mb"):
            bits.append(f"{round(a['mem_mb'])}MB")
        if a.get("uptime_s"):
            bits.append(_fmt_uptime(a["uptime_s"]))
        if a.get("restarts"):
            bits.append(f"{a['restarts']}× restarted")
        lines.append(" · ".join(bits))
    lines.append("\n`/logs <name>` `/restart <name>` `/stop <name>`")
    lines.append("`/update <name>` `/rename <name> <new>` `/delete <name>`")
    _send(chat_id, "\n".join(lines))


def cmd_status(chat_id, user, ref=""):
    """Whole-account summary, or one app in full."""
    if ref:
        res = bot_ops.logs(user["id"], ref, lines=0)
        if not res.get("ok"):
            _send(chat_id, f"❌ {res['error']}")
            return
        job, info = res["job"], res["info"]
        icon = _ICON.get(info.get("status"), "⚪")
        txt = [f"{icon} *{job['name']}*",
               f"Status: `{info.get('status', 'unknown')}`",
               f"Language: `{job.get('language') or '—'}`",
               f"Memory: {round(info.get('mem_mb') or 0)}MB now · "
               f"{round(info.get('peak_mem_mb') or 0)}MB peak",
               f"Uptime: {_fmt_uptime(info.get('uptime_s'))}",
               f"Restarts: {info.get('restarts', 0)}"]
        if info.get("last_exit_reason"):
            txt.append(f"Last exit: `{info['last_exit_reason']}`")
        if info.get("libs"):
            txt.append(f"Packages: `{', '.join(info['libs'])}`")
        if info.get("env_keys"):
            # KEY NAMES ONLY — the values are bot tokens.
            txt.append(f"Env keys: `{', '.join(info['env_keys'])}`")
        _send(chat_id, "\n".join(txt),
              reply_markup=_app_buttons(job["id"]))
        return

    apps = bot_ops.list_apps(user["id"])
    running = [a for a in apps if a["status"] == "running"]
    mem = sum(a.get("mem_mb") or 0 for a in apps)
    _send(chat_id,
          f"*{user['username']}*\n\n"
          f"Apps: {len(apps)} · running {len(running)}/{bot_ops.MAX_JOBS_PER_USER}\n"
          f"Memory in use: {round(mem)}MB\n\n"
          "`/apps` for the list · `/status <name>` for one app")


def cmd_logs(chat_id, user, ref):
    if not ref:
        _send(chat_id, "Which app? `/logs <name>` — /apps lists them.")
        return
    res = bot_ops.logs(user["id"], ref)
    if not res.get("ok"):
        _send(chat_id, f"❌ {res['error']}")
        return
    body = res["logs"] or "(no output yet)"
    # Telegram rejects a message over ~4096 chars; trim from the FRONT so the
    # most recent lines — the ones that explain a crash — always survive.
    if len(body) > 3500:
        body = "…\n" + body[-3500:]
    head = "📜 last lines" + (" (trimmed)" if res.get("truncated") else "")
    _send(chat_id, f"*{res['job']['name']}* — {head}\n```\n{body}\n```",
          reply_markup=_app_buttons(res["job"]["id"]))


def cmd_restart(chat_id, user, ref):
    if not ref:
        _send(chat_id, "Which app? `/restart <name>`")
        return
    res = bot_ops.restart(user["id"], ref)
    _send(chat_id, f"🔄 Restarting *{res['job']['name']}*…" if res.get("ok")
          else f"❌ {res['error']}")


def cmd_stop(chat_id, user, ref):
    if not ref:
        _send(chat_id, "Which app? `/stop <name>`")
        return
    res = bot_ops.stop(user["id"], ref)
    _send(chat_id, f"⏹ Stopped *{res['job']['name']}*." if res.get("ok")
          else f"❌ {res['error']}")


def cmd_delete(chat_id, user, ref):
    if not ref:
        _send(chat_id, "Which app? `/delete <name>` — this cannot be undone.")
        return
    res = bot_ops.delete(user["id"], ref)
    _send(chat_id, f"🗑 Deleted *{res['job']['name']}*." if res.get("ok")
          else f"❌ {res['error']}")


def cmd_rename(chat_id, user, args):
    parts = (args or "").split()
    if len(parts) < 2:
        _send(chat_id, "Usage: `/rename <current name> <new name>`")
        return
    res = bot_ops.rename(user["id"], parts[0], " ".join(parts[1:]))
    _send(chat_id, f"✏️ *{res['old']}* is now *{res['name']}*." if res.get("ok")
          else f"❌ {res['error']}")


# ==================== CALLBACK HANDLER ====================
def handle_callback(chat_id, data):
    """Inline buttons. Every action re-resolves the app FOR THIS USER.

    callback_data is attacker-supplied — anyone can craft a button press with
    someone else's job id — so the id is looked up scoped to the pressing
    chat's account, never trusted on its own.
    """
    try:
        action, ref = data.split(":", 1)
    except Exception:
        return
    user = telegram_link.user_for_chat(chat_id)
    if not user:
        return

    if action == "logs":
        cmd_logs(chat_id, user, ref)
    elif action == "stat":
        cmd_status(chat_id, user, ref)
    elif action == "restart":
        cmd_restart(chat_id, user, ref)
    elif action == "stop":
        cmd_stop(chat_id, user, ref)
    elif action == "db":
        _send_job_data(chat_id, user, ref)


def _send_job_data(chat_id, user, ref):
    """Upload the app's data file (SQLite/JSON) to the chat."""
    app = bot_ops.find_app(user["id"], ref)
    if not app:
        _send(chat_id, "❌ That app is not yours or no longer exists.")
        return
    rid = app.get("runner_job_id")
    if not rid:
        _send(chat_id, "❌ That app was never deployed.")
        return
    try:
        r = runner_client._runner_http("GET", f"/internal/jobs/{rid}",
                                       worker=bot_ops._worker_of(app))
        jdir = (r.json() or {}).get("dir") or ""
    except Exception:
        _send(chat_id, "❌ The worker did not answer.")
        return
    if not jdir or not os.path.isdir(jdir):
        # Remote workers do not share a filesystem with this process, so the
        # path is only readable in the embedded/single-service layout. Say so
        # instead of reporting "no database".
        _send(chat_id, "📭 Data files are not reachable from here — "
                       "download them from the dashboard.")
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
        _send(chat_id, "📭 No data file yet — the app has not created one.")
        return
    if best_size > TG_MAX_UPLOAD_BYTES:
        _send(chat_id, f"❌ `{os.path.basename(best)}` is "
                       f"{best_size // (1024 * 1024)}MB — over Telegram's 50MB "
                       f"limit. Download it from the dashboard.")
        return
    _send_document(chat_id, best,
                   caption=f"📥 {os.path.basename(best)} ({best_size} bytes)")


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

                    # /start and /link are the only commands an UNLINKED
                    # chat may use. Everything else needs an account, because
                    # everything else spends the platform's memory.
                    if text.startswith("/start"):
                        # "/start 482913" from a t.me deep link. split(None, 1)
                        # so a payload is taken whole and extra spaces do not
                        # produce a stray empty argument.
                        _parts = text.split(None, 1)
                        handle_start(chat_id, _tg_display(msg) or first_name,
                                     _parts[1] if len(_parts) > 1 else "")

                    elif text.startswith("/link"):
                        handle_link(chat_id, text, _tg_display(msg))

                    elif text.startswith("/unlink"):
                        handle_unlink(chat_id)

                    elif text.startswith("/ping"):
                        if _require_link(chat_id):
                            handle_ping(chat_id, text)

                    # Every command below acts on real apps, so each one is
                    # gated. _cmd_arg() splits off "/logs mybot" -> "mybot".
                    elif text.startswith("/apps") or text.startswith("/jobs"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_apps(chat_id, _u)

                    elif text.startswith("/status"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_status(chat_id, _u, _cmd_arg(text))

                    elif text.startswith("/logs"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_logs(chat_id, _u, _cmd_arg(text))

                    elif text.startswith("/restart"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_restart(chat_id, _u, _cmd_arg(text))

                    elif text.startswith("/stop"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_stop(chat_id, _u, _cmd_arg(text))

                    elif text.startswith("/delete"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_delete(chat_id, _u, _cmd_arg(text))

                    elif text.startswith("/rename"):
                        _u = _require_link(chat_id)
                        if _u:
                            cmd_rename(chat_id, _u, _cmd_arg(text))

                    elif text.startswith("/help"):
                        handle_start(chat_id, _tg_display(msg) or first_name)

                    # No plain-text branch. A message that is not a command
                    # used to become a deploy; now nothing does, so pasted
                    # code cannot reach the runner by any path.
                    else:
                        _send(chat_id, UNKNOWN_REPLY,
                              reply_markup=_open_kb())

                elif "callback_query" in upd:
                    # Buttons are as powerful as commands — Restart and
                    # Download DB both act on a real job — and callback_data
                    # is attacker-supplied, so the same gate applies here.
                    cb = upd["callback_query"]
                    cb_chat = cb["message"]["chat"]["id"]
                    if telegram_link.user_for_chat(cb_chat):
                        handle_callback(cb_chat, cb["data"])
                    _tg("answerCallbackQuery", callback_query_id=cb["id"])

        except Exception as e:
            print("Poll error:", e)
            time.sleep(3)


def start_bot():
    if not BOT_TOKEN:
        print("TELEGRAM_PING_BOT_TOKEN not set")
        return

    # ASK TELEGRAM WHO WE ARE, ONCE, AT BOOT.
    #
    # A token belonging to a different bot than the Mini App is opened from
    # produces bad_hash, and nothing in the running system could say so — the
    # only way to find out was to open the app, fail, read the log, and guess.
    # getMe answers it in one call at startup, so the fact is in the logs
    # before anyone tries to sign in.
    try:
        from services import miniapp_auth
        who = miniapp_auth.whoami()
        if who.get("ok"):
            logger.warning(
                "TELEGRAM BOT: this server is @%s (id %s). The Mini App must be "
                "opened from THIS bot, or sign-in fails with bad_hash.",
                who.get("username"), who.get("bot_id"))
            env_name = os.getenv("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")
            if env_name and env_name.lower() != (who.get("username") or "").lower():
                logger.error(
                    "TELEGRAM MISCONFIGURED: TELEGRAM_BOT_USERNAME is @%s but the "
                    "token belongs to @%s. These must be the same bot.",
                    env_name, who.get("username"))
        else:
            logger.error(
                "TELEGRAM TOKEN REJECTED by getMe (%s). Sign-in will fail until "
                "TELEGRAM_PING_BOT_TOKEN is a valid token: %s",
                who.get("reason"), who.get("detail", ""))
    except Exception as exc:  # noqa: BLE001
        logger.warning("bot identity check skipped: %s", exc)

    # Register the persistent Mini App button before polling starts, so the
    # entry point exists even for a user who never sends a command.
    try:
        set_menu_button()
    except Exception as exc:  # noqa: BLE001
        print("menu button registration failed:", exc)
    t = threading.Thread(target=poll_loop, daemon=True)
    t.start()
    print("✅ Advanced Bot started (with 5s buffer + inline controls)")