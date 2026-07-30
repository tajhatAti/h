"""Auth: availability, signup, email OTP, resend, login, logout,
password reset, and TOTP two-factor authentication."""
from typing import Optional, List

from fastapi import APIRouter, Header, HTTPException, Request

from routes.deps import *  # shared kernel (config, helpers, models)


import io
import base64

import pyotp
import qrcode

from services import email as email_service
from services.twofa import _verify_second_factor

router = APIRouter()


class AvailabilityCheck(BaseModel):
    username: Optional[str] = None
    email: Optional[str] = None


@router.post("/auth/check-availability")
def check_availability(payload: AvailabilityCheck, request: Request):
    """Early duplicate check for the sign-up form (on blur / before submit).

    Returns which of the two fields is taken by a VERIFIED account, so the UI
    can say \"already registered\" — unverified leftovers don't count as taken,
    matching the /signup rule that refreshes them instead of blocking.
    """
    rate_limit(f"{client_ip(request)}:avail")
    username = (payload.username or "").strip()
    email = (payload.email or "").strip().lower()

    username_taken = False
    email_taken = False
    conn = get_db_connection()
    try:
        if username:
            row = conn.execute(
                "SELECT is_verified FROM users WHERE username = ?", (username,)
            ).fetchone()
            username_taken = bool(row and row["is_verified"] == 1)
        if email:
            row = conn.execute(
                "SELECT is_verified FROM users WHERE email = ?", (email,)
            ).fetchone()
            email_taken = bool(row and row["is_verified"] == 1)
    finally:
        conn.close()

    return {"username_taken": username_taken, "email_taken": email_taken}


@router.post("/signup")
def signup(user: UserSignup, request: Request):
    rate_limit(f"{client_ip(request)}:signup")
    rate_limit_custom(
        f"{client_ip(request)}:signup:daily", 86400, SIGNUP_DAILY_MAX,
        "Too many new accounts from this network today. Please try again tomorrow.")
    if user.agreed_terms is not True:
        raise HTTPException(status_code=400, detail="Please accept the Terms of Use to create an account.")

    # CAPTCHA removed: the arithmetic question stopped no real abuse and cost
    # every genuine user a step. Signup is still protected by the per-IP daily
    # cap (SIGNUP_DAILY_MAX), the rate limiter, and e-mail OTP verification —
    # an address must be real and reachable before the account works.
    # services/captcha.py is kept so a provider can be re-enabled if needed.

    # Device fingerprint (§3) — stored on the account so §4 can aggregate job
    # counts across every account that shares this device.
    fingerprint = normalise_fingerprint(user.fingerprint)

    username = validate_username(user.username)
    email = str(user.email).strip().lower()
    domain = email.rsplit("@", 1)[-1]

    # Gmail-only: compare the FULL domain, never a suffix. endswith("@gmail.com")
    # would happily accept "evil@notgmail.com" — a lookalike bypass.
    if domain not in GMAIL_DOMAINS:
        raise HTTPException(
            status_code=400,
            detail="Only Gmail addresses are supported for email sign-up. "
                   "You can also sign in with Telegram.",
        )

    # Defense-in-depth: the blocklist can no longer be reached through a normal
    # Gmail address, but it still guards against lookalike/punycode tricks and
    # stays in place if the Gmail-only rule is ever relaxed.
    if domain in DISPOSABLE_EMAIL_DOMAINS:
        raise HTTPException(status_code=400, detail="Disposable email addresses are not allowed.")
    password = validate_password(user.password)

    otp = generate_otp()
    hashed_pw = hash_password(password)
    current_time = now_utc_str()

    conn = get_db_connection()
    cursor = conn.cursor()
    inserted_user_id = None

    try:
        existing = cursor.execute(
            "SELECT id, username, email, is_verified FROM users WHERE username = ? OR email = ?",
            (username, email),
        ).fetchone()

        if existing:
            if existing["is_verified"] == 1:
                # Genuinely taken by an active account -> cannot reuse.
                raise HTTPException(status_code=400, detail="Username or email is already taken.")
            # Unverified account from an incomplete signup (e.g. the user lost
            # the OTP page while checking mail). Don't block them: refresh the
            # OTP + password and re-send, so they can finish verifying instead
            # of being stuck on "already taken".
            otp = generate_otp()
            current_time = now_utc_str()
            cursor.execute("""
                UPDATE users SET password=?, otp=?, otp_created_at=?, agreed_terms_at=?,
                    updated_at=?, fingerprint=COALESCE(NULLIF(?, ''), fingerprint), last_ip=?
                WHERE id=?
            """, (hashed_pw, otp, current_time, current_time, current_time,
                  fingerprint, client_ip(request), existing["id"]))
            conn.commit()
            record_signup_attempt(fingerprint)
            email_service.send_email(email, "Verify your CodeNest account", otp, username, "Email Verification")
            return {
                "message": "Welcome back! A fresh verification code was sent to your email.",
                "resent": True,
                "expires_in": OTP_EXPIRY_MINUTES * 60,
            }

        cursor.execute("""
            INSERT INTO users (username, email, password, otp, otp_created_at,
                is_verified, created_at, updated_at, agreed_terms_at,
                fingerprint, last_ip)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        """, (username, email, hashed_pw, otp, current_time, current_time,
              current_time, current_time, fingerprint, client_ip(request)))
        conn.commit()
        inserted_user_id = cursor.lastrowid
        record_signup_attempt(fingerprint)

        email_service.send_email(email, "Verify your CodeNest account", otp, username, "Email Verification")
        return {"message": "Account created. Check your email for the verification code.", "expires_in": OTP_EXPIRY_MINUTES * 60}

    except HTTPException:
        if inserted_user_id:
            cursor.execute("DELETE FROM users WHERE id = ?", (inserted_user_id,))
            conn.commit()
        raise
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="Username or email is already taken.")
    finally:
        conn.close()


