"""Verification for Telegram Mini App `initData`.

WHY THIS IS NOT /auth/telegram
------------------------------
The Login Widget and the Mini App both prove the same Telegram identity, but
they derive the HMAC key differently. Demonstrated on the same data-check
string with the same bot token:

    Login Widget  secret = sha256(token)                  -> b1a8455e4830…
    Mini App      secret = HMAC("WebAppData", token)      -> 3b019fac3ba6…

So initData posted to /auth/telegram is rejected as tampered. A separate
verifier is required; reusing the old one would either fail every Mini App
login or, if "fixed" by loosening the check, accept forged data.

WHAT initData IS
----------------
A urlencoded query string Telegram hands the webview, e.g.

    user=%7B%22id%22%3A555%2C...%7D&chat_instance=-1&auth_date=1700000000&hash=abc

Every field except `hash` (and `signature`, which is Ed25519 for third-party
validation and explicitly excluded) goes into the data-check string as
"key=value" lines sorted by key and joined with \n.
"""
import hashlib
import hmac
import json
import logging
import os
import time
from urllib.parse import parse_qsl

logger = logging.getLogger("codenest-app")

# Telegram signs auth_date, so without an age limit a leaked initData string
# would be a permanent credential. Telegram's own guidance is to bound it;
# a Mini App session is refreshed on every open, so this can be tight.
INITDATA_MAX_AGE_S = int(os.getenv("MINIAPP_INITDATA_MAX_AGE_S", "86400"))
# Clock skew allowance for a device running slightly ahead of the server.
_FUTURE_SKEW_S = 300


def _bot_token() -> str:
    return os.getenv("TELEGRAM_PING_BOT_TOKEN", "").strip()


def verify_init_data(init_data: str, token: str = None) -> dict:
    """Validate initData and return the Telegram user, or raise ValueError.

    Returns {"id": int, "first_name": str, "username": str, "auth_date": int,
             "raw": {...}}.
    """
    token = token if token is not None else _bot_token()
    if not token:
        raise ValueError("not_configured")
    if not init_data or not isinstance(init_data, str):
        raise ValueError("empty")
    # A whole initData string is small; anything large is someone probing.
    if len(init_data) > 8192:
        raise ValueError("too_large")

    # keep_blank_values: Telegram includes empty fields, and dropping them
    # changes the data-check string and therefore the hash.
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=True))
    except ValueError:
        raise ValueError("malformed")

    received_hash = pairs.pop("hash", "")
    if not received_hash:
        raise ValueError("no_hash")
    # `signature` is Telegram's Ed25519 field for THIRD-PARTY validation. It is
    # not part of the HMAC data-check string, and leaving it in makes every
    # verification fail once Telegram starts sending it.
    pairs.pop("signature", None)

    data_check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
    # compare_digest, not ==: a plain comparison leaks the position of the
    # first mismatching byte through timing.
    if not hmac.compare_digest(expected, received_hash):
        raise ValueError("bad_hash")

    try:
        auth_date = int(pairs.get("auth_date") or 0)
    except ValueError:
        raise ValueError("bad_auth_date")
    age = time.time() - auth_date
    if auth_date <= 0 or age > INITDATA_MAX_AGE_S:
        raise ValueError("expired")
    if age < -_FUTURE_SKEW_S:
        raise ValueError("future")

    raw_user = pairs.get("user") or ""
    if not raw_user:
        # Happens when the Mini App is opened from an inline query or a channel
        # rather than a private chat. There is no user to log in as.
        raise ValueError("no_user")
    try:
        user = json.loads(raw_user)
    except Exception:
        raise ValueError("bad_user_json")
    tg_id = user.get("id")
    if not isinstance(tg_id, int) or tg_id <= 0:
        raise ValueError("bad_user_id")

    return {
        "id": tg_id,
        "first_name": (user.get("first_name") or "").strip()[:64],
        "last_name": (user.get("last_name") or "").strip()[:64],
        "username": (user.get("username") or "").strip()[:64],
        "photo_url": (user.get("photo_url") or "").strip()[:500],
        "auth_date": auth_date,
        "raw": user,
    }


def display_name(user: dict) -> str:
    """The label cached on the account, matching what the bot stores."""
    if user.get("username"):
        return "@" + user["username"]
    name = " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x)
    return name.strip()[:80]
