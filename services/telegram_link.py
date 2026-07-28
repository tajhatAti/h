"""Binding a Telegram chat to a CodeNest account.

WHY THIS EXISTS
---------------
services/pingbot.py had no identity check of any kind. Reproduced against the
real dispatch path with an unknown chat id:

    bot replied                        : "send code"
    jobs deployed by an unknown chat   : 1
    payload                            : os.system('whoami')
    rows in the jobs table             : 0

So any stranger who found the bot's username could run code on the server, and
the resulting job never appeared in the admin console because pingbot talks to
the runner directly instead of going through the site.

The fix is a short-lived code the SITE issues to a logged-in user and the BOT
redeems. The site already stores users.telegram_id (routes/auth.py uses it for
Telegram login), so linking writes to a column that exists rather than
inventing a parallel identity.

DESIGN NOTES
------------
* The code is issued to an authenticated web session, never to the chat. A
  code the bot could request would be a code an attacker could request.
* One live code per account: requesting again REPLACES the old row, so a code
  glimpsed over a shoulder cannot be redeemed after the owner moves on.
* Redeeming is rate-limited per code and the code dies after
  MAX_ATTEMPTS wrong tries, so a 6-digit space cannot be walked.
* An unlinked chat gets the SAME reply as an unknown command. Confirming that
  a link step exists tells a stranger the bot is worth attacking.
"""
import logging
import os
import secrets
from datetime import timedelta

from database import get_db_connection
from routes.deps import now_utc, now_utc_str

logger = logging.getLogger("codenest-app")

# Long enough to switch apps and paste, short enough that a code left on a
# screen is not a standing key to the account.
LINK_CODE_TTL_MIN = int(os.getenv("TELEGRAM_LINK_TTL_MIN", "10"))
LINK_CODE_DIGITS = 6
# Telegram's own handle for the bot, e.g. "MyCodeNestBot" (no @). Needed to
# build a t.me deep link; without it the site falls back to telling the user
# to find the bot themselves.
BOT_USERNAME = os.getenv("TELEGRAM_BOT_USERNAME", "").strip().lstrip("@")
# A 6-digit code is 1e6 wide; without a cap a bot could walk it in minutes.
MAX_ATTEMPTS = int(os.getenv("TELEGRAM_LINK_MAX_ATTEMPTS", "5"))


def _now():
    return now_utc()