@router.post("/resend-otp")
def resend_otp(payload: ResendOTP, request: Request):
    username = validate_username(payload.username)
    rate_limit(f"{client_ip(request)}:resend:{username}")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        row = cursor.execute("SELECT id, email, is_verified FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")
        if row["is_verified"] == 1:
            return {"message": "Account is already verified."}

        new_otp = generate_otp()
        current_time = now_utc_str()
        cursor.execute("UPDATE users SET otp=?, otp_created_at=?, updated_at=? WHERE id=?",
                        (new_otp, current_time, current_time, row["id"]))
        conn.commit()

        email_service.send_email(row["email"], "Your new verification code", new_otp, username, "Email Verification")
        return {"message": "A new code has been sent to your email.", "expires_in": OTP_EXPIRY_MINUTES * 60}
    finally:
        conn.close()


@router.post("/verify")
def verify_otp(user: UserVerify, request: Request):
    username = validate_username(user.username)
    otp = user.otp.strip()
    rate_limit(f"{client_ip(request)}:verify:{username}")

    if not otp.isdigit() or len(otp) != 6:
        raise HTTPException(status_code=400, detail="Code must be 6 digits.")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        row = cursor.execute(
            "SELECT id, otp, otp_created_at, otp_attempts, is_verified, username, email FROM users WHERE username = ?", (username,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")

        if row["is_verified"] == 0:
            db_otp = row["otp"]
            otp_created_at = row["otp_created_at"]
            if not db_otp or not otp_created_at:
                raise HTTPException(status_code=400, detail="No active code found. Please resend.")

            created_time = datetime.fromisoformat(otp_created_at)
            if now_utc() > created_time + timedelta(minutes=OTP_EXPIRY_MINUTES):
                raise HTTPException(status_code=400, detail="Code has expired. Please resend.")
            if db_otp != otp:
                # Wrong-code limiter, server-side: after MAX_OTP_ATTEMPTS wrong
                # tries the code is invalidated and a fresh one is required.
                attempts = (row["otp_attempts"] or 0) + 1
                if attempts >= MAX_OTP_ATTEMPTS:
                    cursor.execute(
                        "UPDATE users SET otp=NULL, otp_created_at=NULL, otp_attempts=0, updated_at=? WHERE id=?",
                        (now_utc_str(), row["id"]))
                    conn.commit()
                    raise HTTPException(status_code=400, detail="Too many incorrect attempts — please request a new code.")
                cursor.execute("UPDATE users SET otp_attempts=?, updated_at=? WHERE id=?",
                               (attempts, now_utc_str(), row["id"]))
                conn.commit()
                raise HTTPException(status_code=400, detail="Incorrect code.")

            cursor.execute("""
                UPDATE users SET is_verified=1, otp=NULL, otp_created_at=NULL, otp_attempts=0, updated_at=?
                WHERE id=?
            """, (now_utc_str(), row["id"]))
            conn.commit()
            record_login_attempt(row["id"], request, success=True, location="Email verification")

        # Auto-login: create a session immediately after successful verification
        _grant_admin_if_configured(row["id"], row["email"])
        token = create_session(row["id"], request, fingerprint=user.fingerprint or "")
        return {"message": "Verification successful!", "token": token, "username": row["username"]}
    finally:
        conn.close()


# ----------------------------
# Login / Logout / Sessions
# ----------------------------
@router.post("/login")
def login(user: UserLogin, request: Request):
    identifier = user.username.strip()
    rate_limit(f"{client_ip(request)}:login:{identifier.lower()}")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        if "@" in identifier:
            row = cursor.execute(
                "SELECT id, username, password, is_verified, email, is_suspended FROM users WHERE email = ?", (identifier.lower(),)
            ).fetchone()
        else:
            row = cursor.execute(
                "SELECT id, username, password, is_verified, email, is_suspended FROM users WHERE username = ?", (identifier,)
            ).fetchone()

        if not row or not verify_password(user.password, row["password"]):
            # Record the failed attempt if we could identify the account.
            if row:
                record_login_attempt(row["id"], request, success=False)
            raise HTTPException(status_code=400, detail="Incorrect username/email or password.")
        if row["is_verified"] == 0:
            # Correct credentials, but email not verified yet. Instead of an
            # error, route them straight to verification so they can finish
            # without having to re-signup.
            remaining = OTP_EXPIRY_MINUTES * 60
            try:
                r2 = cursor.execute("SELECT otp_created_at FROM users WHERE id = ?", (row["id"],)).fetchone()
                if r2 and r2["otp_created_at"]:
                    created = datetime.fromisoformat(r2["otp_created_at"])
                    remaining = max(0, OTP_EXPIRY_MINUTES * 60 - int((now_utc() - created).total_seconds()))
            except Exception:
                pass
            return {
                "need_verify": True,
                "username": row["username"],
                "message": "Please verify your email to continue. A code was sent when you signed up.",
                "expires_in": remaining,
            }
        if "is_suspended" in row.keys() and row["is_suspended"]:
            raise HTTPException(
                status_code=403,
                detail="This account is suspended. If you think this is a mistake, contact the site owner.")
    finally:
        conn.close()

    record_login_attempt(row["id"], request, success=True)
    _grant_admin_if_configured(row["id"], row["email"])
    token = create_session(row["id"], request, fingerprint=user.fingerprint or "")
    return {"message": "Login successful!", "username": row["username"], "token": token}


@router.post("/logout")
def logout(authorization: Optional[str] = Header(None)):
    # Idempotent: a double-click, a stale tab, or an already-expired session
    # must NEVER surface "Session expired" — the user asked to be logged out,
    # and being logged out is the end state either way.
    if not authorization:
        return {"message": "Logged out successfully."}
    token = authorization.replace("Bearer ", "").strip()
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT id, user_id FROM sessions WHERE token = ?", (token,)).fetchone()
        if row:
            # activity-trail entry first — after the session is gone the
            # client can't post it (and shouldn't see a 401 for trying)
            conn.execute(
                "INSERT INTO activity_log (user_id, action, details, created_at) VALUES (?,?,?,?)",
                (row["user_id"], "info:Signed out", "Session ended", now_utc_str()))
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        return {"message": "Logged out successfully."}
    finally:
        conn.close()




@router.post("/forgot-password")
def forgot_password(payload: ForgotPasswordRequest, request: Request):
    email = str(payload.email).strip().lower()
    rate_limit(f"{client_ip(request)}:forgot:{email}")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        row = cursor.execute("SELECT id, username FROM users WHERE email = ?", (email,)).fetchone()
        if not row:
            return {"message": "If this email exists, a reset code has been sent."}

        otp = generate_otp()
        current_time = now_utc_str()
        cursor.execute("""
            UPDATE users SET reset_otp=?, reset_otp_created_at=?, reset_verified=0, updated_at=?
            WHERE id=?
        """, (otp, current_time, current_time, row["id"]))
        conn.commit()

        email_service.send_email(email, "Reset your CodeNest password", otp, row["username"], "Password Reset")
        return {"message": "If this email exists, a reset code has been sent.", "expires_in": OTP_EXPIRY_MINUTES * 60}
    finally:
        conn.close()


@router.post("/verify-reset-otp")
def verify_reset_otp(payload: VerifyResetOTP, request: Request):
    email = str(payload.email).strip().lower()
    otp = payload.otp.strip()
    rate_limit(f"{client_ip(request)}:resetverify:{email}")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        row = cursor.execute(
            "SELECT id, reset_otp, reset_otp_created_at, reset_otp_attempts FROM users WHERE email = ?", (email,)
        ).fetchone()
        if not row or not row["reset_otp"]:
            raise HTTPException(status_code=400, detail="Please request a reset code first.")

        created_time = datetime.fromisoformat(row["reset_otp_created_at"])
        if now_utc() > created_time + timedelta(minutes=OTP_EXPIRY_MINUTES):
            raise HTTPException(status_code=400, detail="Code has expired. Please request a new one.")
        if row["reset_otp"] != otp:
            attempts = (row["reset_otp_attempts"] or 0) + 1
            if attempts >= MAX_OTP_ATTEMPTS:
                cursor.execute(
                    "UPDATE users SET reset_otp=NULL, reset_otp_created_at=NULL, reset_otp_attempts=0, updated_at=? WHERE id=?",
                    (now_utc_str(), row["id"]))
                conn.commit()
                raise HTTPException(status_code=400, detail="Too many incorrect attempts — please request a new code.")
            cursor.execute("UPDATE users SET reset_otp_attempts=?, updated_at=? WHERE id=?",
                           (attempts, now_utc_str(), row["id"]))
            conn.commit()
            raise HTTPException(status_code=400, detail="Incorrect code.")

        cursor.execute("UPDATE users SET reset_verified=1, reset_otp_attempts=0, updated_at=? WHERE id=?", (now_utc_str(), row["id"]))
        conn.commit()
        return {"message": "Code verified. You can now set a new password."}
    finally:
        conn.close()


@router.post("/reset-password")
def reset_password(payload: ResetPassword, request: Request):
    email = str(payload.email).strip().lower()
    new_password = validate_password(payload.new_password)
    rate_limit(f"{client_ip(request)}:resetpw:{email}")

    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        row = cursor.execute(
            "SELECT id, reset_otp, reset_verified FROM users WHERE email = ?", (email,)
        ).fetchone()
        if not row or row["reset_verified"] != 1 or row["reset_otp"] != payload.otp.strip():
            raise HTTPException(status_code=400, detail="Please verify the reset code first.")

        hashed_pw = hash_password(new_password)
        cursor.execute("""
            UPDATE users SET password=?, reset_otp=NULL, reset_otp_created_at=NULL,
                reset_verified=0, password_changed_at=?, updated_at=?
            WHERE id=?
        """, (hashed_pw, now_utc_str(), now_utc_str(), row["id"]))
        # Reset password -> log out of all devices for safety
        cursor.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
        conn.commit()
        return {"message": "Password updated successfully. Please sign in again."}
    finally:
        conn.close()


# ----------------------------
# Profile
# ----------------------------


# ----------------------------
# Two-Factor Authentication (2FA)
# ----------------------------
@router.get("/2fa/status")
def get_2fa_status(authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM user_2fa WHERE user_id = ?", (user["id"],)).fetchone()
        if not row:
            return {"enabled": False, "backup_codes_count": 0}
        return {
            "enabled": bool(row["is_enabled"]),
            "backup_codes_count": len(json.loads(row["backup_codes"] or "[]"))
        }
    finally:
        conn.close()


@router.post("/2fa/setup")
def setup_2fa(payload: TwoFactorSetup, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        current_time = now_utc_str()
        
        if payload.enable:
            # Generate new TOTP secret
            secret = pyotp.random_base32()
            
            # Generate backup codes (10 × single-use)
            backup_codes = [secrets.token_hex(8) for _ in range(10)]
            
            # Store temporarily (not enabled yet)
            if DIALECT == "postgres":
                conn.execute("""
                    INSERT INTO user_2fa (user_id, secret, is_enabled, backup_codes, created_at, updated_at)
                    VALUES (?, ?, 0, ?, ?, ?)
                    ON CONFLICT (user_id) DO UPDATE SET
                        secret = EXCLUDED.secret,
                        is_enabled = 0,
                        backup_codes = EXCLUDED.backup_codes,
                        updated_at = EXCLUDED.updated_at
                """, (user["id"], secret, json.dumps(backup_codes), current_time, current_time))
            else:
                conn.execute("""
                    INSERT OR REPLACE INTO user_2fa (user_id, secret, is_enabled, backup_codes, created_at, updated_at)
                    VALUES (?, ?, 0, ?, ?, ?)
                """, (user["id"], secret, json.dumps(backup_codes), current_time, current_time))
            conn.commit()
            
            # Generate QR code
            totp = pyotp.TOTP(secret)
            uri = totp.provisioning_uri(name=user["username"], issuer_name="CodeNest")
            
            # Generate QR image
            qr = qrcode.QRCode(version=1, box_size=10, border=4)
            qr.add_data(uri)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            
            buffer = io.BytesIO()
            img.save(buffer, format="PNG")
            qr_base64 = base64.b64encode(buffer.getvalue()).decode()
            
            return {
                "secret": secret,
                "qr_code": f"data:image/png;base64,{qr_base64}",
                "backup_codes": backup_codes,
                "message": "Scan the QR code with your authenticator app"
            }
        else:
            # Disabling 2FA is a sensitive action — it MUST go through
            # /2fa/disable, which re-verifies password + a current code.
            raise HTTPException(
                status_code=400,
                detail="To disable 2FA, confirm with your password and an authenticator code."
            )
    finally:
        conn.close()


@router.post("/2fa/disable")
def disable_2fa(payload: TwoFactorConfirm, authorization: Optional[str] = Header(None)):
    """Disable 2FA — requires the account password AND a valid current
    authenticator (or backup) code. One-click disable is never allowed."""
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        if not verify_password(payload.password, user["password"]):
            raise HTTPException(status_code=400, detail="Incorrect password.")
        _verify_second_factor(conn, user["id"], payload.code)
        conn.execute("DELETE FROM user_2fa WHERE user_id = ?", (user["id"],))
        conn.commit()
        _log_security_event(conn, user["id"], "2fa_disabled", "Two-factor authentication was disabled")
        return {"message": "Two-factor authentication disabled."}
    finally:
        conn.close()


@router.post("/2fa/backup-codes")
def regenerate_backup_codes(payload: TwoFactorConfirm, authorization: Optional[str] = Header(None)):
    """Mint 10 fresh single-use backup codes (old ones stop working).
    Requires password + a valid current authenticator code."""
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        if not verify_password(payload.password, user["password"]):
            raise HTTPException(status_code=400, detail="Incorrect password.")
        _verify_second_factor(conn, user["id"], payload.code)
        codes = [secrets.token_hex(8) for _ in range(10)]
        conn.execute("UPDATE user_2fa SET backup_codes=?, updated_at=? WHERE user_id=?",
                     (json.dumps(codes), now_utc_str(), user["id"]))
        conn.commit()
        _log_security_event(conn, user["id"], "2fa_backup_regenerated", "Backup codes were regenerated")
        return {"backup_codes": codes, "message": "New backup codes generated."}
    finally:
        conn.close()


@router.post("/2fa/verify-setup")
def verify_2fa_setup(payload: TwoFactorVerify, authorization: Optional[str] = Header(None)):
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM user_2fa WHERE user_id = ?", (user["id"],)).fetchone()
        if not row or not row["secret"]:
            raise HTTPException(status_code=400, detail="2FA setup not initiated")
        
        if row["is_enabled"]:
            raise HTTPException(status_code=400, detail="2FA is already enabled")
        
        totp = pyotp.TOTP(row["secret"])
        # valid_window=1: tolerate a few seconds of phone clock drift (RFC 6238)
        if not totp.verify(payload.code, valid_window=1):
            raise HTTPException(status_code=400, detail="Invalid verification code")
        
        # Enable 2FA
        conn.execute("UPDATE user_2fa SET is_enabled=1, updated_at=? WHERE user_id=?",
                     (now_utc_str(), user["id"]))
        conn.commit()
        _log_security_event(conn, user["id"], "2fa_enabled", "Two-factor authentication was enabled")

        # Hand the freshly-minted backup codes to the final setup screen so
        # the user can download/copy them (this is the ONLY time they see them).
        codes = json.loads(row["backup_codes"] or "[]")
        return {"message": "2FA enabled successfully!", "backup_codes": codes}
    finally:
        conn.close()


@router.post("/2fa/verify-login")
def verify_2fa_login(payload: TwoFactorVerify, authorization: Optional[str] = Header(None)):
    """Verify 2FA code during login when 2FA is enabled"""
    user, _ = get_current_user_and_session(authorization)
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM user_2fa WHERE user_id = ?", (user["id"],)).fetchone()
        if not row or not row["is_enabled"]:
            raise HTTPException(status_code=400, detail="2FA not enabled")
        
        # Check if it's a backup code
        backup_codes = json.loads(row["backup_codes"] or "[]")
        if payload.code in backup_codes:
            # Remove used backup code
            backup_codes.remove(payload.code)
            conn.execute("UPDATE user_2fa SET backup_codes=? WHERE user_id=?", 
                         (json.dumps(backup_codes), user["id"]))
            conn.commit()
            return {"message": "Backup code accepted", "backup_codes_remaining": len(backup_codes)}
        
        # Verify TOTP (valid_window=1 for clock drift, RFC 6238)
        totp = pyotp.TOTP(row["secret"])
        if not totp.verify(payload.code, valid_window=1):
            raise HTTPException(status_code=400, detail="Invalid 2FA code")
        
        return {"message": "2FA verified successfully"}
    finally:
        conn.close()


# ----------------------------
# Login History
# ----------------------------


# ----------------------------\n# Telegram Login (Widget)\n# ----------------------------\n
import hashlib
import hmac

class TelegramAuthData(BaseModel):
    id: int
    first_name: str
    username: Optional[str] = None
    photo_url: Optional[str] = None
    auth_date: int
    hash: str
    fingerprint: Optional[str] = None

def _bot_identity_safe():
    """The cached getMe result, or None. Never raises on the auth path."""
    try:
        from app import _bot_identity
        return _bot_identity()
    except Exception:
        return None


class MiniAppAuth(BaseModel):
    init_data: str
    # The SDK's initData and the URL's tgWebAppData are usually the same
    # string, but some clients decode one of them an extra time and a single
    # differing byte fails the HMAC. The browser sends every form it has;
    # accepting whichever verifies weakens nothing, because a candidate is
    # only accepted if it is validly signed with OUR bot token.
    init_data_alt: Optional[List[str]] = None
    fingerprint: Optional[str] = None


@router.post("/auth/telegram/miniapp")
def telegram_miniapp_login(payload: MiniAppAuth, request: Request):
    """Auto-login for the CodeNest Mini App running inside Telegram.

    SEPARATE FROM /auth/telegram ON PURPOSE. Both prove the same Telegram
    identity, but the HMAC key differs — Login Widget uses sha256(token) while
    the Mini App uses HMAC("WebAppData", token). Verified on the same
    data-check string, the two hashes differ, so initData posted to the widget
    route is rejected as tampered. Loosening that route to accept both would
    mean one endpoint with two trust rules.

    Resolution is IDENTICAL though: same telegram_id, same account, whichever
    door the user came through.
    """
    rate_limit(f"{client_ip(request)}:miniapp_login")

    from services import miniapp_auth
    candidates = [payload.init_data] + list(payload.init_data_alt or [])[:3]
    tg, exc = None, None
    for cand in candidates:
        try:
            tg = miniapp_auth.verify_init_data(cand)
            break
        except ValueError as e:
            # Keep the FIRST failure: it describes the value the client
            # considered authoritative, which is the useful one to report.
            exc = exc or e
    if tg is None:
        reason = str(exc)
        # WARNING, not info: this is the only trace of a user who cannot get in,
        # and info level is routinely filtered out in hosting dashboards. It was
        # invisible exactly when it mattered.
        logger.warning("miniapp auth rejected: %s (tried %d payload form%s)",
                       reason, len(candidates), "" if len(candidates) == 1 else "s")

        if reason == "not_configured":
            # The one failure the OPERATOR causes and can fix, so it is named.
            # Hiding it behind a generic message meant a missing env var looked
            # identical to a forged payload, and the Mini App just said
            # "Couldn't connect" forever with no way to tell which it was.
            raise HTTPException(
                status_code=503,
                detail="Telegram sign-in is not configured on the server "
                       "(TELEGRAM_PING_BOT_TOKEN is missing).")
        if reason == "bad_hash":
            # A rejected signature has exactly two causes and the server cannot
            # tell them apart: a forged payload, or the site verifying with a
            # DIFFERENT bot's token than the one whose Mini App was opened.
            #
            # Naming only the second would MISLEAD a forger — their real
            # problem is that they signed it wrong — so the message states
            # both. It leaks nothing: a forger already knows their hash failed.
            #
            # The BOT ID is included when it is available. A token is
            # "<bot id>:<secret>" and the id half is public — anyone who can
            # message the bot can see it — so printing it lets the owner
            # compare against @BotFather in one glance instead of guessing
            # between four causes that all look identical on a phone. The
            # secret half is never read here.
            shape = miniapp_auth.token_shape()
            hint = ""
            if not shape.get("looks_valid"):
                hint = (" The value in TELEGRAM_PING_BOT_TOKEN is not shaped "
                        "like a bot token — it should look like 123456:ABC-DEF.")
            else:
                # Name the bot, not just its number. "bot ID 8719137492" still
                # left the owner comparing digits by hand against BotFather;
                # an @username is something you can recognise at a glance. The
                # identity is cached from a single getMe at boot, so this adds
                # no network call to a failing request.
                ident = _bot_identity_safe()
                if ident and ident.get("username"):
                    hint = (f" This server only accepts sign-ins from "
                            f"@{ident['username']}. Open the Mini App from "
                            f"that bot.")
                elif shape.get("bot_id"):
                    hint = (f" This server is configured for bot ID "
                            f"{shape['bot_id']}; check that matches the bot "
                            f"you opened this from.")
            # Log the payload's SHAPE. A token that getMe confirms is the right
            # bot, plus a hash that still does not match, means the bytes we
            # signed differ from the bytes Telegram signed — and the field list
            # is the only thing that can show where.
            _age = getattr(exc, "age_s", None)
            _culprit = getattr(exc, "culprit", None)
            logger.warning(
                "miniapp bad_hash: bot_id=%s fields=%s lengths=%s culprit=%s age_s=%s",
                shape.get("bot_id"), getattr(exc, "fields", "?"),
                getattr(exc, "lengths", "?"), _culprit, _age)

            # culprit=None on a FRESH payload is not ambiguous. The field set
            # was ordinary and no field's decoding differs, so the data is
            # right and the KEY is wrong: the token in TELEGRAM_PING_BOT_TOKEN
            # is not the one Telegram signed with. The commonest cause is a
            # token that was revoked and reissued in BotFather — the bot id
            # stays the same, so getMe still succeeds and every id comparison
            # still looks correct, which is exactly why this took so long to
            # pin down.
            # Only when the token is otherwise CREDIBLE. A username pasted in
            # place of a token, or a token whose bot id does not match the one
            # Telegram accepts, has a better explanation already — and the
            # existing messages say it more precisely. This branch is for the
            # one case nothing else can see: a well-formed, live token whose
            # SECRET has been rotated out from under it.
            _tok_ok = bool(shape.get("looks_valid"))
            try:
                _ident = _bot_identity_safe()
            except Exception:
                _ident = None
            _id_agrees = bool(
                _ident and _ident.get("id")
                and str(_ident["id"]) == str(shape.get("bot_id")))
            if (_tok_ok and _id_agrees
                    and _culprit is None and _age is not None and _age < 300):
                logger.error(
                    "TELEGRAM TOKEN IS STALE OR WRONG: the payload is %ss old and "
                    "its field set is normal, so the data is fine and the SECRET "
                    "does not match. Open @BotFather -> /mybots -> your bot -> "
                    "API Token, copy it again, and set TELEGRAM_PING_BOT_TOKEN. "
                    "A revoked token keeps the same bot id, so getMe still "
                    "passes while every sign-in fails.", _age)
                raise HTTPException(
                    status_code=503,
                    detail="The server's Telegram token is out of date. If you "
                           "own this site: copy the API Token again from "
                           "@BotFather and update TELEGRAM_PING_BOT_TOKEN.")
            raise HTTPException(
                status_code=400,
                detail="Telegram could not verify this session." + hint)
        if reason in ("expired", "future"):
            raise HTTPException(
                status_code=400,
                detail="This Telegram session has expired. Close the Mini App "
                       "and open it again.")
        # Malformed / no_user / no_hash: nothing the user can act on, and the
        # detail would only help someone probing.
        raise HTTPException(status_code=400, detail="Could not verify Telegram sign-in.")

    tg_id = tg["id"]
    label = miniapp_auth.display_name(tg)

    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE telegram_id = ?", (tg_id,)).fetchone()
        if row:
            if "is_suspended" in row.keys() and row["is_suspended"]:
                raise HTTPException(status_code=403, detail="Account is suspended.")
            # Refresh the cached handle: a user who changed their @name would
            # otherwise show a stale one in the dashboard and admin console
            # forever, since the bot only writes it at link time.
            if label:
                conn.execute(
                    "UPDATE users SET telegram_name = ?, updated_at = ? WHERE id = ?",
                    (label, now_utc_str(), row["id"]))
                conn.commit()
            token = create_session(row["id"], request,
                                   fingerprint=payload.fingerprint or "")
            return {"message": "Signed in via Telegram", "token": token,
                    "username": row["username"], "created": False}

        # No account for this Telegram id yet. Mirrors /auth/telegram exactly,
        # including the username-clash fallback that used to 500 on a UNIQUE
        # violation.
        base_username = f"tg_{tg_id}"
        username = base_username
        for _attempt in range(6):
            clash = conn.execute("SELECT id FROM users WHERE username = ?",
                                 (username,)).fetchone()
            if not clash:
                break
            username = f"{base_username}_{secrets.token_hex(3)}"
        email = f"tg_{tg_id}@telegram.user"
        password = hash_password(secrets.token_urlsafe(16))
        now = now_utc_str()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, email, password, is_verified, "
            "telegram_id, telegram_name, created_at, updated_at) "
            "VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
            (username, email, password, tg_id, label or None, now, now))
        conn.commit()
        user_id = cursor.lastrowid
    finally:
        conn.close()

    token = create_session(user_id, request, fingerprint=payload.fingerprint or "")
    return {"message": "Account created via Telegram", "token": token,
            "username": username, "created": True}


@router.post("/auth/telegram")
def telegram_login(payload: TelegramAuthData, request: Request):
    rate_limit(f"{client_ip(request)}:telegram_login")

    bot_token = os.getenv("TELEGRAM_PING_BOT_TOKEN", "").strip()
    if not bot_token:
        raise HTTPException(status_code=500, detail="Telegram login not configured.")

    # Verify HMAC-SHA256 over the data-check-string, exactly as Telegram
    # specifies: "key=value" lines for every NON-EMPTY field, sorted by key,
    # joined with \n. Iterating a dict yields KEYS only — unpacking those as
    # (k, v) raised ValueError and turned every login into a 500.
    fields = {
        "auth_date": payload.auth_date,
        "first_name": payload.first_name,
        "id": payload.id,
        "photo_url": payload.photo_url or "",
        "username": payload.username or "",
    }
    secret_key = hashlib.sha256(bot_token.encode()).digest()
    data_check = "\n".join(
        f"{k}={v}" for k, v in sorted(fields.items()) if v not in (None, "")
    )
    calculated_hash = hmac.new(secret_key, data_check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated_hash, payload.hash):
        raise HTTPException(status_code=400, detail="Invalid Telegram authentication data.")

    # Replay protection: Telegram signs auth_date, so a leaked payload would
    # otherwise stay valid forever. Telegram's own guidance is to reject
    # anything older than a day.
    age_s = time.time() - payload.auth_date
    if age_s > 86400 or age_s < -300:
        raise HTTPException(status_code=400, detail="Telegram login expired. Please try again.")

    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE telegram_id = ?", (payload.id,)).fetchone()

        if row:
            # sqlite3.Row has no .get() — use the same key-probe the rest of
            # the codebase uses so this works on SQLite *and* Postgres.
            if "is_suspended" in row.keys() and row["is_suspended"]:
                raise HTTPException(status_code=403, detail="Account is suspended.")
            token = create_session(row["id"], request, fingerprint=payload.fingerprint or "")
            return {"message": "Login successful via Telegram", "token": token, "username": row["username"]}

        # Create new account. The natural username is tg_<id>, but an existing
        # e-mail account may already own that name — fall back to a suffixed
        # variant instead of dying with a UNIQUE-constraint 500.
        base_username = f"tg_{payload.id}"
        username = base_username
        for _attempt in range(6):
            clash = conn.execute(
                "SELECT id FROM users WHERE username = ?", (username,)
            ).fetchone()
            if not clash:
                break
            username = f"{base_username}_{secrets.token_hex(3)}"
        email = f"tg_{payload.id}@telegram.user"
        password = hash_password(secrets.token_urlsafe(16))
        current_time = now_utc_str()

        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO users (username, email, password, is_verified, telegram_id, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?)
        """, (username, email, password, payload.id, current_time, current_time))
        conn.commit()
        user_id = cursor.lastrowid

        token = create_session(user_id, request, fingerprint=payload.fingerprint or "")
        return {"message": "Account created via Telegram", "token": token, "username": username}
    finally:
        conn.close()

