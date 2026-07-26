# CodeNest — Auth + Abuse Prevention: build plan & audit

Implemented in 6 sequential steps, each tested before the next begins.

## Pre-flight audit (what actually existed on `main`)

| Area | Claimed | Reality found |
|---|---|---|
| Telegram login | done | HMAC crashed (500) — **fixed previous turn**; widget never rendered |
| Gmail-only + OTP | done | Gmail check OK, but **all signups returned "CAPTCHA verification failed"** |
| Fingerprint capture | "PRIMARY defense" | Frontend sent it; `UserSignup` had no such field → Pydantic dropped it → **never stored** |
| Fingerprint job limit | done | Query used `j.status` — **column does not exist** → SQL error on every job start with a fingerprint |
| IP aggregate cap | — | did not exist |
| CAPTCHA | math question | input existed in HTML but **JS never read it** → hard-blocked every signup |
| Signup velocity | 10/IP/day | present; no burst flagging |
| Admin clusters | done | `/admin/fingerprint-clusters` **defined twice**; no IP view, no job counts |

### Root cause of the signup outage
`routes/deps.py: UserSignup` did not declare `captcha` or `fingerprint`.
Pydantic silently drops undeclared fields, so `getattr(user, 'captcha', None)`
was always `None`, and `None != "12"` rejected **every** signup — including
correct ones. The same mechanism discarded the fingerprint the browser sent.

---

## Step order (per master prompt §7)

- **Step 1** — Telegram login end-to-end (signup / login / existing-ID reuse)
- **Step 2** — Email+password, Gmail-only, OTP; both methods coexist
- **Step 3** — Device fingerprint captured on BOTH methods, per account + session
- **Step 4** — Job limits: fingerprint-level (3) + IP-level (9)
- **Step 5** — CAPTCHA (Turnstile/hCaptcha + math fallback) + velocity/burst flags
- **Step 6** — Admin visibility: fingerprint clusters, IP clusters, burst flags

Test results for each step are appended below as they complete.