def issue_code(user_id: int) -> dict:
    """Create (or replace) the pending link code for an account."""
    code = "".join(secrets.choice("0123456789") for _ in range(LINK_CODE_DIGITS))
    expires = (_now() + timedelta(minutes=LINK_CODE_TTL_MIN)).strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db_connection()
    try:
        # Replace rather than accumulate: one account, at most one live code.
        conn.execute("DELETE FROM telegram_link_codes WHERE user_id = ?", (user_id,))
        conn.execute(
            "INSERT INTO telegram_link_codes (user_id, code, expires_at, attempts, created_at) "
            "VALUES (?,?,?,0,?)",
            (user_id, code, expires, now_utc_str()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"code": code, "expires_at": expires, "ttl_min": LINK_CODE_TTL_MIN,
            "deep_link": deep_link(code)}


def deep_link(code: str) -> str:
    """A t.me link that opens the bot and sends the code for the user.

    Telegram's documented mechanism: t.me/<bot>?start=<payload> shows a START
    button, and pressing it delivers "/start <payload>" as a normal message.
    The user never reads, remembers or retypes the code — which removes the
    three steps of the old flow where a person could actually fail.

    The payload is the same one-shot code the typed /link command uses, so
    this adds a shortcut, not a second way in with weaker rules. Telegram
    allows A-Z a-z 0-9 _ - in a start payload; the code is digits only, so it
    passes through untouched.
    """
    if not BOT_USERNAME or not code:
        return ""
    return f"https://t.me/{BOT_USERNAME}?start={code}"


def redeem_code(code: str, telegram_id: int, display_name: str = "") -> dict:
    """Bind a Telegram chat to whichever account issued this code.

    Returns {"ok": True, "username": ...} or {"ok": False, "reason": ...}.
    Reasons are for the SERVER LOG and for the linked-user path only — the bot
    must not narrate them to an unknown chat.
    """
    code = (code or "").strip()
    if not code.isdigit() or len(code) != LINK_CODE_DIGITS:
        return {"ok": False, "reason": "malformed"}

    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT user_id, code, expires_at, attempts FROM telegram_link_codes "
            "WHERE code = ?", (code,)
        ).fetchone()
        if not row:
            return {"ok": False, "reason": "unknown"}
        r = dict(row)

        if r["expires_at"] < _now().strftime("%Y-%m-%d %H:%M:%S"):
            conn.execute("DELETE FROM telegram_link_codes WHERE user_id = ?", (r["user_id"],))
            conn.commit()
            return {"ok": False, "reason": "expired"}

        if r["attempts"] >= MAX_ATTEMPTS:
            conn.execute("DELETE FROM telegram_link_codes WHERE user_id = ?", (r["user_id"],))
            conn.commit()
            return {"ok": False, "reason": "burned"}

        # One Telegram account, one CodeNest account. Without this a single
        # chat could hop between accounts and inherit each one's job quota,
        # which is exactly the multi-account abuse the platform already
        # defends against on the web side.
        taken = conn.execute(
            "SELECT id, username FROM users WHERE telegram_id = ? AND id != ?",
            (telegram_id, r["user_id"]),
        ).fetchone()
        if taken:
            return {"ok": False, "reason": "chat_already_linked",
                    "username": dict(taken)["username"]}

        u = conn.execute("SELECT id, username, is_suspended FROM users WHERE id = ?",
                         (r["user_id"],)).fetchone()
        if not u:
            conn.execute("DELETE FROM telegram_link_codes WHERE user_id = ?", (r["user_id"],))
            conn.commit()
            return {"ok": False, "reason": "unknown"}
        user = dict(u)
        # A suspended account must not gain a NEW way in. The web session is
        # already closed on suspension; leaving the bot open would undo it.
        if user.get("is_suspended"):
            return {"ok": False, "reason": "suspended"}

        # Cache who this is. The dashboard can then say "connected to @ahad"
        # rather than "connected to 111222333", which nobody recognises.
        conn.execute(
            "UPDATE users SET telegram_id = ?, telegram_name = ?, updated_at = ? "
            "WHERE id = ?",
            (telegram_id, (display_name or "").strip()[:80] or None,
             now_utc_str(), user["id"]))
        conn.execute("DELETE FROM telegram_link_codes WHERE user_id = ?", (user["id"],))
        conn.commit()
    finally:
        conn.close()

    logger.info("telegram link: chat %s bound to user %s", telegram_id, user["id"])
    return {"ok": True, "user_id": user["id"], "username": user["username"]}


def note_failed_attempt(code: str) -> None:
    """Count a wrong guess against the code it was aimed at."""
    code = (code or "").strip()
    if not code.isdigit():
        return
    conn = get_db_connection()
    try:
        conn.execute(
            "UPDATE telegram_link_codes SET attempts = attempts + 1 WHERE code = ?",
            (code,),
        )
        conn.commit()
    finally:
        conn.close()


def user_for_chat(telegram_id: int) -> dict:
    """The account this chat speaks for, or None.

    This is the bot's whole authorisation model: no row, no identity, no
    actions. Suspended accounts are treated as unlinked so a suspension takes
    effect on Telegram too, not only on the web.
    """
    if not telegram_id:
        return None
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT id, username, email, is_suspended, is_admin FROM users "
            "WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    u = dict(row)
    if u.get("is_suspended"):
        return None
    return u


def chat_profile(telegram_id: int) -> dict:
    """The cached display name for a linked chat, for the dashboard card."""
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT telegram_name, updated_at FROM users WHERE telegram_id = ?",
            (telegram_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return {}
    r = dict(row)
    return {
        "telegram_name": r.get("telegram_name"),
        "linked_at": r.get("updated_at"),
    }


def unlink(user_id: int) -> None:
    """Drop the binding. Used from account settings and on suspension."""
    conn = get_db_connection()
    try:
        conn.execute(
            "UPDATE users SET telegram_id = NULL, telegram_name = NULL, "
            "updated_at = ? WHERE id = ?", (now_utc_str(), user_id))
        conn.execute("DELETE FROM telegram_link_codes WHERE user_id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()
