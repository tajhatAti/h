/* =========================================
   AHAD CO — RunSpace: free code hosting
   Code Studio · 24/7 jobs · published pages
   ========================================= */

const API = "";
let signupUsername = "";
let authToken = localStorage.getItem("ahad_token") || null;
let resendTimerInterval = null;
let currentTab = "overview";
let editingSnippetId = null;
let _livePreviewTimer = null;


/* ---------------- SCREEN NAV ---------------- */
/* Screens that DO NOT EXIST inside Telegram.
 *
 * app.css hides every one of them under html.tg-no-auth, because a login form
 * is meaningless in a Mini App — the account IS the Telegram account. That
 * rule is right, but seven call sites still ASKED for these screens, and
 * showScreen happily hid the dashboard and then "showed" something the
 * stylesheet keeps at display:none. The result on a phone is a blank page
 * after the words "Session expired" — the exact report, and it survived the
 * previous fix because that fix only touched api(). */
const _TG_FORBIDDEN_SCREENS = {
  "screen-signin": 1, "screen-signup": 1, "screen-otp": 1,
  "screen-forgot1": 1, "screen-forgot2": 1, "screen-forgot3": 1,
  "screen-landing": 1,
};

function showScreen(id) {
  /* ONE CHOKE POINT instead of seven guarded call sites. Every route that
   * wants an auth screen inside Telegram gets the dashboard plus a silent
   * re-login, so no code path can ever paint a hidden screen again. */
  if (window.__inTelegram && _TG_FORBIDDEN_SCREENS[id]) {
    id = "screen-dashboard";
    if (!authToken && typeof window.__tgAutoLogin === "function") {
      // __tgAutoLogin short-circuits on a stored token ("reuse the session").
      // We are here BECAUSE the session failed, so clear it or the reuse
      // shortcut hands back the same dead token and nothing changes.
      try { localStorage.removeItem("ahad_token"); } catch (e) {}
      _tgReauthOnce().then((r) => {
        if (r && r.ok && localStorage.getItem("ahad_token")) {
          authToken = localStorage.getItem("ahad_token");
          if (typeof loadDashboard === "function") loadDashboard().catch(() => {});
        } else {
          _tgFatal((r && r.detail)
            || "Telegram could not sign you in. Close the app and open it "
             + "again from the bot.");
        }
      });
    }
  }

  // Hide all top-level screens (new class names: nav/hero/section/foot/auth/dashboard)
  document.querySelectorAll(".nav, .hero, .section, .foot, .auth, .dashboard").forEach(el => {
    el.classList.add("hidden");
    el.style.display = "none";
  });

  if (id === "screen-landing") {
    const show = (sel) => {
      const el = document.querySelector(sel);
      if (el) { el.classList.remove("hidden"); el.style.display = ""; }
    };
    show(".nav");
    show("#screen-landing");
    document.querySelectorAll(".section").forEach(s => { s.classList.remove("hidden"); s.style.display = ""; });
    show(".foot");
    window.scrollTo({ top: 0 });
    return;
  }

  const target = document.getElementById(id);
  if (target) {
    target.classList.remove("hidden");
    target.style.display = "";
  }
}

/* ---------------- SIDEBAR DRAWER (mobile) ---------------- */
function openSideMenu() {
  const tabs = document.querySelector(".dash-tabs");
  const ov = document.getElementById("sideOverlay");
  if (tabs) tabs.classList.add("open");
  if (ov) ov.classList.remove("hidden");
}
function closeSideMenu() {
  const tabs = document.querySelector(".dash-tabs");
  const ov = document.getElementById("sideOverlay");
  if (tabs) tabs.classList.remove("open");
  if (ov) ov.classList.add("hidden");
}

/* Smooth-scroll to an in-page section (used by the marketing nav links). */
function scrollToId(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth" });
}

function switchTab(tabId) {
  // "more" isn't a real tab — on mobile it opens the LEFT side drawer.
  if (tabId === "more") { openSideMenu(); return; }
  // Leaving RunSpace with the Details drawer open used to strand
  // body.rs-drawer-open (scroll locked) and body.rs-detail-open on the
  // document, which made the next tab feel completely frozen.
  if (tabId !== "jobs" && typeof _jdOpen !== "undefined" && _jdOpen) {
    try { closeJobDetails({noUrl: true}); } catch (e) {}
  }
  if (tabId !== "jobs") {
    document.body.classList.remove("rs-detail-open", "rs-drawer-open");
  }
  // Pseudo-tabs (e.g. the Activity launcher has no data-tab) must NOT
  // blank the dashboard — a missing/unknown tab target = no-op.
  if (!tabId || !document.getElementById(`tab-${tabId}`)) return;
  currentTab = tabId;
  // Leaving the code studio while the editor is fullscreen would trap the
  // overlay over the next section — always collapse it first.
  if (tabId !== "code") exitEditorFullscreen();
  document.querySelectorAll(".dash-tab").forEach(tab => {
    tab.classList.toggle("active", !!tab.dataset.tab && tab.dataset.tab === tabId);
  });
  document.querySelectorAll(".dash-tab-content").forEach(c => c.classList.remove("active"));
  const t = document.getElementById(`tab-${tabId}`);
  t.classList.add("active");
  // Sync mobile bottom-nav highlight (map extra tabs back to "more").
  const map = { profile: "more", admin: "more" };
  document.querySelectorAll(".bn-item").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === (map[tabId] || tabId));
  });
  // ⚡ Jobs tab: live-refresh statuses while it's open, stop polling otherwise.
  if (tabId === "jobs") { startJobPolling(); } else { stopJobPolling(); }
  // Admin console loads fresh every time it's opened (owner-only anyway).
  if (tabId === "admin" && typeof loadAdminPanel === "function") { loadAdminPanel(); }
  if (typeof _admSetPolling === "function") _admSetPolling(tabId === "admin");
  // ⚙️ Settings: keep the security panel truthful every time it opens.
  if (tabId === "profile") { refreshSecurityPanel(); loadSessionsList(); }
  if (tabId === "code") { initCodeMirror(); if (cmEditor) cmEditor.refresh(); }
  // 🔗 Every section is a REAL URL — back/forward + refresh + sharing work.
  if (!_routeNav) {
    const p = TAB_PATHS[tabId];
    if (p) { try { if (_clientPath() !== p) history.pushState({ tab: tabId }, "", p); } catch (e2) {} }
  }
}

/* ---------------- TOAST ---------------- */
/* ---------------- TOAST (single-slot, never stacks) ----------------
   One toast at a time, fixed top-center. Same message again → timer
   resets + a tiny pulse. Different message → content is REPLACED, not
   stacked. Auto-dismiss ~2.8s. Long text clamps to one line; click to
   expand the full detail. */
let _toastEl = null, _toastTimer = null, _toastKey = null;

function toast(message, type = "success") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  // While the server is down the banner already says everything — suppress
  // the wave of identical per-section "Could not load …" toasts.
  if (_netDown && typeof message === "string" && message.indexOf("Could not load") === 0) return;
  const key = type + "|" + message;
  clearTimeout(_toastTimer);

  if (!_toastEl || !document.body.contains(_toastEl)) {
    _toastEl = document.createElement("div");
    container.appendChild(_toastEl);
    _toastEl.addEventListener("click", () => _toastEl.classList.toggle("expanded"));
  }

  const sameAsShowing = (_toastKey === key && _toastEl.classList.contains("show"));
  _toastKey = key;
  _toastEl.className = `toast ${type} show`;
  const icons = { success: "check", error: "x", warning: "alert", info: "info" };
  _toastEl.innerHTML = `<span class="toast-ic">${ic(icons[type] || "info")}</span><span class="toast-msg"></span>`;
  _toastEl.querySelector(".toast-msg").textContent = message;

  if (sameAsShowing) {
    // refresh: brief pulse so repeat actions are visible, never multiplied
    _toastEl.classList.remove("pulse");
    void _toastEl.offsetWidth;
    _toastEl.classList.add("pulse");
  }

  _toastTimer = setTimeout(() => {
    _toastEl.classList.remove("show");
    _toastKey = null;
    setTimeout(() => { if (_toastEl && !_toastEl.classList.contains("show")) { _toastEl.remove(); _toastEl = null; } }, 250);
  }, 2800);
}

/* ---------------- ACTIVITY LOG ---------------- */
// A live, client-side feed of account/security events (kept in localStorage so
// it survives reloads). Mirrors what a user would expect to see on a site like
// GitHub's security log: "verification email sent", "wrong OTP", "sign-in
// successful", "username already taken", etc.
const ACTIVITY_KEY = "ahad_activity_log";
const ACTIVITY_MAX = 60;

function _loadActivity() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "[]"); }
  catch (e) { return []; }
}

function _saveActivity(list) {
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(list.slice(0, ACTIVITY_MAX))); }
  catch (e) {}
}

function logEvent(type, title, meta) {
  // type: success | error | info | warning
  const entry = {
    type: type || "info",
    title: title || "Event",
    meta: meta || "",
    ts: new Date().toISOString(),
  };
  const list = _loadActivity();
  list.unshift(entry);
  _saveActivity(list);
  renderActivity();
  // Mirror to the server-side activity log — that's the source of truth
  // that survives redeploys (localStorage is only a render cache).
  // Fire-and-forget: failures (dead token mid-logout, network blip) must
  // NEVER surface as an unhandled rejection or a scare-toast.
  if (authToken) {
    api("/activity-log", "POST", { action: `${type}:${title}`, details: meta || "" }, true).catch(() => {});
  }
}

function _activityIcon(t) {
  const name = ({ success: "check", error: "x", warning: "alert", info: "info" })[t];
  return name ? ic(name) : '<span class="dot-sq"></span>';
}

function _fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return ""; }
}

function renderActivity() {
  const list = _loadActivity();
  const box = document.getElementById("activityList");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="ap-empty">No activity yet. Events like sign-ups, OTP, and logins will appear here in real time.</div>`;
    return;
  }
  box.innerHTML = list.map(e => `
    <div class="ap-item">
      <div class="ap-ic ${e.type}">${_activityIcon(e.type)}</div>
      <div class="ap-body">
        <div class="ap-title">${escapeHtml(e.title)}</div>
        ${e.meta ? `<div class="ap-meta">${escapeHtml(e.meta)}</div>` : ""}
        <div class="ap-meta">${_fmtTime(e.ts)}</div>
      </div>
    </div>
  `).join("");
}

/* Pull the server's activity log and display THAT — fixes the mismatch
   where stale localStorage entries outlived the accounts on the server. */
async function syncActivityFromServer() {
  if (!authToken) return;
  try {
    const rows = await api("/activity-log", "GET", null, true);
    const arr = Array.isArray(rows) ? rows : (rows.activities || rows.items || []);
    const list = arr.map(r => {
      const a = r.action || "info:Event";
      const i = a.indexOf(":");
      let ts = r.created_at || "";
      if (ts && ts.indexOf("T") === -1) ts = ts.replace(" ", "T") + "Z";
      return { type: i > 0 ? a.slice(0, i) : "info", title: i > 0 ? a.slice(i + 1) : a, meta: r.details || "", ts };
    });
    _saveActivity(list);
    renderActivity();
  } catch (e) { /* keep whatever we have locally */ }
}

/* Wipe leftovers from a previous account before a fresh sign-in. */
function resetLocalActivity() {
  try { localStorage.removeItem(ACTIVITY_KEY); } catch (e) {}
}

function openActivityPanel() {
  const p = document.getElementById("activityPanel");
  const o = document.getElementById("activityOverlay");
  if (p) p.classList.add("open");
  if (o) o.classList.remove("hidden");
  renderActivity();
  syncActivityFromServer();
}

function closeActivityPanel() {
  const p = document.getElementById("activityPanel");
  const o = document.getElementById("activityOverlay");
  if (p) p.classList.remove("open");
  if (o) o.classList.add("hidden");
}

/* ---------------- LEGACY MORE-SHEET (removed) ----------------
   The old bottom "more sheet" duplicated the left drawer AND both could open
   at once (mixed/stale content bug). It's gone from the markup now — these
   shims keep any leftover reference harmless by routing to the real drawer. */
function openMoreSheet() { openSideMenu(); }
function closeMoreSheet() { closeSideMenu(); }

/* ---------------- API HELPER ---------------- */
/* THE MINI APP RE-AUTH LOCK — a shared PROMISE, not a boolean.
 *
 * MY OWN BUG, and it is why "Session expired" kept appearing inside Telegram
 * even after the previous fix. The lock used to be `let _tgReauthInFlight =
 * false`, and the 401 handler read it as:
 *
 *     if (inTelegram && autoLogin && !_tgReauthInFlight) { ...re-auth... }
 *     toast("Session expired. Please sign in again."); location.href = "/";
 *
 * The dashboard fires several authenticated calls AT THE SAME TIME (/profile,
 * /snippets, /stats, /api/jobs). With one dead token they all 401 together:
 *
 *     call #1  flag false -> takes the lock, starts re-auth   (correct)
 *     call #2  flag TRUE  -> skips the branch entirely
 *              -> falls straight through to the browser logout path
 *              -> "Session expired. Please sign in again."
 *              -> location.href = "/" ... where html.tg-no-auth hides
 *                 every sign-in screen. Dead end. Exactly the report.
 *
 * So the guard meant to PREVENT a race caused the failure: the losers of the
 * race were treated as if re-auth had been refused. They must WAIT for the
 * winner instead. A promise does both jobs — only one login is ever sent, and
 * every other caller awaits its result and then retries with the new token. */
let _tgReauthPromise = null;

/* One login for any number of concurrent 401s. */
function _tgReauthOnce() {
  if (_tgReauthPromise) return _tgReauthPromise;          // join the winner
  _tgReauthPromise = (async () => {
    try { return await window.__tgAutoLogin(); }
    catch (e) { return { ok: false, detail: (e && e.message) || "" }; }
    finally {
      // Cleared on the NEXT tick, not immediately: a 401 that lands in the
      // same microtask burst must still join this attempt rather than open a
      // second one.
      setTimeout(() => { _tgReauthPromise = null; }, 0);
    }
  })();
  return _tgReauthPromise;
}

/* `_retried` and `_reauthed` are TWO different budgets on purpose.
 *
 * They used to be one flag, and that is a bug I had to watch happen in the
 * reproduction: the cold-start retry spends `_retried`, so by the time the
 * Telegram re-auth succeeds there is no retry left and the call fails anyway
 * — right after a login that worked. A cold-start retry and a
 * retry-with-a-new-token are different events and each gets one attempt. */
async function api(path, method = "POST", body = null, auth = false,
                   _retried = false, _reauthed = false) {
  const headers = { "Content-Type": "application/json" };
  // Remember WHICH token this request went out with. A 401 only means "the
  // session is dead" if the token is still the current one — see below.
  const sentToken = authToken;
  if (auth && authToken) headers["Authorization"] = "Bearer " + authToken;
  // §4: the server enforces per-device job limits, so authenticated calls
  // carry the device fingerprint. Cached after the first computation — the
  // canvas/audio probes are far too slow to redo on every request.
  if (auth && _fpCache) headers["X-Fingerprint"] = _fpCache;

  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null
    });
  } catch (netErr) {
    // Server down / sleeping (free plan) / no internet — this is INFRA, not
    // a user error. Banner (not 11 racing toasts) + marked error kind so the
    // dashboard keeps the session and retries instead of logging you out.
    _serverDown();
    const e = new Error("Waking up your RunSpace... this can take up to a minute on the free tier");
    e.kind = "infra";
    throw e;
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && auth) {
    /* A 401 FOR A TOKEN THAT IS ALREADY REPLACED IS NOT AN EXPIRED SESSION.
     *
     * While this request was in flight another 401 may have re-authenticated
     * and installed a fresh token. This response describes the OLD one and is
     * stale news. Retry with the current token instead of tearing the session
     * down — without this, the last slow reply of a burst still logged the
     * user out immediately after a successful re-login. */
    if (authToken && authToken !== sentToken && !_reauthed) {
      return await api(path, method, body, auth, _retried, true);
    }

    /* INSIDE TELEGRAM, DO NOT REDIRECT — RE-AUTHENTICATE.
     *
     * THE LOOP THIS BREAKS. A Mini App session that expires used to:
     *   1. get a 401 here,
     *   2. clear the token and send the user to "/",
     *   3. land on a page where the sign-in screen is CSS-hidden
     *      (html.tg-no-auth #screen-signin { display: none }) because a login
     *      form is meaningless in a Mini App,
     *   4. show "Session expired. Please sign in again." with nothing to sign
     *      in with — and reopening the app hit the same wall.
     *
     * The account IS the Telegram account, so the right move is to mint a
     * fresh token from initData rather than ask a human to do anything. The
     * token was just cleared above, so __tgAutoLogin's "reuse existing
     * session" shortcut cannot fire and it really does re-authenticate. */
    if (window.__inTelegram && typeof window.__tgAutoLogin === "function") {
      // Drop the dead token FIRST: __tgAutoLogin returns early ("reuse the
      // existing session") whenever one is present, so leaving it would make
      // the retry reuse the corpse.
      localStorage.removeItem("ahad_token");
      localStorage.removeItem("ahad_auth_token");
      localStorage.removeItem("ahad_user");
      authToken = null;

      // EVERY concurrent 401 waits here — no caller falls through to the
      // browser logout path any more. One network login, shared by all.
      const r = await _tgReauthOnce();
      if (r && r.ok && localStorage.getItem("ahad_token")) {
        authToken = localStorage.getItem("ahad_token");
        if (!_reauthed) return await api(path, method, body, auth, _retried, true);
        // Already retried once: the new token is installed, so the caller can
        // simply try again itself rather than recursing forever.
        throw new Error("Please try that again.");
      }
      // Re-auth genuinely failed: SHOW THE SERVER'S OWN WORDING. "Could not
      // restore your session" for every cause hid the one thing that is
      // actionable — a token/bot mismatch, which says so explicitly.
      _tgFatal((r && r.detail)
        || "Telegram could not sign you in. Close the app and open it again "
         + "from the bot.");
      throw new Error("Session expired.");
    }

    /* Free-tier cold starts can 401 briefly while the Supabase pooler is
     * spinning up — a single 401 during a cold boot is NOT a real expired
     * session. Retry once after 800ms; only log out if the retry ALSO 401s.
     * Skip retry on auth endpoints themselves (login/logout) so a bad token
     * during sign-in surfaces immediately.
     *
     * MOVED BELOW THE TELEGRAM BRANCH. It used to run first, which added 800ms
     * of dead waiting to every Mini App re-login and — worse — spent the one
     * retry the re-auth needed afterwards. Inside Telegram a dead token has a
     * real cure, so try the cure before the stall. */
    const isSafe = path.indexOf("/api/jobs") === 0 ||
                   path.indexOf("/profile") === 0 ||
                   path.indexOf("/snippets") === 0 ||
                   path.indexOf("/stats") === 0;
    if (isSafe && !_retried) {
      await new Promise(r => setTimeout(r, 800));
      try { return await api(path, method, body, auth, true, _reauthed); }
      catch (retryErr) {
        if (retryErr.kind === "infra") throw retryErr;
        // Retry still failed — fall through to logout
      }
    }

    localStorage.removeItem("ahad_token");
    localStorage.removeItem("ahad_auth_token");
    localStorage.removeItem("ahad_user");
    authToken = null;

    toast("Session expired. Please sign in again.", "error");
    setTimeout(() => { window.location.href = "/"; }, 1500);
    throw new Error("Session expired.");
  }

  // Proxy/gateway failures while the service is cold (502/503/504 with NO
  // app-level JSON detail) are infra. A 503 carrying a FastAPI detail — e.g.
  // "Jobs are not configured" — is a NORMAL app error, shown as-is.
  if (res.status >= 502 && res.status <= 504 && !(data && data.detail)) {
    _serverDown();
    const e = new Error("Server is waking up (HTTP " + res.status + ") — please wait a moment…");
    e.kind = "infra";
    throw e;
  }
  _serverUp();  // any well-formed response = the backend is alive again

  if (!res.ok) throw new Error(data.detail || "Something went wrong");
  return data;
}

/* ---------------- SERVER-UP BANNER ----------------
   One sticky banner while the backend is unreachable, instead of a dozen
   racing "Could not load …" toasts. Heals itself on the next good response. */
let _netDown = false;
function _serverDown() {
  if (_netDown) return;
  _netDown = true;
  let b = document.getElementById("netBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "netBanner";
    b.className = "net-banner";
    document.body.appendChild(b);
    // NO click-to-reload. A reload throws away unsaved editor state, which is
    // never an acceptable response to a connection blip.
  }
  b.innerHTML = `${ic("refresh")}<span>Reconnecting…</span>`;
  requestAnimationFrame(() => b.classList.add("show"));
}
function _serverUp() {
  if (!_netDown) return;
  _netDown = false;
  const b = document.getElementById("netBanner");
  if (b) b.classList.remove("show");
  toast("Back online ✓", "success");
}

function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle("loading", loading);
  btn.disabled = loading;
}

/* ---------------- AUTH BUTTON MICRO-ANIMATIONS ----------------
   Continue buttons: press (CSS scale .97) → centered spinner (same
   size, no text) → ✓ for a short beat → the next screen fades in.
   On error the label returns with a short horizontal shake.
   Fintech-style: subtle, fast, no glitter. CSS lives in app.css. */
function btnBusy(btn) {
  if (!btn) return;
  if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add("btn-busy");
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>';
}
function btnOk(btn, after) {
  if (!btn) { if (after) after(); return; }
  btn.classList.remove("btn-busy");
  btn.innerHTML = '<span class="btn-check" aria-hidden="true">✓</span>';
  setTimeout(() => {
    btn.disabled = false;
    if (btn.dataset.origHtml) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
    if (after) after();
  }, 420);
}
function btnFail(btn) {
  if (!btn) return;
  btn.classList.remove("btn-busy");
  btn.disabled = false;
  if (btn.dataset.origHtml) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
  btn.classList.add("btn-shake");
  setTimeout(() => btn.classList.remove("btn-shake"), 340);
}

/* ---------------- SIGN-UP AVAILABILITY (already-registered check) ------ */
// Strong device fingerprint for abuse prevention
let _fpCache = "";

/** Compute (once) and cache the device fingerprint for use as a request header. */
async function ensureFingerprint() {
  if (!_fpCache) {
    try { _fpCache = await generateDeviceFingerprint(); } catch (e) { _fpCache = ""; }
  }
  return _fpCache;
}

async function generateDeviceFingerprint() {
  const fp = {
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cores: navigator.hardwareConcurrency || 0,
    canvas: await getCanvasFingerprint(),
    webgl: getWebGLFingerprint(),
    fonts: getInstalledFonts(),
    audio: await getAudioFingerprint()
  };
  return JSON.stringify(fp);
}

async function getCanvasFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('CodeNest Fingerprint', 2, 2);
    return canvas.toDataURL().slice(-50);
  } catch (e) { return 'no-canvas'; }
}

function getWebGLFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'no-webgl';
    const renderer = gl.getParameter(gl.RENDERER) || '';
    const vendor = gl.getParameter(gl.VENDOR) || '';
    return `${vendor}-${renderer}`.slice(0, 80);
  } catch (e) { return 'no-webgl'; }
}

function getInstalledFonts() {
  const baseFonts = ['Arial', 'Verdana', 'Times New Roman', 'Courier New'];
  const testString = 'mmmmmmmmmlli';
  const testSize = '72px';
  const h = document.getElementsByTagName('body')[0];
  const s = document.createElement('div');
  const defaultWidth = {};
  const defaultHeight = {};
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  s.style.fontSize = testSize;
  h.appendChild(s);
  for (let i = 0; i < baseFonts.length; i++) {
    s.style.fontFamily = baseFonts[i];
    defaultWidth[baseFonts[i]] = ctx.measureText(testString).width;
    defaultHeight[baseFonts[i]] = ctx.measureText(testString).height;
  }
  h.removeChild(s);
  return Object.keys(defaultWidth).join(',');
}

async function getAudioFingerprint() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return 'no-audio';
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const analyser = context.createAnalyser();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(analyser);
    oscillator.start(0);
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatFrequencyData(data);
    return data.slice(0, 10).join(',');
  } catch (e) { return 'no-audio'; }
}

function _clearTaken(el) {
  const f = el && el.closest(".field");
  if (!f) return;
  const n = f.querySelector(".field-taken");
  if (n) n.remove();
  el.classList.remove("taken");
}
function _showTaken(el, field) {
  if (!el || el.classList.contains("taken")) return;
  const f = el.closest(".field");
  if (!f) return;
  const note = document.createElement("div");
  note.className = "field-taken";
  // An account already exists, so the useful next step is SIGN IN — not
  // "reset password", which implies the user forgot something they may not
  // have forgotten. The email is carried across so they do not retype it.
  if (field === "email") {
    const v = (el.value || "").trim().replace(/"/g, "&quot;");
    note.innerHTML = 'This email already has an account. ' +
      '<a onclick="_goSignIn(\'' + v + '\')">Sign in instead →</a>';
  } else {
    note.textContent = "That username is taken — try another.";
  }
  f.appendChild(note);
  el.classList.add("taken");
}

/** Jump to sign-in with the address pre-filled. */
function _goSignIn(prefill) {
  showScreen("screen-signin");
  const u = document.getElementById("si_username");
  if (u) {
    if (prefill) u.value = prefill;
    const pw = document.getElementById("si_password");
    setTimeout(() => (prefill && pw ? pw : u).focus(), 60);
  }
}
function _wireAvailability(inputId, field) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.addEventListener("blur", async () => {
    _clearTaken(el);
    const v = el.value.trim();
    if (v.length < 3) return;
    try {
      const r = await api("/auth/check-availability", "POST",
        field === "username" ? { username: v } : { email: v });
      if ((field === "username" && r.username_taken) || (field === "email" && r.email_taken)) _showTaken(el, field);
    } catch (e) { /* endpoint hiccup — the submit check will catch it */ }
  });
  el.addEventListener("input", () => _clearTaken(el));
}
_wireAvailability("su_username", "username");
_wireAvailability("su_email", "email");

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/* ---------------- APP ICON SYSTEM (ONE outline family, Lucide-style) --------
   Inside the authenticated app there are NO colorful emoji icons — every
   glyph comes from this single stroke-icon set (24×24, stroke=currentColor,
   1.7 width, round caps). ic("lock") → inline SVG.
*/
const _IC_PATHS = {
  lock:        '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  moon:        '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  sun:         '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5"/>',
  phone:       '<rect x="7.5" y="3" width="9" height="18" rx="2"/><path d="M11 17.5h2"/>',
  link:        '<path d="M10.5 13.5a4.2 4.2 0 0 0 6 0l3-3a4.24 4.24 0 1 0-6-6l-1.5 1.5"/><path d="M13.5 10.5a4.2 4.2 0 0 0-6 0l-3 3a4.24 4.24 0 1 0 6 6l1.5-1.5"/>',
  server:      '<rect x="4" y="4" width="16" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5"/><path d="M8 7.3h.01M8 16.8h.01M12.5 7.3H17M12.5 16.8H17"/>',
  file:        '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8H19"/>',
  copy:        '<rect x="8.5" y="8.5" width="11" height="12" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  trash:       '<path d="M4.5 6.5h15M9.5 6.2V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.4"/><path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5"/><path d="M10.2 10.5v6M13.8 10.5v6"/>',
  eye:         '<path d="M2.8 12S6.3 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>',
  globe:       '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13.5 13.5 0 0 1 0 17M12 3.5a13.5 13.5 0 0 0 0 17"/>',
  shield:      '<path d="M12 3.5 5 6v5.5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6z"/><path d="M9.2 11.8l2 2 3.6-4"/>',
  alert:       '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17.2v.1"/>',
  refresh:     '<path d="M20 5.5v5h-5"/><path d="M19.5 10.5a8 8 0 1 0 .7 4"/>',
  download:    '<path d="M12 4v11M7.5 11 12 15.5 16.5 11"/><path d="M4.5 19.5h15"/>',
  history:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.2"/>',
  'log-out':   '<path d="M14.5 4.5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7.5"/><path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5"/>',
  rocket:      '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  'folder-open':'<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.5L12 7h6a2.5 2.5 0 0 1 2.2 1.3"/><path d="M3.5 7h14.3a2 2 0 0 1 1.9 2.6l-1.8 6.2A2.5 2.5 0 0 1 15.5 18H5a2.5 2.5 0 0 1-2.5-2.5z"/>',
  zap:         '<path d="M13 2 5 13.5h5L8.8 22l8-11.5h-5L13 2z"/>',
  code:        '<path d="M9 8l-4.5 4L9 16M15 8l4.5 4L15 16"/>',
  minimize:    '<path d="M5.5 9.5h3a1.5 1.5 0 0 0 1.5-1.5v-3M15.5 9.5h3a1.5 1.5 0 0 1 1.5 1.5v-3M5.5 14.5h3A1.5 1.5 0 0 1 10 16v3M15.5 14.5h3a1.5 1.5 0 0 0-1.5 1.5v3"/>',
  play:        '<path d="M8 5.2v13.6c0 .9 1 1.5 1.8 1L20 13a1.2 1.2 0 0 0 0-2L9.8 4.3A1.2 1.2 0 0 0 8 5.2z"/>',
  check:       '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  square:      '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  x:           '<path d="M6 6l12 12M18 6 6 18"/>',
  info:        '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.6v.1"/>',
  external:    '<path d="M14.5 4h5.5v5.5"/><path d="M20 4 11 13"/><path d="M19 13.5V17a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 4 17V7a2.5 2.5 0 0 1 2.5-2.5H10"/>',
};

function ic(name, cls) {
  const p = _IC_PATHS[name] || _IC_PATHS.file;
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/* ---------------- PASSWORD STRENGTH ---------------- */
function checkStrength(password, fillEl, labelEl) {
  let score = 0;
  if (password.length >= 6) score++;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  let pct = (score / 5) * 100;
  let color = "#ef4444", label = "Weak";
  if (score >= 4) { color = "#10b981"; label = "Strong"; }
  else if (score >= 2) { color = "#f59e0b"; label = "Good"; }
  if (fillEl) { fillEl.style.width = pct + "%"; fillEl.style.background = color; }
  if (labelEl) labelEl.textContent = password ? label : "";
}

/* ---------------- OTP HELPERS ---------------- */
function setupOtpBoxes(containerId, onComplete) {
  const boxes = document.querySelectorAll(`#${containerId} input`);
  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      box.value = box.value.replace(/[^0-9]/g, "");
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (getOtpValue(containerId).length === 6) onComplete();
    });
    box.addEventListener("keydown", e => {
      if (e.key === "Backspace" && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener("paste", e => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData("text") || "").replace(/[^0-9]/g, "").slice(0, 6);
      pasted.split("").forEach((ch, idx) => { if (boxes[idx]) boxes[idx].value = ch; });
      if (pasted.length === 6) { boxes[5].focus(); onComplete(); }
    });
  });
}

function getOtpValue(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input`)).map(i => i.value).join("");
}

function clearOtpBoxes(containerId) {
  document.querySelectorAll(`#${containerId} input`).forEach(i => i.value = "");
}

function startResendTimer(seconds = 45) {
  const timerEl = document.getElementById("resendTimer");
  const linkEl = document.getElementById("resendLink");
  if (!timerEl || !linkEl) return;
  linkEl.classList.add("disabled");
  clearInterval(resendTimerInterval);
  let remaining = seconds;
  resendTimerInterval = setInterval(() => {
    remaining--;
    const m = String(Math.floor(remaining / 60)).padStart(2, "0");
    const s = String(remaining % 60).padStart(2, "0");
    timerEl.textContent = `Resend in ${m}:${s}`;
    if (remaining <= 0) {
      clearInterval(resendTimerInterval);
      timerEl.textContent = "";
      linkEl.classList.remove("disabled");
    }
  }, 1000);
}

/* ---------------- OTP EXPIRY COUNTDOWN ("Expires in 09:42") ---------- */
let _otpExpireInterval = null;
function startOtpExpiry(seconds = 600, elId = "otpExpire") {
  const el = document.getElementById(elId);
  if (!el) return;
  clearInterval(_otpExpireInterval);
  let remaining = Math.max(0, parseInt(seconds, 10) || 600);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(_otpExpireInterval);
      el.textContent = "Code expired — resend a new one.";
      el.classList.add("expired");
      return;
    }
    const m = String(Math.floor(remaining / 60)).padStart(2, "0");
    const s = String(remaining % 60).padStart(2, "0");
    el.textContent = `Expires in ${m}:${s}`;
    el.classList.remove("expired");
    remaining--;
  };
  tick();
  _otpExpireInterval = setInterval(tick, 1000);
}
function stopOtpExpiry() { clearInterval(_otpExpireInterval); _otpExpireInterval = null; }

/* ---------------- OTP WRONG-CODE: red flash + shake + auto-clear ------ */
function otpShake(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap.classList.add("otp-err");
  setTimeout(() => {
    wrap.classList.remove("otp-err");
    clearOtpBoxes(containerId);
    const first = wrap.querySelector("input");
    if (first) first.focus();
  }, 380);
}

/* ---------------- PASSWORD SHOW/HIDE EYES ----------------------------- */
function initPasswordEyes() {
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 5.9A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.6 16.6 0 0 1-2.2 3.1M6.1 6.9A16.2 16.2 0 0 0 2.5 12S6 18.5 12 18.5a9.1 9.1 0 0 0 3.3-.6"/><path d="M9.5 9.7a3 3 0 0 0 4.6 4"/><path d="M3 3l18 18"/></svg>';
  ["su_password", "si_password", "fp_newpass", "fp_confirmpass"].forEach(id => {
    const input = document.getElementById(id);
    if (!input || input.dataset.eye) return;
    input.dataset.eye = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-eye";
    btn.tabIndex = -1;  // keep Tab / mobile "next field" flowing username→email→password
    btn.setAttribute("aria-label", "Show or hide password");
    btn.innerHTML = EYE;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.classList.toggle("on", show);
      input.focus();
    });
    // Wrap input in a relative holder so the eye centers exactly on the field.
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(btn);
  });
}
initPasswordEyes();

/* ==================== SIGNUP ==================== */
document.addEventListener("submit", e => {
  if (e.target.id === "formSignup") handleSignup(e);
  else if (e.target.id === "formSignin") handleSignin(e);
  else if (e.target.id === "formForgot1") handleForgot1(e);
  else if (e.target.id === "formForgot3") handleForgot3(e);
});

async function handleSignup(e) {
  e.preventDefault();
  const btn = document.getElementById("btnSignup");
  const username = document.getElementById("su_username").value.trim();
  const email = document.getElementById("su_email").value.trim();
  const password = document.getElementById("su_password").value;
  if (username.length < 3) { toast("Username must be at least 3 characters", "error"); return; }
  const termsEl = document.getElementById("su_terms");
  if (termsEl && !termsEl.checked) {
    toast("Please accept the Terms of Use to continue.", "error");
    termsEl.focus();
    return;
  }
  // Early duplicate check — say "already registered" BEFORE the OTP dance.
  try {
    const av = await api("/auth/check-availability", "POST", { username, email });
    if (av.username_taken || av.email_taken) {
      _showTaken(document.getElementById(av.username_taken ? "su_username" : "su_email"),
                 av.username_taken ? "username" : "email");
      return;
    }
  } catch (e) { /* check endpoint hiccup — /signup will decide anyway */ }

  // Collect strong device fingerprint for abuse prevention
  const fingerprint = await ensureFingerprint();
  btnBusy(btn);
  try {
    const res = await api("/signup", "POST", {
      username, email, password, agreed_terms: true,
      fingerprint: fingerprint
    });
    signupUsername = username;
    localStorage.setItem("ahad_signup_username", username);
    localStorage.setItem("ahad_signup_email", email);
    clearOtpBoxes("otpBoxesSignup");
    document.getElementById("otpEmailNote").textContent = `Sent to ${email}`;
    logEvent("success", "Verification email sent", `Code sent to ${email}`);
    const toastMsg = res.resent ? "Welcome back — a fresh code was sent to your email." : "Verification code sent! Check your email.";
    btnOk(btn, () => {
      showScreen("screen-otp");
      startResendTimer(45);
      startOtpExpiry(res.expires_in || 600, "otpExpire");
      toast(toastMsg, "success");
    });
  } catch (err) {
    btnFail(btn);
    logEvent("error", "Sign-up failed", err.message);
    toast(err.message, "error");
  }
}

setupOtpBoxes("otpBoxesSignup", () => document.getElementById("btnVerify").click());
setupOtpBoxes("otpBoxesForgot", () => document.getElementById("btnForgot2").click());

document.getElementById("btnVerify").addEventListener("click", async () => {
  const btn = document.getElementById("btnVerify");
  const otp = getOtpValue("otpBoxesSignup");
  let username = signupUsername || localStorage.getItem("ahad_signup_username");
  if (!username) { toast("Username not found. Please sign up again.", "error"); showScreen("screen-signup"); return; }
  if (otp.length !== 6) { toast("Enter the 6-digit code", "error"); return; }
  btnBusy(btn);
  try {
    const data = await api("/verify", "POST", { username, otp, fingerprint: await ensureFingerprint() });
    authToken = data.token;
    localStorage.setItem("ahad_token", authToken);
    localStorage.removeItem("ahad_signup_username");
    localStorage.removeItem("ahad_signup_email");
    signupUsername = "";
    // Clear the signup form + OTP so the entered email/username never lingers.
    clearOtpBoxes("otpBoxesSignup");
    document.getElementById("su_username").value = "";
    document.getElementById("su_email").value = "";
    document.getElementById("su_password").value = "";
    resetLocalActivity();
    try { localStorage.setItem("ahad_user", JSON.stringify({username: data.username, ts: Date.now()})); } catch(e){}
    logEvent("success", "Email verified", `Account confirmed: ${username}`);
    btnOk(btn, () => {
      stopOtpExpiry();
      clearOtpBoxes("otpBoxesSignup");
      document.getElementById("su_username").value = "";
      document.getElementById("su_email").value = "";
      document.getElementById("su_password").value = "";
      showScreen("screen-dashboard");
      _consumeReturnTo();
      toast(`Welcome, ${data.username}!`, "success");
      loadDashboard().catch(() => {});
      syncActivityFromServer();
    });
  } catch (err) {
    btnFail(btn);
    otpShake("otpBoxesSignup");
    logEvent("error", "Wrong / invalid OTP", err.message);
    toast(err.message, "error");
  }
  finally { setLoading(btn, false); }
});

document.getElementById("resendLink").addEventListener("click", async () => {
  const username = signupUsername || localStorage.getItem("ahad_signup_username");
  if (!username) { toast("Username not found.", "error"); showScreen("screen-signup"); return; }
  try {
    const r = await api("/resend-otp", "POST", { username });
    logEvent("info", "New code requested", `Resent OTP to ${username}`);
    toast("New code sent!", "success"); startResendTimer(45);
    startOtpExpiry(r.expires_in || 600, "otpExpire");
  }
  catch (err) { logEvent("error", "Resend failed", err.message); toast(err.message, "error"); }
});

/* ==================== SIGNIN ==================== */
async function handleSignin(e) {
  e.preventDefault();
  const btn = document.getElementById("btnSignin");
  const username = document.getElementById("si_username").value.trim();
  const password = document.getElementById("si_password").value;
  if (!username || !password) { toast("Please enter username and password", "error"); return; }
  btnBusy(btn);
  try {
    const data = await api("/login", "POST", { username, password, fingerprint: await ensureFingerprint() });
    // Backend routes unverified accounts to verification instead of erroring.
    if (data.need_verify) {
      signupUsername = data.username;
      localStorage.setItem("ahad_signup_username", data.username);
      clearOtpBoxes("otpBoxesSignup");
      document.getElementById("otpEmailNote").textContent = "Email not verified yet";
      logEvent("warning", "Verification required", `Please verify ${data.username}`);
      btnOk(btn, () => {
        showScreen("screen-otp");
        startResendTimer(10);
        startOtpExpiry(data.expires_in || 600, "otpExpire");
        toast("Verify your email to continue", "warning");
      });
      return;
    }
    authToken = data.token;
    localStorage.setItem("ahad_token", authToken);
    // Keep minimal user cache so that a container restart (which wipes the
    // in-memory SQLite on free-tier Render) doesn't show "Session expired"
    // on the very next click — bootstrap the dashboard from cache while we
    // re-verify against the server.
    try { localStorage.setItem("ahad_user", JSON.stringify({username: data.username, ts: Date.now()})); } catch(e){}
    resetLocalActivity();
    logEvent("success", "Sign-in successful", `Welcome back, ${data.username}`);
    // 👉 SWITCH TO DASHBOARD RIGHT AWAY (don't await data first — that caused
    // the dreaded 2-s "empty inputs staring back at you" lag). Skeleton
    // placeholders paint instantly, then data fills in behind the scenes.
    btnOk(btn, () => {
      // Clear inputs AFTER screen slides out so user never sees them vanish
      // while still on the sign-in card — avoids "wait where did my
      // password go? did it fail?" UX.
      document.getElementById("si_username").value = "";
      document.getElementById("si_password").value = "";
      showScreen("screen-dashboard");
      _consumeReturnTo();
      toast(`Welcome back, ${data.username}!`, "success");
      // Fire-and-forget data load — errors are reported inline on dashboard
      loadDashboard().catch(() => {});
      syncActivityFromServer();
    });
  } catch (err) {
    btnFail(btn);
    logEvent("error", "Sign-in failed", err.message);
    // The server deliberately does NOT say whether the account exists — that
    // would let anyone test which e-mails are registered. So we keep its
    // wording, but still offer the two things a stuck user actually needs.
    const wrongCreds = /incorrect|invalid/i.test(err.message || "");
    if (wrongCreds) {
      const v = (document.getElementById("si_username") || {}).value || "";
      _authNote("si_username", err.message, "Create an account →",
                () => _goSignUp(v));
    } else {
      toast(err.message, "error");
    }
  }
}

/** Inline note under an auth field, with one clear next step. */
function _authNote(inputId, text, linkText, onClick) {
  const el = document.getElementById(inputId);
  const f = el && el.closest(".field");
  if (!f) { toast(text, "error"); return; }
  f.querySelectorAll(".field-taken").forEach(n => n.remove());
  const note = document.createElement("div");
  note.className = "field-taken";
  note.textContent = text + " ";
  const a = document.createElement("a");
  a.textContent = linkText;
  a.addEventListener("click", onClick);
  note.appendChild(a);
  f.appendChild(note);
  el.addEventListener("input", () => note.remove(), { once: true });
}

/** Jump to sign-up, carrying the address over. */
function _goSignUp(prefill) {
  showScreen("screen-signup");
  const em = document.getElementById("su_email");
  if (em && prefill && prefill.includes("@")) em.value = prefill;
  const first = document.getElementById("su_username");
  setTimeout(() => first && first.focus(), 60);
}

/* ==================== FORGOT PASSWORD ==================== */
let forgotEmail = "";
let forgotOtp = "";

async function handleForgot1(e) {
  e.preventDefault();
  const btn = document.getElementById("btnForgot1");
  forgotEmail = document.getElementById("fp_email").value.trim();
  btnBusy(btn);
  try {
    const r = await api("/forgot-password", "POST", { email: forgotEmail });
    clearOtpBoxes("otpBoxesForgot");
    btnOk(btn, () => {
      showScreen("screen-forgot2");
      startOtpExpiry(r.expires_in || 600, "otpExpireReset");
      toast("If this email exists, a code has been sent", "success");
    });
  } catch (err) { btnFail(btn); toast(err.message, "error"); }
}

document.getElementById("btnForgot2").addEventListener("click", async () => {
  const btn = document.getElementById("btnForgot2");
  forgotOtp = getOtpValue("otpBoxesForgot");
  if (forgotOtp.length !== 6) { toast("Enter the 6-digit code", "error"); return; }
  btnBusy(btn);
  try {
    await api("/verify-reset-otp", "POST", { email: forgotEmail, otp: forgotOtp });
    btnOk(btn, () => {
      stopOtpExpiry();
      toast("Code verified!", "success");
      showScreen("screen-forgot3");
    });
  } catch (err) { btnFail(btn); otpShake("otpBoxesForgot"); toast(err.message, "error"); }
});

async function handleForgot3(e) {
  e.preventDefault();
  const btn = document.getElementById("btnForgot3");
  const p1 = document.getElementById("fp_newpass").value;
  const p2 = document.getElementById("fp_confirmpass").value;
  if (p1 !== p2) { toast("Passwords do not match", "error"); return; }
  btnBusy(btn);
  try {
    await api("/reset-password", "POST", { email: forgotEmail, otp: forgotOtp, new_password: p1 });
    btnOk(btn, () => {
      showScreen("screen-forgot-success");
      let count = 3;
      const cd = document.getElementById("successCountdown");
      const iv = setInterval(() => {
        count--; cd.textContent = count;
        if (count <= 0) { clearInterval(iv); showScreen("screen-signin"); }
      }, 1000);
    });
  } catch (err) { btnFail(btn); toast(err.message, "error"); }
}

/* ==================== DASHBOARD ==================== */
let _dashRetries = 0, _dashRetryTimer = null;
function _scheduleDashboardRetry() {
  if (_dashRetries >= 8) return;          // give up after ~2 min — banner stays up
  _dashRetries += 1;
  clearTimeout(_dashRetryTimer);
  _dashRetryTimer = setTimeout(() => { if (authToken) loadDashboard(); }, Math.min(4000 * _dashRetries, 20000));
}

async function loadDashboard() {
  // 1) Critical auth check — ONLY a profile/401 failure ends the session.
  try {
    const profile = await api("/profile", "GET", null, true);
    _dashRetries = 0;                     // healthy again — reset the backoff
    document.getElementById("dashUsername").textContent = profile.username;
    document.getElementById("dashUsername2").textContent = profile.username;
    document.getElementById("profileUsername").value = profile.username;
    document.getElementById("profileEmail").value = profile.email;
    document.getElementById("profilePhone").value = profile.phone || "";
    document.getElementById("profileCode").value = profile.custom_code || "";

    _lastProfile = profile;
    applyAdminVisibility(profile);
    refreshSecurityPanel();
    loadSessionsList();
  } catch (err) {
    console.error("Dashboard auth error:", err);
    // Infra failure (server asleep / 502-504 / no network): the session is
    // VALID — do NOT log the user out. Banner retries in the background.
    if (err && err.kind === "infra") { _scheduleDashboardRetry(); return; }
    toast("Session expired. Please login again.", "error");
    authToken = null;
    localStorage.removeItem("ahad_token");
    showScreen("screen-signin");
    return;
  }

  // 2) Section loads are NON-FATAL. If one section fails (network glitch,
  //    transient 500, etc.) the dashboard must still show so the user can
  //    use the buttons and retry. Don't collapse the whole UI on a section
  //    failure, and never clear the token here.
  try {
    await Promise.all([loadSnippets()]);
  } catch (err) {
    console.error("Section load error (non-fatal):", err);
  }
  await loadStats(); // updates the stat counters

  showScreen("screen-dashboard");
}

/* ==================== ADD-NEW FORM TOGGLE (ONE source of truth) ========
   Old pattern: a click listener on the button PLUS swapping .onclick between
   show/hide. On many mobile browsers BOTH handlers fire on the same tap —
   show() then hide() instantly — so the button looked dead after the first
   use and only a reload revived it.
   New pattern: exactly ONE listener per button; the open state is READ FROM
   THE DOM at toggle time (like an updater fn — no stale closure, no ghost
   handler). The form element itself is the only source of truth. */
function _clearIds(ids) { (ids || []).forEach(i => { const e = document.getElementById(i); if (e) e.value = ""; }); }

/* ---------------- SECTION LOAD FAILURE — NEVER a stuck spinner ----------------
   Every section's loader must ALWAYS end in a real state: data, empty, or a
   clear inline error WITH a retry button. A failed fetch used to leave the
   "Loading…" spinner running forever, which read as a frozen app. */
/* Professional loading state: Supabase-style shimmering skeleton bars
   (subtle pulse, no gimmicks) — used by every section while data flies. */
function _skel(rows = 3) {
  // Vercel/Linear-style shimmer skeleton for the jobs sidebar (paints instantly
  // while loadJobs() is in flight — makes tab switch feel instant).
  let h = '<div class="rs-skel-wrap" aria-hidden="true">';
  for (let i = 0; i < rows; i++) {
    h += '<div class="rs-skel-job">' +
           '<span class="rs-skel-dot"></span>' +
           '<span class="rs-skel" style="flex:1"></span>' +
           '<span class="rs-skel" style="width:16px;height:16px;border-radius:4px"></span>' +
         '</div>';
  }
  return h + "</div>";
}

/* Delete feedback: row slides/fades away (220ms) before the list re-renders. */
function _rowOut(btnOrEl) {
  const row = btnOrEl && btnOrEl.closest &&
    btnOrEl.closest(".snippet-item, .job-card");
  if (!row) return Promise.resolve();
  row.classList.add("row-leave");
  return new Promise(r => setTimeout(r, 220));
}

function _loadErrorBox(list, what, retryFn, e) {
  if (!list) return;
  const infra = !!(e && e.kind === "infra");
  list.innerHTML = "";
  const box = document.createElement("div");
  box.className = "load-error";
  box.innerHTML =
    '<div class="load-error-ic">' + ic(infra ? "refresh" : "alert") + '</div>' +
    '<div class="load-error-tx"><b>' + (infra ? "Server waking up…" : ("Couldn\u2019t load " + what)) + '</b>' +
    '<span>' + (infra
      ? "The free-plan server is starting — this retries by itself (about a minute)."
      : escapeHtml((e && e.message) || "Something went wrong")) + '</span></div>';
  const btn = document.createElement("button");
  btn.className = "xbtn";
  btn.innerHTML = ic("refresh") + " Retry";
  btn.addEventListener("click", () => { retryFn(); });
  box.appendChild(btn);
  list.appendChild(box);
}

/* Null-safe smooth scroll — never crash if an element is not mounted yet. */
function _scrollToEl(el) { if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }

const _RUNNABLE_LANGS = {"html":1, "css":1, "javascript":1, "js":1, "markdown":1, "md":1};

/* Show exactly ONE primary action per language type:
   markup/docs (html/css/js/md) → Preview; execution langs → Run. */
function syncRunPreviewButtons() {
  const lang = (document.getElementById("snippetLanguage") || {}).value || "html";
  const previewable = !!_RUNNABLE_LANGS[lang.toLowerCase()];
  const run = document.getElementById("btnRunCode");
  const prev = document.getElementById("btnRunSnippet");
  if (run) run.style.display = previewable ? "none" : "";
  if (prev) prev.style.display = previewable ? "" : "none";
}

/* Fullscreen editor — clean BINARY state, never a trap.
   · .cs-canvas.full → position:fixed inset:0 (TRUE 100% viewport)
   · a floating "Exit" button is injected INSIDE the canvas while it's full,
     so the exit control can never be hidden behind the canvas itself
   · Esc also exits (wired at boot) · switching tabs auto-exits (switchTab) */
function _ensureEdExitBtn() {
  let b = document.getElementById("edExitBtn");
  if (!b) {
    b = document.createElement("button");
    b.id = "edExitBtn";
    b.type = "button";
    b.className = "ed-exit";
    b.innerHTML = ic("minimize") + '<span>Exit fullscreen</span><kbd>Esc</kbd>';
    b.addEventListener("click", exitEditorFullscreen);
  }
  return b;
}
function enterEditorFullscreen() {
  const c = document.getElementById("ideSplit");
  if (!c || c.classList.contains("full")) return;
  c.classList.add("full");
  document.body.classList.add("ed-full");
  c.appendChild(_ensureEdExitBtn());
  const t = document.getElementById("btnEditorFull");
  if (t) t.classList.add("on");
}
function exitEditorFullscreen() {
  const c = document.getElementById("ideSplit");
  if (!c || !c.classList.contains("full")) return;
  c.classList.remove("full");
  document.body.classList.remove("ed-full");
  const ex = document.getElementById("edExitBtn");
  if (ex) ex.remove();
  const t = document.getElementById("btnEditorFull");
  if (t) t.classList.remove("on");
}
function toggleEditorFullscreen() {
  const c = document.getElementById("ideSplit");
  if (!c) return;
  if (c.classList.contains("full")) exitEditorFullscreen(); else enterEditorFullscreen();
}

let cmEditor = null;
function initCodeMirror() {
  const ta = document.getElementById("snippetContent");
  if (!ta || cmEditor) return;
  if (typeof CN6 === "undefined") { console.error("cm6 bundle missing"); return; }
  const host = document.createElement("div");
  host.className = "cs-cm-host";
  ta.parentNode.insertBefore(host, ta);
  ta.style.display = "none";

  const runOrPreview = () => {
    const l = (document.getElementById("snippetLanguage").value || "").toLowerCase();
    if (_RUNNABLE_LANGS[l]) { runLivePreview(); } else { executeCode(); }
    return true;
  };

  let _csRaf = 0;
  cmEditor = CN6.create(host, {
    value: ta.value || "",
    language: "python",
    lineWrapping: true,
    extraKeys: [
      { key: "Mod-s", preventDefault: true, run: () => { saveSnippet(); return true; } },
      { key: "Mod-Enter", preventDefault: true, run: runOrPreview },
    ],
    onChange: () => {
      clearTimeout(_livePreviewTimer);
      const l = (document.getElementById("snippetLanguage").value || "").toLowerCase();
      if (_RUNNABLE_LANGS[l]) _livePreviewTimer = setTimeout(runLivePreview, 400);
      if (_csRaf) return;
      _csRaf = requestAnimationFrame(() => { _csRaf = 0; updateEditorMeta(); });
    },
  });
  updateCodeMirrorMode();
}

function updateCodeMirrorMode() {
  if (!cmEditor) return;
  // CM6 resolves the language itself (see LANGS in editor-src/cm6.js), so the
  // long CM5 mode-string mapping is no longer needed.
  const lang = (document.getElementById("snippetLanguage").value || "text").toLowerCase();
  cmEditor.setLanguage(lang);
}

function newSnippetDraft(quiet) {
  editingSnippetId = null;
  document.getElementById("snippetTitle").value = "";
  const ta = document.getElementById("snippetContent");
  ta.value = "";
  if (cmEditor) cmEditor.setValue("");
  document.getElementById("snippetLanguage").value = "html";
  updateCodeMirrorMode();
  updateEditorMeta();
  syncRunPreviewButtons();
  runLivePreview();
  if (cmEditor) cmEditor.focus(); else ta.focus();
  if (!quiet) toast("New snippet — write something and press Run", "info");
}

async function saveSnippet(keepEditor) {
  const title = document.getElementById("snippetTitle").value.trim();
  const language = document.getElementById("snippetLanguage").value;
  const content = cmEditor ? cmEditor.getValue() : document.getElementById("snippetContent").value;
  if (!title) { toast("Please enter a file name first", "error"); const _t=document.getElementById("snippetTitle"); if(_t)_t.focus(); return; }
  if (!content.trim()) { toast("Snippet content cannot be empty!", "error"); return; }
  try {
    let savedId = editingSnippetId;
    if (editingSnippetId) { await api("/snippets", "PUT", { id: editingSnippetId, title: title, language, content }, true); toast("Snippet updated! </>", "success"); }
    else {
      const r = await api("/snippets", "POST", { title: title, language, content }, true);
      editingSnippetId = r.id; savedId = r.id; toast("Snippet saved! </>", "success");
    }
    logEvent("success", "Snippet saved", title);
    await loadSnippets();
    // Reset to a clean editor after save — no stale content on the next "new".
    if (!keepEditor) newSnippetDraft(true);
    return savedId;
  } catch (err) { toast(err.message, "error"); return null; }
}

function updateEditorMeta() {
  const ta = document.getElementById("snippetContent");
  const meta = document.getElementById("editorMeta");
  if (!ta || !meta) return;
  // lineCount() avoids serialising + splitting the entire document just to
  // count lines. Only the char count needs the text.
  let lines, chars;
  if (cmEditor) {
    lines = cmEditor.lineCount();
    chars = cmEditor.getValue().length;
  } else {
    const val = ta.value || "";
    lines = val.split("\n").length;
    chars = val.length;
  }
  meta.textContent = lines + " lines · " + chars + " chars";
  updateGutter();
}

/* Build the srcdoc for the live preview iframe, matching the share page. */
function _buildPreviewSrcdoc(body, lang) {
  body = body || "";
  lang = (lang || "text").toLowerCase();
  if (lang === "html") return body;
  if (lang === "css") {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + body + '</style></head>' +
      '<body style="font-family:system-ui,sans-serif;padding:24px;color:#111;background:#fff">' +
      '<h1>Heading</h1><p>Paragraph to show your <strong>CSS</strong>. <a href="#">A link</a>.</p>' +
      '<button>Button</button><ul><li>Item one</li><li>Item two</li></ul><input placeholder="Input"></body></html>';
  }
  if (lang === "markdown" || lang === "md") {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script></head><body style="font-family:system-ui,sans-serif;padding:28px;max-width:720px;margin:0 auto;color:#1a1a2e;line-height:1.7;background:#fff"><div id="r"></div><script>document.getElementById("r").innerHTML = (window.marked ? marked.parse(decodeURIComponent(atob("' + btoaSafe(encodeURIComponent(body)) + '"))) : "");<\/script></body></html>';
  }
  if (lang === "javascript" || lang === "js") {
    var safe = body.split("<\/script>").join("<\\/script>");
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,sans-serif;padding:20px;color:#111;background:#fff"><scr' + 'ipt>(function(){var P=function(t,a){parent.postMessage({__ideConsole:true,type:t,msg:Array.prototype.map.call(a,function(x){try{return typeof x==="object"?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(" ")},\'*\')};["log","info","warn","error"].forEach(function(m){console[m]=function(){P(m==="error"?"err":(m==="warn"?"warn":"info"),arguments)}});window.onerror=function(m,s,l,c){P("err",[m+" (line "+l+")"])};try{\n' + safe + '\n}catch(e){P("err",[e.message])}})();<\/scr' + 'ipt></body></html>';
  }
  return "";
}

/* base64 of a UTF-8-safe string (for embedding into the markdown preview). */
function btoaSafe(str) {
  try { return btoa(str); } catch (e) { return btoa(unescape(encodeURIComponent(str))); }
}

function runLivePreview() {
  const lang = document.getElementById("snippetLanguage").value;
  const content = cmEditor ? cmEditor.getValue() : document.getElementById("snippetContent").value;
  const frame = document.getElementById("livePreview");
  const pmeta = document.getElementById("previewMeta");
  if (!frame) return;
  const runnable = !!_RUNNABLE_LANGS[(lang || "").toLowerCase()];
  const consoleBox = document.getElementById("ideConsole");
  const icBody = document.getElementById("icBody");
  if (consoleBox) consoleBox.style.display = "none";
  if (icBody) icBody.innerHTML = "";
  if (!runnable) {
    frame.srcdoc = '<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#94a3b8;background:#f8fafc;text-align:center;padding:20px"><div><div style="color:#94a3b8;width:34px;margin:0 auto">' + ic("eye") + '</div><p style="margin-top:10px;font-size:14px">Live preview supports<br><b>HTML, CSS, JavaScript &amp; Markdown</b>.</p><p style="font-size:12px;color:#cbd5e1;margin-top:6px">Other languages show in the share link as highlighted code.</p></div></body></html>';
    if (pmeta) pmeta.textContent = "no preview";
    return;
  }
  frame.srcdoc = _buildPreviewSrcdoc(content, lang);
  if (pmeta) pmeta.textContent = "live · " + lang;
}

/* Capture console messages from the JS preview iframe. */
window.addEventListener("message", function (ev) {
  var d = ev.data;
  if (!d || !d.__ideConsole) return;
  var box = document.getElementById("ideConsole");
  var body = document.getElementById("icBody");
  if (!box || !body) return;
  box.style.display = "flex";
  var ln = document.createElement("div");
  ln.className = "ln " + (d.type === "err" ? "err" : "info");
  ln.textContent = (d.type === "err" ? "✕ " : "› ") + d.msg;
  body.appendChild(ln);
  body.scrollTop = body.scrollHeight;
});

/* Simple JSON / HTML / CSS formatter (best-effort, client-side). */
function formatSnippet() {
  const ta = document.getElementById("snippetContent");
  const lang = document.getElementById("snippetLanguage").value;
  const orig = cmEditor ? cmEditor.getValue() : ta.value;
  let out = orig;
  try {
    if (lang === "json") { out = JSON.stringify(JSON.parse(orig), null, 2); }
    else if (lang === "html") { out = _formatMarkup(orig); }
    else if (lang === "css") { out = _formatCSS(orig); }
    else { out = orig.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"; }
    ta.value = out;
    if (cmEditor) cmEditor.setValue(out);
    updateEditorMeta();
    runLivePreview();
    toast("Formatted", "success");
  } catch (e) { toast("Could not format: " + e.message, "error"); }
}
function _formatMarkup(src) { return src.replace(/>\s*</g, ">\n<").replace(/^\s+|\s+$/g, "") + "\n"; }
function _formatCSS(src) { return src.replace(/\s*\{\s*/g, " {\n  ").replace(/;\s*/g, ";\n  ").replace(/\s*\}\s*/g, "\n}\n").replace(/\n\s*\n/g, "\n").trim() + "\n"; }

async function loadSnippets() {
  const list = document.getElementById("snippetsList");
  if (!list) return;
  list.innerHTML = _skel(3);
  try {
    const data = await api("/snippets", "GET", null, true);
    const snips = data.snippets || [];
    const count = document.getElementById("snippetCount");
    if (count) count.textContent = snips.length + " saved";
    if (!snips.length) { list.innerHTML = `<div class="empty-state"><div class="empty-icon">${ic("code","gold")}</div><p>No snippets saved yet</p><small>Write code above and press Save</small></div>`; return; }
    const origin = window.location.origin + window.location.pathname.replace(/index\.html$/, "").replace(/\/$/, "");
    list.innerHTML = snips.map(s => {
      const shared = s.share_token && s.is_public;
      const url = shared ? (origin + "/@" + (window.__user || "me") + "/" + encodeURIComponent(s.title)) : "";
      return '<div class="snippet-item" data-id="'+s.id+'" onclick="loadSnippetIntoEditor('+s.id+')" title="'+escapeHtml(s.title)+'">' +
          '<div class="snippet-head"><h4>' + escapeHtml(s.title) + '</h4></div>' +
          '<div class="snippet-actions">' +
            '<button class="xbtn delete" onclick="event.stopPropagation();deleteSnippet(' + s.id + ', this)" title="Delete">×</button>' +
          '</div>' +
        '</div>';
    }).join("");
  } catch (err) { if (!err || err.kind !== "infra") toast("Could not load snippets: " + err.message, "error"); _loadErrorBox(document.getElementById("snippetsList"), "snippets", loadSnippets, err); }
}

/* Load a saved snippet into the editor. */
async function loadSnippetIntoEditor(id) {
  try {
    const data = await api("/snippets", "GET", null, true);
    const s = (data.snippets || []).find(x => x.id === id);
    if (!s) return;
    editingSnippetId = id;
    document.getElementById("snippetTitle").value = s.title || "";
    document.getElementById("snippetLanguage").value = s.language || "text";
    const val = s.content || "";
    document.getElementById("snippetContent").value = val;
    if (cmEditor) cmEditor.setValue(val);
    updateCodeMirrorMode();
    updateEditorMeta();
    runLivePreview();
    // Publish status in status bar
    const sErr = document.getElementById("csStatusErr");
    const pubBtn = document.getElementById("btnShareSnippet");
    if (s.share_token && s.is_public) {
      const uname = window.__user || "me";
      const pretty = window.location.origin + "/@" + uname + "/" + encodeURIComponent(s.title||"untitled");
      if (sErr) sErr.innerHTML = '● <a href="'+pretty+'" target="_blank" rel="noopener" style="color:#3fb950">live</a>';
      if (pubBtn) { pubBtn.classList.add("is-published"); const sp = pubBtn.querySelector('span'); if(sp) sp.textContent = "Live"; }
    } else {
      if (sErr) sErr.innerHTML = '';
      if (pubBtn) { pubBtn.classList.remove("is-published"); const sp = pubBtn.querySelector('span'); if(sp) sp.textContent = "Publish"; }
    }
    toast("Loaded", "info");
    _scrollToEl(document.querySelector("#tab-code .cs-canvas"));
  } catch (err) { toast(err.message, "error"); }
}

async function deleteSnippet(id, btn) {
  if (!confirm("Delete this snippet?")) return;
  try { await api("/snippets", "DELETE", { id }, true); toast("Snippet deleted!", "success"); if (editingSnippetId === id) newSnippetDraft(); await _rowOut(btn); await loadSnippets(); }
  catch (err) { toast(err.message, "error"); }
}

/* Share the snippet currently in the editor (creates if unsaved). */
async function shareCurrentSnippet() {
  const btn = document.getElementById("btnShareSnippet");
  if (btn) {
    btn.classList.add("is-firing");
    btn.classList.add("loading");
  }
  try {
    let id = editingSnippetId;
    if (!id) { id = await saveSnippet(true); }
    if (!id) return;
    await toggleSnippetShare(id, undefined, btn);
  } finally {
    if (btn) {
      btn.classList.remove("loading");
      setTimeout(() => btn.classList.remove("is-firing"), 600);
    }
  }
}

// Visible published-link bar under the studio header: link + Open + Copy.
function showPubBar(url) {
  let bar = document.getElementById("pubBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "pubBar";
    bar.className = "pub-bar";
    const header = document.querySelector(".cs-header");
    if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
    else return;
  }
  bar.style.display = "flex";
  const canonUrl = arguments[1] || url;
  bar.innerHTML =
    '<span class="pub-ic">' + ic("link") + '</span>' +
    '<a class="pub-link" href="' + escapeHtml(canonUrl) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>' +
    '<span class="pub-acts">' +
      '<button class="xbtn" id="pubOpen">Open ↗</button>' +
      '<button class="xbtn" id="pubCopy">Copy</button>' +
      '<button class="xbtn" id="pubClose">✕</button>' +
    '</span>';
  bar.querySelector("#pubOpen").addEventListener("click", () => window.open(canonUrl, "_blank", "noopener"));
  bar.querySelector("#pubCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); toast("Link copied", "success"); }
    catch (e) { toast("Copy failed", "error"); }
  });
  bar.querySelector("#pubClose").addEventListener("click", () => { bar.style.display = "none"; });
  // Update status bar
  const sErr = document.getElementById("csStatusErr");
  if (sErr) sErr.innerHTML = '● <a href="'+escapeHtml(canonUrl)+'" target="_blank" rel="noopener">live</a>';
}

async function toggleSnippetShare(id, shared, btn) {
  let nowShared = !!shared;
  if (shared === undefined || shared === null || typeof shared === "object") {
    // Studio flow: no cached state (or the button got passed through) —
    // look it up once. The snippets-list row flow skips this extra GET.
    if (btn === undefined && shared && shared.tagName) btn = shared;
    try {
      const data = await api("/snippets", "GET", null, true);
      const s = (data.snippets || []).find(x => x.id === id);
      nowShared = !!(s && s.share_token && s.is_public);
    } catch (e) {}
  }
  setLoading(btn, true);
  // Publishing countdown animation
  if (btn) {
    const orig = btn.innerHTML;
    let secs = 3;
    btn.dataset.origHtml = orig;
    btn.disabled = true;
    btn.classList.add("publishing");
    const tick = () => {
      if (secs <= 0 || !btn.isConnected) { btn.innerHTML = orig; btn.disabled = false; btn.classList.remove("publishing"); return; }
      btn.innerHTML = '<span style="display:inline-block;animation:pubSpin 0.8s linear infinite">⏳</span> Publishing '+secs+'s';
      secs--;
      setTimeout(tick, 1000);
    };
    tick();
  }
  try {
    const res = await api("/snippets/share", "POST", { id, share: !nowShared }, true);
    if (res.share && res.url) {
      const curTitle = ((document.getElementById("snippetTitle")||{}).value||"untitled").trim();
      const uname = (window.__user||"me");
      const pretty = window.location.origin + "/@" + uname + "/" + encodeURIComponent(curTitle);
      showPubBar(pretty, window.location.origin + res.url);
      try { await navigator.clipboard.writeText(pretty); } catch (e) {}
      toast("Published — link copied", "success");
      // Update status bar
      const sErr = document.getElementById("csStatusErr");
      if (sErr) sErr.innerHTML = '● <a href="'+pretty+'" target="_blank" rel="noopener" style="color:#3fb950">live</a>';
      // Switch publish button text / state
      if (btn && btn.dataset) {
        btn.classList.add("is-published");
        btn.querySelector('span').textContent = "Live";
      }
      logEvent("success", "Snippet shared", "Standalone page published");
    } else {
      toast("Unpublished", "info");
      const sErr = document.getElementById("csStatusErr");
      if (sErr) sErr.innerHTML = '';
      if (btn && btn.querySelector('span')) btn.querySelector('span').textContent = "Publish";
      logEvent("warning", "Snippet unshared", "");
    }
    await loadSnippets();
  } catch (err) { toast(err.message, "error"); if (btn) { btn.classList.remove("publishing"); btn.disabled = false; } }
  finally { setLoading(btn, false); if (btn) { btn.classList.remove("publishing"); btn.disabled = false; } }
}


async function copySnippetCode(id) {
  try {
    const data = await api("/snippets", "GET", null, true);
    const s = (data.snippets || []).find(x => x.id === id);
    if (!s) return;
    await navigator.clipboard.writeText(s.content || "");
    toast("Code copied!", "success");
  } catch (e) { toast("Copy failed", "error"); }
}

/* Draggable split divider between editor and preview. */
/* Preview panel toggle — slides open/closed from the right.
   For runnable languages (html/css/js/md): shows live preview.
   For other languages: runs real code execution (Python etc). */
function togglePreviewPanel(open) {
  const zone = document.getElementById("idePreview");
  if (!zone) return;
  if (open === undefined) open = !zone.classList.contains("open");
  if (open) {
    zone.classList.add("open");
    const lang = document.getElementById("snippetLanguage").value;
    if (_RUNNABLE_LANGS[(lang||"").toLowerCase()]) {
      runLivePreview();
    } else {
      executeCode(); // real execution for Python/C/etc
    }
  } else {
    zone.classList.remove("open");
  }
}

/* ================== INTEGRATED TERMINAL (real code execution) ==================
   Results render in the bottom terminal panel (#ahTerm). Shows stdout AND
   stderr, and — crucially — EVERY backend/config/timeout error is printed as
   a visible red block, so failures never disappear silently again. */

// --- tiny terminal helpers ---
function _termOpen() {
  const t = document.getElementById("ahTerm");
  if (t) t.classList.add("open"); // smooth max-height transition, no layout jerk
}
function _termClear() {
  const b = document.getElementById("ahTermBody");
  if (b) b.innerHTML = "";
}
function _termLine(text, cls) {
  const b = document.getElementById("ahTermBody");
  if (!b) return null;
  const ln = document.createElement("div");
  ln.className = "t-line " + (cls || "t-out");
  ln.textContent = text;
  b.appendChild(ln);
  b.scrollTop = b.scrollHeight;
  return ln;
}
function _termBadge(txt, ok) {
  const badge = document.getElementById("ahTermBadge");
  if (!badge) return;
  badge.textContent = txt || "";
  badge.className = "ah-term-badge" + (ok === true ? " ok" : ok === false ? " bad" : "");
}
function _termTitle(lang) {
  const t = document.getElementById("ahTermTitle");
  if (t) t.textContent = "user@ahad-co: ~ — " + (lang || "bash");
}

/* Execute code on the backend runner service — real output, not preview. */
async function executeCode() {
  const lang = document.getElementById("snippetLanguage").value;
  const code = cmEditor ? cmEditor.getValue() : document.getElementById("snippetContent").value;
  if (!code.trim()) { toast("Nothing to run!", "error"); return; }

  _termOpen(); _termClear(); _termTitle(lang); _termBadge("running…");

  // Prompt line — feels like a real shell
  _termLine("user@ahad-co:~$ run " + lang, "t-prompt");

  // Animated multi-stage waiting line — the runner scans imports, auto
  // installs libraries, then executes. Keep the user entertained meanwhile.
  const waitMsgs = [
    "code scan hocche — kon kon library lagbe…",
    "dorkari library auto-install hocche…",
    "code run hocche…",
  ];
  let waitIdx = 0;
  const spinner = _termLine(waitMsgs[0], "t-sys");
  const spinnerTimer = setInterval(() => {
    waitIdx = (waitIdx + 1) % waitMsgs.length;
    if (spinner && spinner.isConnected) spinner.textContent = waitMsgs[waitIdx];
  }, 2200);

  try {
    const result = await api("/api/execute", "POST", { language: lang, code: code }, true);
    clearInterval(spinnerTimer);
    if (spinner) spinner.remove();

    let shown = 0;
    // stdout — normal terminal text
    if (result.stdout) {
      result.stdout.replace(/\n+$/, "").split("\n").forEach(function(line) {
        _termLine(line, "t-out"); shown++;
      });
    }
    // stderr — red text (programs can legitimately write to BOTH streams)
    if (result.stderr) {
      result.stderr.replace(/\n+$/, "").split("\n").forEach(function(line) {
        _termLine(line, "t-err"); shown++;
      });
    }
    // runner-level error (compile failed, timeout, unsupported language...)
    if (result.error) {
      _termLine("✗ " + result.error, "t-err"); shown++;
    }
    if (!shown) _termLine("(no output)", "t-sys");

    const ok = result.success === true;
    const codeTxt = result.exit_code !== undefined ? result.exit_code : (ok ? 0 : "!");
    const ms = result.execution_time_ms !== undefined ? result.execution_time_ms : "?";
    _termLine("process exited · code " + codeTxt + " · " + ms + " ms", "t-foot " + (ok ? "ok" : "bad"));
    _termBadge(ok ? "exit 0" : ("exit " + codeTxt), ok);
  } catch (err) {
    clearInterval(spinnerTimer);
    if (spinner) spinner.remove();
    // HTTP-level failure (runner not configured, unreachable, timed out, ...)
    // — printed loudly instead of vanishing.
    _termLine("✗ " + (err && err.message ? err.message : "Request failed"), "t-err");
    _termLine("hint: check RUNNER_SERVICE_URL & RUNNER_SERVICE_SECRET on the main service", "t-sys");
    _termBadge("error", false);
  }
}

/* Update line-number gutter */
// NOTE: the hand-rolled line-number gutter was removed. Its target element
// (#csGutter) does not exist — CodeMirror renders the real gutter itself.
function updateGutter() { /* CodeMirror owns the gutter */ }

function initGutterScroll() { /* CodeMirror owns gutter scrolling */ }

/* initIdeDivider is now the close button for the preview panel */
function initIdeDivider() {
  const closeBtn = document.getElementById("ideDivider");
  if (closeBtn) closeBtn.addEventListener("click", () => togglePreviewPanel(false));
}

/* ==================== HELPERS ==================== */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t || ""); toast("Copied!", "success"); }
  catch (e) { toast("Copy failed", "error"); }
}

/* ==================== COMMAND PALETTE / SEARCH ==================== */
const _KIND_META = {
  snippet: ["code", "code"], runspace: ["rocket", "jobs"],
};
let _cmdTimer = null, _cmdResults = [], _cmdIndex = -1;

function openCommandPalette() {
  document.getElementById("cmdOverlay").classList.remove("hidden");
  const inp = document.getElementById("cmdInput");
  inp.value = ""; inp.focus();
  document.getElementById("cmdResults").innerHTML = `<div class="cmd-empty">Start typing to search everything you've saved…</div>`;
  _cmdResults = [];
}
function closeCommandPalette() { document.getElementById("cmdOverlay").classList.add("hidden"); }

async function runCommandSearch(q) {
  if (!q.trim()) { document.getElementById("cmdResults").innerHTML = `<div class="cmd-empty">Start typing to search everything you've saved…</div>`; _cmdResults = []; return; }
  try {
    const data = await api("/search?q=" + encodeURIComponent(q), "GET", null, true);
    _cmdResults = data.results || [];
    _cmdIndex = -1;
    renderCommandResults();
  } catch (err) { document.getElementById("cmdResults").innerHTML = `<div class="cmd-empty">Search failed: ${escapeHtml(err.message)}</div>`; }
}
function renderCommandResults() {
  const box = document.getElementById("cmdResults");
  if (!_cmdResults.length) { box.innerHTML = `<div class="cmd-empty">No results</div>`; return; }
  box.innerHTML = _cmdResults.map((r, i) => {
    const meta = _KIND_META[r.kind] || ["file", "overview"];
    return `<div class="cmd-item ${i === _cmdIndex ? "sel" : ""}" data-i="${i}" onclick="openSearchResult(${i})">
      <span class="cmd-ic">${ic(meta[0], "premium")}</span>
      <div class="cmd-text"><div class="cmd-title">${escapeHtml(r.title)}</div>${r.sub ? `<div class="cmd-sub">${escapeHtml(r.sub)}</div>` : ""}</div>
      <span class="cmd-kind">${r.kind}</span>
    </div>`;
  }).join("");
}
function openSearchResult(i) {
  const r = _cmdResults[i];
  if (!r) return;
  const tab = (_KIND_META[r.kind] || ["", "overview"])[1];
  closeCommandPalette();
  switchTab(tab);
}

/* ==================== THEME ==================== */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const slot = document.getElementById("themeIcon");
  if (slot) slot.innerHTML = ic(theme === "light" ? "sun" : "moon");
  try { localStorage.setItem("ahad_theme", theme); } catch (e) {}
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  applyTheme(cur === "light" ? "dark" : "light");
}
(function initTheme() {
  // Dark is the product's identity: the landing page, RunSpace and the code
  // editor are all hardcoded dark surfaces.
  //
  // THE OS PREFERENCE IS NOT CONSULTED, and that is a deliberate reversal.
  // Following it looked correct, but RunSpace and Code Studio contain ZERO
  // data-theme rules — they are dark whatever the OS says. So a phone in
  // light mode produced light chrome wrapped around permanently dark panels,
  // which is the "white middle" report. Reproduced: OS light -> data-theme
  // light -> glass renders rgba(255,255,255,.62) over #0d1117.
  //
  // Consulting the OS can come back the day every surface can honour it.
  // Until then an explicit choice in Settings is the only thing that switches
  // themes, and it still works exactly as before.
  //
  // This MUST agree with the inline script in index.html, which runs before
  // the stylesheets so the first paint is already correct. Two different
  // answers would mean a visible flip on every load.
  let saved = null;
  try { saved = localStorage.getItem("ahad_theme"); } catch (e) {}
  applyTheme(saved === "light" ? "light" : "dark");
})();

/* ==================== PROFILE ==================== */
async function saveProfile() {
  const phone = document.getElementById("profilePhone").value.trim();
  const custom_code = document.getElementById("profileCode").value.trim();
  try { await api("/profile/update", "POST", { phone, custom_code }, true); toast("Profile saved!", "success"); }
  catch (err) { toast(err.message, "error"); }
}

/* ==================== MODAL SHELL (shared) ==================== */
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove("hidden");
  m.classList.add("open");
}
function closeModal(elOrId) {
  const m = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
  if (!m) return;
  m.classList.remove("open");
  setTimeout(() => m.classList.add("hidden"), 160);
}
// overlay click + [data-close] buttons close any ah-modal; Esc closes the top one
document.addEventListener("click", e => {
  if (e.target.classList && e.target.classList.contains("ah-modal")) closeModal(e.target);
  const closer = e.target.closest && e.target.closest("[data-close]");
  if (closer) { const m = closer.closest(".ah-modal"); if (m) closeModal(m); }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".cs-canvas.full")) return; // fullscreen owns Esc
  const open = document.querySelector(".ah-modal.open");
  if (open) closeModal(open);
});

async function deleteAccount() {
  const c1 = confirm("Are you sure you want to DELETE your account permanently? This CANNOT be undone!");
  if (!c1) return;
  const password = prompt("Enter your password to confirm deletion:");
  if (!password) return;
  try {
    await api("/account/delete", "POST", { password }, true);
    toast("Account deleted. Goodbye.", "success");
    authToken = null;
    localStorage.removeItem("ahad_token");
    setTimeout(() => window.location.reload(), 2000);
  } catch (err) { toast(err.message, "error"); }
}

/* ==================== 2FA — GUIDED SETUP WIZARD + MANAGE ==================== */
let _tfa = { secret: "", qr: "", codes: [] };

function _tfaSetStep(n) {
  document.querySelectorAll("#tfaSteps .ah-dot").forEach(d => {
    d.classList.toggle("on", +d.dataset.s <= n);
  });
}
function _tfaStepsVisible(v) { document.getElementById("tfaSteps").style.display = v ? "" : "none"; }
function _tfaBody(html) { document.getElementById("tfaBody").innerHTML = html; }

async function manage2FA() {
  try {
    const st = await api("/2fa/status", "GET", null, true);
    openModal("tfaModal");
    if (st.enabled) _tfaShowManage(st); else _tfaShowStep1();
  } catch (err) { toast(err.message, "error"); }
}

/* ---- STEP 1: what 2FA is ---- */
function _tfaShowStep1() {
  _tfaStepsVisible(true); _tfaSetStep(1);
  document.getElementById("tfaTitle").textContent = "Set up two-factor authentication";
  _tfaBody(`
    <div class="tfa-hero">${ic("shield")}</div>
    <p class="tfa-p">Two-factor authentication asks for a <b>6-digit code</b> from an authenticator app
    (Google Authenticator, Authy…) every time you sign in — so a stolen password alone can't get into your account.</p>
    <button class="btn-primary block" onclick="_tfaStartSetup()">Get started</button>`);
}

/* ---- STEP 2: QR + manual key ---- */
async function _tfaStartSetup() {
  try {
    const data = await api("/2fa/setup", "POST", { enable: true }, true);
    _tfa = { secret: data.secret, qr: data.qr_code, codes: [] };
    _tfaSetStep(2);
    _tfaBody(`
      <p class="tfa-p"><b>1.</b> Scan this QR code with your authenticator app:</p>
      <div class="tfa-qr"><img src="${data.qr_code}" alt="Authenticator QR code"></div>
      <p class="tfa-p"><b>Can't scan?</b> Enter this key in the app by hand:</p>
      <div class="tfa-manual"><code>${data.secret}</code>
        <button class="xbtn" onclick="navigator.clipboard.writeText('${data.secret}').then(()=>toast('Secret key copied','success'))">${ic("copy")} Copy</button>
      </div>
      <button class="btn-primary block" onclick="_tfaShowVerify()">Next — verify code</button>`);
  } catch (err) { toast(err.message, "error"); }
}

/* ---- STEP 3: confirm a live code (segmented boxes, like the auth screens) ---- */
function _tfaShowVerify() {
  _tfaSetStep(3);
  _tfaBody(`
    <p class="tfa-p"><b>2.</b> Enter the <b>6-digit code</b> now showing in your authenticator app:</p>
    <div class="otp-boxes tfa-otp" id="tfaOtpBoxes">
      <input type="text" maxlength="1" inputmode="numeric"><input type="text" maxlength="1" inputmode="numeric"><input type="text" maxlength="1" inputmode="numeric"><input type="text" maxlength="1" inputmode="numeric"><input type="text" maxlength="1" inputmode="numeric"><input type="text" maxlength="1" inputmode="numeric">
    </div>
    <p class="tfa-err" id="tfaErr"></p>
    <button class="btn-primary block" id="tfaVerifyBtn" onclick="_tfaVerify()">Verify &amp; enable</button>`);
  const boxes = document.querySelectorAll("#tfaOtpBoxes input");
  if (boxes[0]) boxes[0].focus();
  setupOtpBoxes("tfaOtpBoxes", _tfaVerify);
}
async function _tfaVerify() {
  const code = getOtpValue("tfaOtpBoxes");
  if (code.length !== 6) { toast("Enter the full 6-digit code", "error"); return; }
  const errEl = document.getElementById("tfaErr");
  try {
    const btn = document.getElementById("tfaVerifyBtn"); if (btn) { btn.disabled = true; btn.textContent = "Verifying…"; }
    const r = await api("/2fa/verify-setup", "POST", { code }, true);
    _tfa.codes = r.backup_codes || [];
    _tfaShowBackupCodes(true);
    refreshSecurityPanel();
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; }
    document.getElementById("tfaOtpBoxes").classList.add("otp-err");
    setTimeout(() => document.getElementById("tfaOtpBoxes").classList.remove("otp-err"), 400);
    clearOtpBoxes("tfaOtpBoxes");
    const boxes = document.querySelectorAll("#tfaOtpBoxes input"); if (boxes[0]) boxes[0].focus();
    const btn = document.getElementById("tfaVerifyBtn"); if (btn) { btn.disabled = false; btn.textContent = "Verify & enable"; }
  }
}

/* ---- STEP 4: single-use backup codes ---- */
function _tfaShowBackupCodes(freshlyEnabled) {
  _tfaSetStep(4);
  document.getElementById("tfaTitle").textContent = freshlyEnabled ? "2FA is on — save your backup codes" : "New backup codes";
  const codes = _tfa.codes;
  _tfaBody(`
    ${freshlyEnabled ? `<p class="tfa-ok">${ic("check")} Two-factor authentication enabled.</p>` : ""}
    <p class="tfa-p">Save these <b>${codes.length} backup codes</b> somewhere safe — <b>each works once</b> if you lose access to your authenticator app.</p>
    <div class="bc-grid">${codes.map(c => `<code>${c}</code>`).join("")}</div>
    <div class="bc-actions">
      <button class="xbtn" onclick="_tfaDownloadCodes()">${ic("download")} Download codes</button>
      <button class="xbtn" onclick="navigator.clipboard.writeText(_tfa.codes.join('\\n')).then(()=>toast('All codes copied','success'))">${ic("copy")} Copy all</button>
    </div>
    <label class="bc-confirm"><input type="checkbox" id="tfaSavedChk"> I've saved these codes somewhere safe</label>
    <button class="btn-primary block" id="tfaDoneBtn" disabled onclick="closeModal('tfaModal');refreshSecurityPanel()">Done</button>`);
  const chk = document.getElementById("tfaSavedChk");
  const done = document.getElementById("tfaDoneBtn");
  chk.addEventListener("change", () => { done.disabled = !chk.checked; });
}
/** Trigger a browser download for a Blob. */
function _downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

function _tfaDownloadCodes() {
  const txt = "CodeNest — 2FA backup codes\nSave these somewhere safe. Each code works ONCE.\n\n" + _tfa.codes.join("\n") + "\n";
  _downloadBlob(new Blob([txt], { type: "text/plain;charset=utf-8" }),
    `ahadco-backup-codes-${new Date().toISOString().split("T")[0]}.txt`);
}

/* ---- MANAGE VIEW (when already enabled) ---- */
function _tfaShowManage(st) {
  _tfaStepsVisible(false);
  document.getElementById("tfaTitle").textContent = "Two-factor authentication";
  _tfaBody(`
    <div class="tfa-status">
      <span class="chip on">Enabled</span>
      <span class="tfa-meta">${st.backup_codes_count} backup code${st.backup_codes_count === 1 ? "" : "s"} left</span>
    </div>
    <div class="tfa-man-block">
      <h4>Regenerate backup codes</h4>
      <p>Old codes stop working. Confirm with your password + a current authenticator code.</p>
      <button class="btn-secondary block" onclick="_tfaMiniForm('regen')">Regenerate</button>
      <div class="tfa-mini hidden" id="tfaMiniRegen">
        <input type="password" id="regen_pw" class="input-text" placeholder="Password" autocomplete="current-password">
        <input type="text" id="regen_code" class="input-text" placeholder="6-digit authenticator code" inputmode="numeric" maxlength="6">
        <button class="btn-primary block" onclick="_tfaRegen()">Confirm &amp; regenerate</button>
      </div>
    </div>
    <div class="tfa-man-block danger-lite">
      <h4>Disable two-factor authentication</h4>
      <p>Your account will be protected by password only.</p>
      <button class="btn-ghost block tfa-dis-btn" onclick="_tfaMiniForm('disable')">Disable 2FA</button>
      <div class="tfa-mini hidden" id="tfaMiniDisable">
        <input type="password" id="dis_pw" class="input-text" placeholder="Password" autocomplete="current-password">
        <input type="text" id="dis_code" class="input-text" placeholder="6-digit or backup code" inputmode="text">
        <button class="btn-danger block" onclick="_tfaDisable()">Confirm disable</button>
      </div>
    </div>`);
}
function _tfaMiniForm(which) {
  const el = document.getElementById(which === "regen" ? "tfaMiniRegen" : "tfaMiniDisable");
  if (el) el.classList.toggle("hidden");
}
async function _tfaRegen() {
  const password = document.getElementById("regen_pw").value;
  const code = document.getElementById("regen_code").value.trim();
  if (!password || !code) { toast("Enter your password and code", "error"); return; }
  try {
    const r = await api("/2fa/backup-codes", "POST", { password, code }, true);
    _tfa.codes = r.backup_codes || [];
    _tfaStepsVisible(true);
    _tfaShowBackupCodes(false);
  } catch (err) { toast(err.message, "error"); }
}
async function _tfaDisable() {
  const password = document.getElementById("dis_pw").value;
  const code = document.getElementById("dis_code").value.trim();
  if (!password || !code) { toast("Enter your password and code", "error"); return; }
  try {
    await api("/2fa/disable", "POST", { password, code }, true);
    toast("Two-factor authentication disabled", "success");
    closeModal("tfaModal");
    refreshSecurityPanel();
  } catch (err) { toast(err.message, "error"); }
}

/* ==================== SETTINGS: CHANGE PASSWORD ==================== */
async function openChangePassword() {
  ["cp_current", "cp_new", "cp_confirm", "cp_totp"].forEach(id => { const e = document.getElementById(id); if (e) e.value = ""; });
  const lbl = document.getElementById("strengthLabel4"), fill = document.getElementById("strengthFill4");
  if (lbl) lbl.textContent = ""; if (fill) fill.style.width = "0";
  openModal("pwModal");
  // Show the 2FA field only when the account actually has 2FA on
  try {
    const st = await api("/2fa/status", "GET", null, true);
    document.getElementById("cpTotpRow").classList.toggle("hidden", !st.enabled);
  } catch (e) {}
}
async function submitChangePassword() {
  const current = document.getElementById("cp_current").value;
  const next = document.getElementById("cp_new").value;
  const conf = document.getElementById("cp_confirm").value;
  const totp = document.getElementById("cp_totp").value.trim();
  if (!current || !next) { toast("Fill in your current and new password", "error"); return; }
  if (next.length < 6) { toast("New password must be at least 6 characters", "error"); return; }
  if (next !== conf) { toast("New passwords don't match", "error"); return; }
  const btn = document.getElementById("cpSubmit");
  if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  try {
    const r = await api("/account/change-password", "POST", {
      current_password: current, new_password: next, totp_code: totp || null,
    }, true);
    logEvent("success", "Password changed", `${r.other_sessions_revoked} other device(s) signed out`);
    document.getElementById("pwBody").innerHTML = `
      <div class="pw-done">
        <div class="success-ring">✓</div>
        <h3>Password updated</h3>
        <p class="auth-hint">For your security, <b>all other devices have been signed out</b>${r.other_sessions_revoked ? ` (${r.other_sessions_revoked} session${r.other_sessions_revoked === 1 ? "" : "s"})` : ""}.</p>
        <button class="btn-primary block" onclick="closeModal('pwModal')">Done</button>
      </div>`;
    refreshSecurityPanel();
  } catch (err) {
    toast(err.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Update password"; }
  }
}

/* ==================== SETTINGS: ACTIVE SESSIONS ==================== */
function _sessDevice(ua) {
  const s = (ua || "").toLowerCase();
  const isMobile = /mobile|android|iphone|ipod/.test(s);
  const icon = isMobile ? "phone" : "server";
  let os = "Device";
  if (/windows/.test(s)) os = "Windows";
  else if (/android/.test(s)) os = "Android";
  else if (/iphone|ipad|ios/.test(s)) os = "iPhone / iPad";
  else if (/mac os|macintosh/.test(s)) os = "Mac";
  else if (/linux/.test(s)) os = "Linux";
  let br = "";
  if (/edg\//.test(s)) br = "Edge";
  else if (/chrome\//.test(s)) br = "Chrome";
  else if (/firefox\//.test(s)) br = "Firefox";
  else if (/safari\//.test(s) && !/chrome/.test(s)) br = "Safari";
  return { icon, label: br ? `${br} on ${os}` : os };
}
async function loadSessionsList() {
  const box = document.getElementById("sessList");
  if (!box) return;
  try {
    const data = await api("/sessions", "GET", null, true);
    const rows = data.sessions || [];
    if (!rows.length) { box.innerHTML = `<div class="muted" style="font-size:13px">No active sessions.</div>`; return; }
    box.innerHTML = rows.map(r => {
      const d = _sessDevice(r.device_info);
      const seen = r.last_seen ? new Date(r.last_seen).toLocaleString() : "";
      return `<div class="sess-row">
        <span class="sess-ic">${ic(d.icon)}</span>
        <div class="sess-tx">
          <b>${escapeHtml(d.label)}${r.is_current ? ' <span class="chip on sm">This device</span>' : ""}</b>
          <small>${escapeHtml(r.ip_address || "unknown ip")} · last active ${escapeHtml(seen)}</small>
        </div>
        ${r.is_current ? "" : `<button class="xbtn danger" onclick="revokeSession(${r.id})" title="Sign this device out">${ic("log-out")} Revoke</button>`}
      </div>`;
    }).join("");
  } catch (err) { box.innerHTML = `<div class="muted" style="font-size:13px">Couldn't load sessions.</div>`; }
}
async function revokeSession(id) {
  try {
    await api("/sessions/revoke", "POST", { session_id: id }, true);
    toast("Device signed out", "success");
    logEvent("warning", "Session revoked", "A device was signed out from Settings");
    loadSessionsList();
  } catch (err) { toast(err.message, "error"); }
}

/* ==================== SECURITY PANEL REFRESH ==================== */
async function refreshSecurityPanel() {
  try {
    const st = await api("/2fa/status", "GET", null, true);
    const chip = document.getElementById("tfaChip");
    if (chip) {
      chip.textContent = st.enabled ? "Enabled" : "Disabled";
      chip.className = "chip" + (st.enabled ? " on" : "");
    }
    const meta = document.getElementById("tfaMeta");
    if (meta) meta.textContent = st.enabled ? `Backup codes: ${st.backup_codes_count} left` : "Adds a second lock on top of your password.";
  } catch (e) {}
  const pw = document.getElementById("pwChangedAt");
  if (pw && _lastProfile) {
    const when = _lastProfile.password_changed_at || _lastProfile.created_at;
    if (when) pw.textContent = "Last changed: " + new Date(when).toLocaleDateString();
  }
  refreshTelegramCard();
}

/* ==================== TELEGRAM LINK ==================== */
/* The bot refuses every chat that is not bound to an account — before this
   existed a stranger could deploy code to the server. The code is issued
   HERE, to a logged-in session, and never to the chat, because a code the bot
   could hand out is a code an attacker could ask for. */
async function refreshTelegramCard() {
  const chip = document.getElementById("tgChip");
  if (!chip) return;
  try {
    const st = await api("/profile/telegram", "GET", null, true);
    chip.textContent = st.linked ? "Connected" : "Not connected";
    chip.className = "chip" + (st.linked ? " on" : "");
    const btn = document.getElementById("btnTelegram");
    if (btn) btn.textContent = st.linked ? "Manage Telegram" : "Connect Telegram";
    const meta = document.getElementById("tgMeta");
    if (meta) {
      // Name first: a bare chat id is not something a person recognises, so
      // "connected" without a WHO cannot be checked by the account owner.
      meta.textContent = st.linked
        ? (st.telegram_name
            ? `${st.telegram_name} · ID ${st.telegram_id}`
            : `Chat ID ${st.telegram_id}`)
        : "Not connected — the bot will ignore you until you link.";
    }
  } catch (e) { /* not signed in yet */ }
}

async function manageTelegram() {
  const body = document.getElementById("tgModalBody");
  if (!body) return;
  body.textContent = "";
  openModal("tgModal");
  let st;
  try {
    st = await api("/profile/telegram", "GET", null, true);
  } catch (e) { toast(e.message, "error"); return; }

  if (st.linked) {
    document.getElementById("tgModalTitle").textContent = "Telegram connected";
    const p = document.createElement("p");
    p.className = "auth-hint";
    p.textContent = (st.telegram_name
        ? `This account answers ${st.telegram_name} (ID ${st.telegram_id}). `
        : `This account answers Telegram chat ${st.telegram_id}. `) +
      "Disconnecting stops the bot from deploying anything on your behalf.";
    const btn = document.createElement("button");
    btn.className = "btn-danger block";
    btn.textContent = "Disconnect Telegram";
    btn.onclick = async () => {
      setLoading(btn, true);
      try {
        await api("/profile/telegram/unlink", "POST", {}, true);
        toast("Telegram disconnected.", "success");
        closeModal("tgModal");
        refreshTelegramCard();
      } catch (e) { toast(e.message, "error"); }
      finally { setLoading(btn, false); }
    };
    body.append(p, btn);
    return;
  }

  /* ONE TAP.
     The old flow was nine steps and three of them were places a person could
     fail: read a 6-digit code off the screen, find the bot by name, retype
     the code from memory. Telegram's own answer is a deep link —
     t.me/<bot>?start=<code> shows a START button, and pressing it delivers
     the code as a message. So the code still exists and still expires; the
     user just never has to see it. The manual code stays visible as a
     fallback, because a deep link cannot work on a desktop with no Telegram
     installed, and because TELEGRAM_BOT_USERNAME may be unset. */
  document.getElementById("tgModalTitle").textContent = "Connect Telegram";
  const intro = document.createElement("p");
  intro.className = "auth-hint";
  intro.textContent = "Tap below. Telegram opens, you press START, and you are connected.";

  const openBtn = document.createElement("a");
  openBtn.className = "btn-primary block tg-open";
  openBtn.textContent = "🤖 Connect bot to account";
  openBtn.target = "_blank";
  openBtn.rel = "noopener";

  const fallback = document.createElement("details");
  fallback.className = "tg-fallback";
  const sum = document.createElement("summary");
  sum.textContent = "Telegram not installed here?";
  const codeBox = document.createElement("div");
  codeBox.className = "tg-code";
  codeBox.textContent = "······";
  const step = document.createElement("p");
  step.className = "auth-hint";
  fallback.append(sum, codeBox, step);

  const status = document.createElement("p");
  status.className = "auth-hint tg-waiting";

  async function issue() {
    const r = await api("/profile/telegram/code", "POST", {}, true);
    codeBox.textContent = r.code;
    // textContent, not innerHTML — the bot username comes from an env var and
    // has no business being parsed as markup.
    step.textContent = r.bot_username
      ? `Open @${r.bot_username} and send:  /link ${r.code}  (expires in ${r.expires_in_min} min)`
      : `Send  /link ${r.code}  to the bot (expires in ${r.expires_in_min} min)`;
    return r;
  }

  openBtn.onclick = async (e) => {
    // The href is only known AFTER the code is issued, so the first tap has
    // to fetch and then navigate. Minting the code on modal-open instead
    // would kill a code the user is already part-way through using, since
    // each new code replaces the last.
    if (openBtn.dataset.ready === "1") { _tgPoll(); return; }
    e.preventDefault();
    setLoading(openBtn, true);
    try {
      const r = await issue();
      if (!r.deep_link) {
        // No bot username configured — the deep link cannot be built, so say
        // so plainly instead of opening a broken t.me URL.
        openBtn.remove();
        fallback.open = true;
        status.textContent = "Use the code below to connect.";
        _tgPoll();
        return;
      }
      openBtn.href = r.deep_link;
      openBtn.dataset.ready = "1";
      status.textContent = "Waiting for you to press START in Telegram…";
      _tgPoll();
      window.open(r.deep_link, "_blank", "noopener");
    } catch (err) { toast(err.message, "error"); }
    finally { setLoading(openBtn, false); }
  };

  body.append(intro, openBtn, status, fallback);
}

let _tgPollTimer = null;
function _tgPoll() {
  if (_tgPollTimer) clearInterval(_tgPollTimer);
  let ticks = 0;
  _tgPollTimer = setInterval(async () => {
    // Bounded: a code lives 10 minutes, so 60 checks at 5s covers it and then
    // stops rather than polling this account forever.
    if (++ticks > 60) { clearInterval(_tgPollTimer); _tgPollTimer = null; return; }
    try {
      const st = await api("/profile/telegram", "GET", null, true);
      if (st.linked) {
        clearInterval(_tgPollTimer); _tgPollTimer = null;
        closeModal("tgModal");
        toast("Telegram connected.", "success");
        refreshTelegramCard();
      }
    } catch (e) { /* keep waiting */ }
  }, 5000);
}
let _lastProfile = null;

/* ==================== STATS ==================== */
async function loadStats() {
  try {
    const data = await api("/stats", "GET", null, true);
    const sj = document.getElementById("statJobs"); if (sj) sj.textContent = data.jobs_total || 0;
    const sl = document.getElementById("statLive"); if (sl) sl.textContent = data.jobs_deployed || 0;
    const ss = document.getElementById("statSnippets"); if (ss) ss.textContent = data.snippets || 0;
    const sp = document.getElementById("statPublished"); if (sp) sp.textContent = data.published || 0;
  } catch (err) { console.error("Load stats error:", err); }
}

/* ==================== INIT & EVENT WIRING ==================== */

// Re-establish the correct screen based on the CURRENT token. Used at boot and
// when the page is restored from the browser's back/forward cache (bfcache),
// which otherwise can resurrect a stale auth screen with the user's old form
// data still in it.
/* ==================== CLIENT-SIDE ROUTING ====================
   Every section has a REAL URL (/code, /jobs …) — like a proper SaaS:
     • switchTab pushes the path → browser back/forward walk sections
     • refresh on /jobs boots straight into RunSpace (no bounce to dashboard)
     • links can be bookmarked/shared; logged-out visits to protected paths
       bounce to /sign-in and RETURN after successful login. */
const ROUTES = {
  "/dashboard": "overview", "/code": "code",
  "/runspace": "jobs", "/jobs": "jobs",
  "/terminal": "term", "/term": "term",
  "/admin": "admin", "/profile": "profile",
};
// /runspace/{username}/{tabname}          -> editor
// /runspace/{username}/{tabname}/page     -> Details page (§5)
const _JOB_PATH_RE = /^\/runspace\/([^/]+)\/([^/]+?)(\/page)?\/?$/;
const TAB_PATHS = {};
Object.keys(ROUTES).forEach(p => { if (!TAB_PATHS[ROUTES[p]]) TAB_PATHS[ROUTES[p]] = p; });
const AUTH_ROUTES = {
  "/sign-in": "screen-signin", "/login": "screen-signin",
  "/sign-up": "screen-signup", "/forgot": "screen-forgot1",
};
let _routeNav = false;   // guard: a popstate-driven switchTab must not re-push

function _clientPath() {
  let p = (window.location.pathname || "/").replace(/\/+$/, "");
  return p || "/";
}

/* Apply the current browser URL to app state. Returns a truthy tag when the
   URL decided a screen (so callers don't fall back to the landing page). */
function routeFromUrl() {
  const p = _clientPath();
  const hasToken = !!localStorage.getItem("ahad_token");
  const _switch = (tab) => { _routeNav = true; switchTab(tab); _routeNav = false; };

  if (p === "/activity") {
    if (!hasToken) {
      try { sessionStorage.setItem("ahad_return_to", p); } catch (e2) {}
      history.replaceState({}, "", "/sign-in");
      showScreen("screen-signin");
      return "blocked";
    }
    showScreen("screen-dashboard");
    if (currentTab !== "overview") _switch("overview");
    if (typeof openActivityPanel === "function") openActivityPanel();
    return "tab";
  }
  if (ROUTES[p]) {                                  // protected section URL
    if (!hasToken) {                                // standard "return after login"
      try { sessionStorage.setItem("ahad_return_to", p); } catch (e2) {}
      history.replaceState({}, "", "/sign-in");
      showScreen("screen-signin");
      return "blocked";
    }
    showScreen("screen-dashboard");
    if (ROUTES[p] !== currentTab) _switch(ROUTES[p]);
    return "tab";
  }
  // Deep link: /runspace/{username}/{slug} → open RunSpace and select the matching job.
  const _jd = p.match(_JOB_PATH_RE);
  if (_jd) {
    if (!hasToken) {
      try { sessionStorage.setItem("ahad_return_to", p); } catch (e2) {}
      history.replaceState({}, "", "/sign-in");
      showScreen("screen-signin");
      return "blocked";
    }
    showScreen("screen-dashboard");
    const _slug = decodeURIComponent(_jd[2] || "");
    const _wantDetails = !!_jd[3];            // the "/page" suffix
    // Back/Forward between the editor and its Details page: the job is already
    // selected, so just toggle the view instead of reloading everything.
    const _cur = (window._lastJobs || []).find(x => String(x.id) === String(_selectedJobId));
    if (currentTab === "jobs" && _cur && _slugify(_cur.name) === _slug) {
      if (_wantDetails && !_jdOpen) openJobDetails(null, {noUrl: true});
      else if (!_wantDetails && _jdOpen) closeJobDetails({noUrl: true});
      return "tab";
    }
    window.__rs_deep_slug = _slug;
    window.__rs_deep_details = _wantDetails;
    if (currentTab !== "jobs") _switch("jobs");
    else _deepSelectJobBySlug(window.__rs_deep_slug);
    return "tab";
  }
  if (AUTH_ROUTES[p]) {
    if (hasToken) {                                 // signed-in users skip auth screens
      history.replaceState({}, "", "/dashboard");
      showScreen("screen-dashboard");
      if (currentTab !== "overview") _switch("overview");
      return "tab";
    }
    showScreen(AUTH_ROUTES[p]);
    return "auth";
  }
  if (p === "/" && hasToken) {                      // SaaS convention: / → /dashboard
    try { history.replaceState({}, "", "/dashboard"); } catch (e3) {}
    return "tab";
  }
  return null;
}

/* After successful login/verification: go back where the user wanted to be. */
function _consumeReturnTo() {
  let rt = null;
  try { rt = sessionStorage.getItem("ahad_return_to"); } catch (e) {}
  if (rt && (ROUTES[rt] || rt === "/activity")) {
    try { sessionStorage.removeItem("ahad_return_to"); } catch (e2) {}
    try { history.replaceState({}, "", rt); } catch (e3) {}
    _routeNav = true;
    switchTab(ROUTES[rt] || "overview");
    _routeNav = false;
    if (rt === "/activity" && typeof openActivityPanel === "function") openActivityPanel();
  } else {
    // Never clobber the address bar if the user already navigated into a
    // section while the dashboard was still loading (e.g. quick-click on
    // RunSpace right after sign-in) — the URL is the user's truth.
    const cur = _clientPath();
    if (!ROUTES[cur] && cur !== "/dashboard") {
      try { history.replaceState({}, "", "/dashboard"); } catch (e4) {}
    }
  }
}

// Browser back/forward: derive the visible screen purely from the URL.
window.addEventListener("popstate", () => { routeFromUrl(); });

function reconcileScreen() {
  const hasToken = !!localStorage.getItem("ahad_token");
  if (hasToken) {
    authToken = localStorage.getItem("ahad_token");
    showScreen("screen-dashboard");
    loadDashboard().catch(() => { /* loadDashboard handles its own errors */ });
    routeFromUrl();   // honor deep links (/code, /jobs…) after auth restore
  } else if (localStorage.getItem("ahad_signup_username")) {
    // A verification was in progress — keep them on the OTP screen.
    restoreOtpScreen();
  } else {
    authToken = null;
    if (!routeFromUrl()) showScreen("screen-landing");  // /sign-in / protected / plain
  }
}

window.addEventListener("pageshow", (event) => {
  // Page restored from bfcache (e.g. user pressed Back from another site).
  // Force the screen back in sync with the real auth state.
  if (event.persisted) {
    reconcileScreen();
    document.documentElement.classList.remove("booting");
    const splash = document.getElementById("bootSplash");
    if (splash) splash.style.display = "none";
  }
});

/* Fatal-error visibility: a silent exception used to leave buttons dead with
   no explanation. Surface it once so a real bug can never hide again.
   Errors DURING BOOT get a friendly full-screen "something went wrong —
   reload" page (our error boundary), so the app never renders half-dead. */
let _fatalToasts = 0;
let _bootOk = false;   // flips true once DOMContentLoaded wiring finishes

function _fatalOverlay(message) {
  if (document.getElementById("fatalOverlay")) return;
  const div = document.createElement("div");
  div.id = "fatalOverlay";
  div.className = "fatal-overlay";
  div.innerHTML =
    '<div class="fatal-card">' +
      '<div class="fatal-ic">' + ic("alert") + '</div>' +
      '<h1>Something went wrong</h1>' +
      '<p>The app hit an unexpected error while starting up.</p>' +
      (message ? '<code>' + escapeHtml(String(message).slice(0, 200)) + '</code>' : '') +
      '<div class="fatal-btns">' +
      '<button class="btn-primary" onclick="document.getElementById(\'fatalOverlay\').remove()">Dismiss</button></div>' +
    '</div>';
  document.body.appendChild(div);
}

window.addEventListener("error", (e) => {
  if (!e || !e.message) return;
  if (!_bootOk) { _fatalOverlay(e.message); return; }
  if (_fatalToasts >= 3) return;
  _fatalToasts += 1;
  toast("UI error: " + String(e.message).slice(0, 120), "error");
});

document.addEventListener("DOMContentLoaded", () => {
  // Logout
  const btnLogoutEl = document.getElementById("btnLogout");
  if (btnLogoutEl) btnLogoutEl.addEventListener("click", async () => {
    // Tear the dashboard down BEFORE leaving it. Without this, RunSpace body
    // classes, the jobs poller and the log stream survived sign-out and the
    // landing page rendered with leftover layout/scroll-lock state.
    try { stopLogStream(); } catch (e) {}
    try { stopJobPolling(); } catch (e) {}
    try { if (typeof _jdOpen !== "undefined" && _jdOpen) closeJobDetails({ noUrl: true }); } catch (e) {}
    document.body.classList.remove(
      "rs-active", "rs-detail-open", "rs-drawer-open",
      "rs-side-open", "rs-logs-open", "code-active", "term-kbd-up"
    );

    // Fade out, then swap screens on the next frame so the transition is seen.
    document.body.classList.add("signing-out");
    try { await api("/logout", "POST", null, true); } catch (e) {}
    logEvent("info", "Signed out", "Session ended");
    authToken = null;
    localStorage.removeItem("ahad_token");
    localStorage.removeItem("ahad_user");
    resetLocalActivity();   // next account on this device starts with a clean feed

    setTimeout(() => {
      showScreen("screen-landing");
      try { history.replaceState({}, "", "/"); } catch (e) {}
      document.body.classList.remove("signing-out");
      document.body.classList.add("signed-out-in");
      setTimeout(() => document.body.classList.remove("signed-out-in"), 420);
      toast("Signed out", "success");
    }, 180);
  });

  // Code IDE wiring
  const btnSaveSnippet = document.getElementById("btnSaveSnippet");
  if (btnSaveSnippet) btnSaveSnippet.addEventListener("click", saveSnippet);
  const btnRunSnippet = document.getElementById("btnRunSnippet");
  if (btnRunSnippet) btnRunSnippet.addEventListener("click", () => { togglePreviewPanel(); });
  // ▶ Run button → real execution in the bottom terminal
  const btnRunCode = document.getElementById("btnRunCode");
  if (btnRunCode) btnRunCode.addEventListener("click", () => { executeCode(); });
  // terminal close button
  const ahTermClose = document.getElementById("ahTermClose");
  if (ahTermClose) ahTermClose.addEventListener("click", () => {
    const t = document.getElementById("ahTerm");
    if (t) t.classList.remove("open");
  });
  // ⚡ Always-On Jobs wiring
  const btnStartJob = document.getElementById("btnStartJob");
  if (btnStartJob) btnStartJob.addEventListener("click", startJob);
  const jobLogClose = document.getElementById("jobLogClose");
  if (jobLogClose) jobLogClose.addEventListener("click", () => { deselectJob(); });
  // (RunSpace log controls are wired in _initIDEWiring to avoid double-binding)
  // (log-body auto-follow is wired in _initIDEWiring after the CM editor is up)
  const btnFormatSnippet = document.getElementById("btnFormatSnippet");
  if (btnFormatSnippet) btnFormatSnippet.addEventListener("click", formatSnippet);
  const btnShareSnippet = document.getElementById("btnShareSnippet");
  if (btnShareSnippet) btnShareSnippet.addEventListener("click", shareCurrentSnippet);
  const btnNewSnippet = document.getElementById("btnNewSnippet");
  if (btnNewSnippet) btnNewSnippet.addEventListener("click", newSnippetDraft);
  // editor live updates (debounced) + meta + language change + Tab key
  const snippetContent = document.getElementById("snippetContent");
  if (snippetContent) {
    snippetContent.addEventListener("input", () => {
      updateEditorMeta();
      updateGutter();
      clearTimeout(_livePreviewTimer);
      // Only web languages get live preview — re-writing the iframe on every
      // keystroke while typing Python/C/Java caused constant flicker.
      const l = (document.getElementById("snippetLanguage").value || "").toLowerCase();
      if (_RUNNABLE_LANGS[l]) _livePreviewTimer = setTimeout(runLivePreview, 400);
    });
    snippetContent.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const s = e.target, start = s.selectionStart, end = s.selectionEnd;
        s.value = s.value.substring(0, start) + "  " + s.value.substring(end);
        s.selectionStart = s.selectionEnd = start + 2;
        updateEditorMeta();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        // Web languages (HTML/CSS/JS/MD) → live iframe preview.
        // Everything else (Python, C, Go...) → real run in the terminal.
        const curLang = (document.getElementById("snippetLanguage").value || "").toLowerCase();
        if (_RUNNABLE_LANGS[curLang]) { runLivePreview(); } else { executeCode(); }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveSnippet(); }
    });
  }
  const snippetLanguage = document.getElementById("snippetLanguage");
  if (snippetLanguage) snippetLanguage.addEventListener("change", () => { updateCodeMirrorMode(); syncRunPreviewButtons(); runLivePreview(); });
  try { initCodeMirror(); } catch (e) { console.error("initCodeMirror:", e); }
  // These editor helpers must never block the wiring of the REST of the app.
  try { syncRunPreviewButtons(); } catch (e) { console.error("syncRunPreviewButtons:", e); }
  try { initIdeDivider(); } catch (e) { console.error("initIdeDivider:", e); }
  try { initGutterScroll(); } catch (e) { console.error("initGutterScroll:", e); }
  const btnEditorFull = document.getElementById("btnEditorFull");
  if (btnEditorFull) btnEditorFull.addEventListener("click", toggleEditorFullscreen);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { const c = document.querySelector(".cs-canvas.full"); if (c) toggleEditorFullscreen(); }
  });
  // Tab click handlers (desktop)
  document.querySelectorAll(".dash-tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Mobile bottom-nav items
  document.querySelectorAll(".bn-item").forEach(b => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });

  // Password strength
  const pw = document.getElementById("su_password");
  if (pw) pw.addEventListener("input", e => {
    checkStrength(e.target.value, document.getElementById("strengthFill"), document.getElementById("strengthLabel"));
  });
  const pw3 = document.getElementById("fp_newpass");
  if (pw3) pw3.addEventListener("input", e => {
    checkStrength(e.target.value, document.getElementById("strengthFill3"), document.getElementById("strengthLabel3"));
  });

  // Delete account wiring (2FA button uses inline onclick="manage2FA()")
  document.querySelectorAll(".btn-danger").forEach(b => {
    if (b.textContent.includes("Delete Account")) b.addEventListener("click", e => { e.preventDefault(); deleteAccount(); });
  });
  // Live strength meter inside the change-password modal
  const pw4 = document.getElementById("cp_new");
  if (pw4) pw4.addEventListener("input", e => {
    checkStrength(e.target.value, document.getElementById("strengthFill4"), document.getElementById("strengthLabel4"));
  });

  // Marketing mobile nav (burger -> sheet)
  const burger = document.getElementById("navBurger");
  const navSheet = document.getElementById("navSheet");
  if (burger && navSheet) burger.addEventListener("click", () => navSheet.classList.toggle("hidden"));

  // Mobile bottom nav "Menu" → left side drawer (full-height, standard)
  const bnMore = document.getElementById("bnMore");
  if (bnMore) bnMore.addEventListener("click", (e) => { e.preventDefault(); openSideMenu(); });
  const sideMenuBtn = document.getElementById("sideMenuBtn");
  if (sideMenuBtn) sideMenuBtn.addEventListener("click", openSideMenu);
  const sideOverlay = document.getElementById("sideOverlay");
  if (sideOverlay) sideOverlay.addEventListener("click", closeSideMenu);
  // DELEGATED, not bound per button.
  //
  // BUG THIS FIXES: this used to attach a listener to each .dash-tab that
  // existed AT BOOT. The Admin button does not — the server strips it from the
  // shell so its existence is not discoverable, and applyAdminVisibility()
  // injects it once the profile confirms an admin. That injected button
  // therefore never got closeSideMenu, so opening the drawer and tapping
  // Admin left the menu covering the console. Reproduced: after click,
  // open = true.
  //
  // A delegated listener on the container covers every tab, including any
  // added later, so the same bug cannot come back with the next dynamic tab.
  const _tabsBar = document.querySelector(".dash-tabs");
  if (_tabsBar) {
    _tabsBar.addEventListener("click", (e) => {
      if (e.target.closest(".dash-tab")) closeSideMenu();
    });
  }
  const btnActivitySide = document.getElementById("btnActivitySide");
  if (btnActivitySide) btnActivitySide.addEventListener("click", () => { closeSideMenu(); openActivityPanel(); });

  // Desktop sidebar collapse → icon-only (persisted)
  const dashRoot = document.querySelector(".dashboard");
  const sideCollapse = document.getElementById("sideCollapse");
  const _applySideMin = on => {
    if (dashRoot) dashRoot.classList.toggle("side-min", on);
    try { localStorage.setItem("ahad_side_min", on ? "1" : "0"); } catch (e) {}
  };
  if (sideCollapse) sideCollapse.addEventListener("click", () => {
    _applySideMin(!(dashRoot && dashRoot.classList.contains("side-min")));
  });
  try { if (localStorage.getItem("ahad_side_min") === "1") _applySideMin(true); } catch (e) {}
  const moreOverlay = document.getElementById("moreOverlay");
  if (moreOverlay) moreOverlay.addEventListener("click", closeMoreSheet);
  const bnLogout = document.getElementById("bnLogout");
  if (bnLogout) bnLogout.addEventListener("click", () => document.getElementById("btnLogout").click());
  // Mobile search button in bottom nav
  const bnSearch = document.getElementById("bnSearch");
  if (bnSearch) bnSearch.addEventListener("click", openCommandPalette);

  // Command palette wiring (Ctrl/Cmd+K, button, overlay, keyboard)
  const cmdBtn = document.getElementById("cmdBtn");
  if (cmdBtn) cmdBtn.addEventListener("click", openCommandPalette);
  const cmdOverlay = document.getElementById("cmdOverlay");
  if (cmdOverlay) cmdOverlay.addEventListener("click", (e) => { if (e.target === cmdOverlay) closeCommandPalette(); });
  const cmdInput = document.getElementById("cmdInput");
  if (cmdInput) {
    cmdInput.addEventListener("input", (e) => {
      clearTimeout(_cmdTimer);
      _cmdTimer = setTimeout(() => runCommandSearch(e.target.value), 220);
    });
    cmdInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeCommandPalette(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); if (_cmdIndex < _cmdResults.length - 1) { _cmdIndex++; renderCommandResults(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (_cmdIndex > 0) { _cmdIndex--; renderCommandResults(); } }
      else if (e.key === "Enter") { e.preventDefault(); if (_cmdIndex >= 0) openSearchResult(_cmdIndex); else if (_cmdResults.length) openSearchResult(0); }
    });
  }
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (document.getElementById("screen-dashboard").classList.contains("hidden")) return;
      if (cmdOverlay.classList.contains("hidden")) openCommandPalette(); else closeCommandPalette();
    } else if (e.key === "Escape" && cmdOverlay && !cmdOverlay.classList.contains("hidden")) {
      closeCommandPalette();
    }
  });

  // Theme toggle wiring
  const themeBtn = document.getElementById("themeBtn");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

  // Reveal-on-scroll (Stripe-style entrance animations)
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    revealEls.forEach(el => io.observe(el));
  } else {
    revealEls.forEach(el => el.classList.add("in"));
  }

  // ---- Activity log panel wiring (opened from Profile / More-sheet now) ----
  const apClose = document.getElementById("activityClose");
  if (apClose) apClose.addEventListener("click", closeActivityPanel);
  const apOverlay = document.getElementById("activityOverlay");
  if (apOverlay) apOverlay.addEventListener("click", closeActivityPanel);
  const apClear = document.getElementById("activityClear");
  if (apClear) apClear.addEventListener("click", () => {
    _saveActivity([]); renderActivity(); toast("Activity log cleared", "info");
  });
  renderActivity(); // draw any persisted events immediately

  // ---- OTP "Paste from clipboard" button ----
  const otpPasteBtn = document.getElementById("otpPasteBtn");
  if (otpPasteBtn) otpPasteBtn.addEventListener("click", pasteOtp);

  // ---- Telegram Mini App: sign in BEFORE choosing a screen ----
  // Deliberately ahead of the sync boot below. Deciding the screen first and
  // logging in after would flash the landing page inside Telegram on every
  // single open, which is exactly the friction a Mini App removes.
  if (window.__inTelegram) {
    document.documentElement.classList.add("booting");

    // NEVER an auth screen inside Telegram. A Mini App user has already
    // proven who they are by opening it; asking them to sign in is the exact
    // friction the Mini App exists to remove.
    //
    // THE BUG THIS FIXES: the failure branch called showScreen("screen-landing"),
    // and the success branch called routeFromUrl() — which, on /dashboard
    // (a protected route) with no token yet, redirects to screen-signin. Both
    // paths could put a "Sign in / Create account" screen in front of someone
    // who is already inside Telegram. Neither can now.
    const done = () => {
      _bootOk = true;
      document.documentElement.classList.remove("booting");
      const sp = document.getElementById("bootSplash");
      if (sp) sp.style.display = "none";
    };
    const fail = (r) => {
      // An error, not "no account" — a new Telegram id creates an account
      // silently server-side. So this is a retry, never a login form.
      //
      // SHOW THE SERVER'S OWN WORDING when it sent one. A single
      // "Couldn't connect" for every cause pointed at the network even when
      // the real problem was a missing or mismatched TELEGRAM_PING_BOT_TOKEN,
      // which no amount of retrying fixes.
      showScreen("screen-dashboard");
      const detail = r && r.detail;
      _tgFatal(detail || "Couldn't connect. Tap Try again, or reopen the app.");
      done();
    };

    const go = () => {
      authToken = localStorage.getItem("ahad_token");
      showScreen("screen-dashboard");
      loadDashboard().catch(() => {});
      // routeFromUrl only AFTER the token exists, or it treats /dashboard as
      // an unauthenticated hit on a protected route and bounces to sign-in.
      if (authToken) { try { routeFromUrl(); } catch (e) {} }
    };

    /* A stored token is USED but not TRUSTED.
     *
     * This used to `return` here, so a Mini App with a stale token never
     * re-authenticated: it rendered the dashboard, the first real API call
     * came back 401, and the app bounced to a page whose sign-in screen is
     * hidden inside Telegram. The user saw "Hello, <name>" and then a dead
     * end — exactly the report.
     *
     * Now the dashboard still shows immediately (no waiting on the network),
     * and the token is verified in the background. If it is dead, the 401
     * handler in api() silently mints a new one from initData. */
    if (authToken) {
      go(); done();
      return;
    }

    if (typeof window.__tgAutoLogin !== "function") {
      fail({ detail: "Telegram sign-in did not load. Reopen the app." });
      return;
    }
    window.__tgAutoLogin()
      .then((r) => { if (r && r.ok) { go(); done(); } else { fail(r); } })
      .catch((e) => fail({ detail: "Sign-in failed: " + (e && e.message || e) }));
    return;
  }

  // ---- Boot: decide the screen SYNCHRONOUSLY (no flash) ----
  if (authToken) {
    showScreen("screen-dashboard");
    loadDashboard().catch(() => { /* infra-safe: banner + retry inside */ });
    routeFromUrl();          // direct hit on /jobs etc. → open that section
  } else if (localStorage.getItem("ahad_signup_username")) {
    // A verification was in progress (e.g. user switched to their mail app and
    // the page reloaded). Restore the OTP screen so they can finish verifying.
    restoreOtpScreen();
  } else {
    if (!routeFromUrl()) showScreen("screen-landing");  // deep link or plain visit
  }

  // Boot accomplished — a fatal error from here gets a toast, not the overlay.
  _bootOk = true;

  // Drop the boot splash now that a screen has been chosen.
  document.documentElement.classList.remove("booting");
  const splash = document.getElementById("bootSplash");
  if (splash) splash.style.display = "none";
});

/* The ONLY thing a Mini App user ever sees instead of the dashboard.
   Not a login form — an error with a retry, because a new Telegram id is
   supposed to create an account silently rather than fail. */
function _tgFatal(message) {
  let el = document.getElementById("tgFatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "tgFatal";
    el.className = "tg-fatal";
    const p = document.createElement("p");
    p.id = "tgFatalMsg";
    const b = document.createElement("button");
    b.className = "btn-primary";
    b.textContent = "Try again";
    b.onclick = () => location.reload();
    el.append(p, b);
    document.body.appendChild(el);
  }
  document.getElementById("tgFatalMsg").textContent = message;
  el.hidden = false;
}

/* Restore an in-progress verification screen from localStorage. */
function restoreOtpScreen() {
  const username = localStorage.getItem("ahad_signup_username") || "";
  const email = localStorage.getItem("ahad_signup_email") || "your email";
  signupUsername = username;
  clearOtpBoxes("otpBoxesSignup");
  document.getElementById("otpEmailNote").textContent = "Sent to " + email;
  showScreen("screen-otp");
  startResendTimer(10);
  logEvent("info", "Verification resumed", "Restored pending verification for " + username);

}

/* Paste a copied 6-digit code from the clipboard into the OTP boxes. */
async function pasteOtp() {
  let code = "";
  try {
    code = (await navigator.clipboard.readText() || "").replace(/[^0-9]/g, "").slice(0, 6);
  } catch (e) {
    toast("Clipboard access blocked — paste manually (Ctrl/Cmd+V).", "warning");
    return;
  }
  if (code.length !== 6) {
    toast("Clipboard doesn't contain a 6-digit code. Paste it manually.", "warning");
    return;
  }
  const boxes = document.querySelectorAll("#otpBoxesSignup input");
  code.split("").forEach((ch, i) => { if (boxes[i]) boxes[i].value = ch; });
  toast("Code pasted!", "success");
  if (boxes[5]) boxes[5].focus();
}

/* Show server-side login history (from /login-history) in the activity panel. */
async function showLoginHistory() {
  try {
    const data = await api("/login-history", "GET", null, true);
    openActivityPanel();
    const list = data.history || [];
    list.forEach(h => {
      logEvent(h.success ? "success" : "error",
        h.success ? "Sign-in recorded" : "Failed sign-in",
        (h.location || "Email verification") + " · " + (h.ip_address || "") + " · " + (h.device_info || ""));
    });
    if (!list.length) toast("No login history yet.", "info");
  } catch (err) { toast(err.message, "error"); }
}

/* ==================== ⚡ ALWAYS-ON JOBS (THE WORKBENCH) ====================
   Free 24/7 bot/code hosting. Signature UI: oak sidebar + warm amber accents
   + CodeMirror editor + draggable split terminal pane. Everything hand-built,
   no framework clone.
   ====================================================================== */

let _jobsTimer = null;
let _lastJobsSig = null;
let _lastJobsTs = 0;   // epoch of last successful load (for skeleton-stale heuristic)

// ─── RunSpace CodeMirror editor ────────────────────────────────────────
let _jobCm = null;
let _jobCmLoading = false;   // true while code is loaded programmatically

function _jobCmModeForLang(lang) {
  const l = (lang || "python").toLowerCase();
  if (l === "python" || l === "py" || l === "python3") return "python";
  if (l === "javascript" || l === "js" || l === "node" || l === "nodejs") return "javascript";
  if (l === "bash" || l === "sh" || l === "shell") return "shell";
  if (l === "ruby" || l === "rb") return "ruby";
  if (l === "php") return "application/x-httpd-php";
  return "python";
}

function initJobCodeMirror() {
  const ta = document.getElementById("jobCode");
  const host = document.getElementById("jobCmHost");
  if (!ta || !host || _jobCm) return;
  if (typeof CN6 === "undefined") { console.error("cm6 bundle missing"); return; }
  try {
    // CodeMirror 6. Replaces CM5, whose gutter was positioned by JavaScript on
    // every horizontal scroll (gutters.style.left = compensateForHScroll(...)),
    // making the line numbers visibly drift/wobble while dragging a long line
    // sideways. CM6 pins the gutter with CSS position:sticky instead.
    ta.style.display = "none";
    _jobCm = CN6.create(host, {
      value: ta.value || "",
      language: "python",
      lineWrapping: false,
      extraKeys: [
        { key: "Mod-s", preventDefault: true, run: () => { startJob(); return true; } },
        { key: "Mod-Enter", preventDefault: true, run: () => { startJob(); return true; } },
      ],
      onChange: () => {
        if (_jobCmLoading) return;          // programmatic load, not a user edit
        const wasDirty = _jobDirty;
        _jobDirty = true;
        if (_chgRaf) return;
        _chgRaf = requestAnimationFrame(() => {
          _chgRaf = 0;
          _updateStats();
          if (!wasDirty) _reflectJobStatus(_selectedJobId);
        });
      },
    });
  } catch (e) { console.error("initJobCodeMirror:", e); }
}

let _chgRaf = 0;

function _jobCmSetMode(lang) {
  if (!_jobCm) return;
  // CM6 swaps the language through a Compartment (see cm6.js), which is an
  // incremental reconfigure rather than CM5's full-document re-tokenise.
  _jobCm.setLanguage(lang || "python");
  const el = document.getElementById("cmMode");
  if (el) el.textContent = lang || "python";
}

function _jobCmSetValue(code) {
  const ta = document.getElementById("jobCode");
  if (!ta) return;
  const v = code || "";
  ta.value = v;
  // Loading a job's saved code is NOT a user edit. Without this flag the
  // change handler marks the buffer dirty, and its deferred callback could
  // re-dirty it after the caller had already reset the flag — leaving a
  // freshly-opened job permanently showing "Save & run".
  _jobCmLoading = true;
  try {
    if (_jobCm) _jobCm.setValue(v);
  } finally {
    _jobCmLoading = false;
  }
  _updateStats();
}

function _jobCmGetValue() {
  const ta = document.getElementById("jobCode");
  if (_jobCm) return _jobCm.getValue();
  return ta ? ta.value : "";
}

function _jobCmFocus() {
  if (_jobCm) { _jobCm.focus(); }
  else { const t = document.getElementById("jobCode"); if (t) t.focus(); }
}

function _jobCmRefresh() {
  if (_jobCm) { setTimeout(() => { try { _jobCm.refresh(); } catch(e){} }, 40); }
}

// ─── Jobs helpers ─────────────────────────────────────────────────────
function _slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}
function _deepSelectJobBySlug(slug) {
  if (!slug || !window._lastJobs || !window._lastJobs.length) return;
  const j = window._lastJobs.find(x => _slugify(x.name) === slug);
  if (j) selectJob(j.id);
}
function _jobBasePath(job) {
  const u = (window.__user && window.__user.username) ? window.__user.username : null;
  if (!u || !job || !job.name) return null;
  return "/runspace/" + encodeURIComponent(u) + "/" + _slugify(job.name);
}

/* Keep the address bar in sync with the job AND with which view is showing.
   Editor  -> /runspace/{username}/{tabname}
   Details -> /runspace/{username}/{tabname}/page          (§5) */
function _updateJobUrl(job, opts) {
  try {
    const base = _jobBasePath(job);
    if (!base) return;
    const wantDetails = opts && opts.details !== undefined ? opts.details : _jdOpen;
    const path = base + (wantDetails ? "/page" : "");
    if (_clientPath() === path || _routeNav) return;
    // Editor <-> Details is a real navigation inside the job, so PUSH it:
    // the browser Back button then returns to the editor as users expect.
    if (opts && opts.push) history.pushState({tab:"jobs", jobId:job.id, details:!!wantDetails}, "", path);
    else history.replaceState({tab:"jobs", jobId:job.id, details:!!wantDetails}, "", path);
  } catch (e) {}
}

// ─── Jobs data ────────────────────────────────────────────────────────
// State machine for the jobs sidebar. One of:
//   'idle'     — boot: tab never entered, nothing rendered yet
//   'loading'  — first fetch (or returning after stale) in flight; show skeleton
//   'loaded'   — data arrived; render list OR sidebar-empty
//   'empty'    — confirmed zero jobs server-side
//   'error'    — fetch failed; show error + retry
// We never infer state from array length — an empty array while 'loading'
// must NEVER flash the "no jobs" empty state.
let _jobsStatus = "idle";

function _setJobsStatus(status) {
  _jobsStatus = status;
  // Drive main-pane body visibility off this state so we never flash the
  // wrong panel while data is in flight.
  const ws = document.getElementById("wbWorkspace");
  const emp = document.getElementById("wbEmpty");
  const boot = document.getElementById("wbBootLoader");
  const list = document.getElementById("jobsList");
  const btnNewEmpty = document.getElementById("btnNewEmpty");
  if (!ws || !emp) return;
  // Restore CTA button copy (error state swaps in a "Retry" label)
  if (btnNewEmpty && btnNewEmpty._errLabel) {
    btnNewEmpty.innerHTML = btnNewEmpty._errLabel;
    btnNewEmpty._errLabel = null;
  }
  if (status === "loading") {
    ws.style.display = "none";
    emp.style.display = "none";
    if (boot) boot.style.display = "";
    if (btnNewEmpty) btnNewEmpty.style.display = "none";
    if (list) {
      // Only paint the skeleton if the list doesn't already have real job
      // items (stale-while-revalidate: keep old rows visible while we refresh).
      if (!list.querySelector(".job-item")) list.innerHTML = _skel(4);
    }
  } else if (status === "empty") {
    // Confirmed: zero jobs exist. Show the "No RunSpace yet" panel.
    ws.style.display = "none";
    if (boot) boot.style.display = "none";
    emp.style.display = "";
    if (btnNewEmpty) btnNewEmpty.style.display = "";
    // Tweak copy from generic "No job selected" to first-run messaging
    const t = emp.querySelector(".rs-empty-title");
    const s = emp.querySelector(".rs-empty-sub");
    if (t) t.textContent = "No RunSpace yet";
    if (s) s.textContent = "Create your first 24/7 bot or service — it goes live in seconds.";
    if (list) list.innerHTML = '<div class="rs-empty-sm" style="padding:16px 12px;text-align:center">No saved jobs yet.</div>';
  } else if (status === "error") {
    // NEVER hide the workspace here. A failed background refresh used to set
    // ws.style.display="none", which tore the open editor (and everything
    // typed into it) off the screen. Connectivity problems must not touch
    // editor state at all — only the sidebar may show the failure.
    if (ws && ws.style.display !== "none") {
      if (boot) boot.style.display = "none";
      return;
    }
    if (boot) boot.style.display = "none";
    emp.style.display = "";
    if (btnNewEmpty) btnNewEmpty.style.display = "";
    if (btnNewEmpty) {
      // Re-style CTA as retry when in error state (save original first)
      if (!btnNewEmpty._errLabel) btnNewEmpty._errLabel = btnNewEmpty.innerHTML;
      btnNewEmpty.innerHTML = '<svg viewBox="0 0 24" class="rs-ic-sm" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg> Retry';
    }
    const t = emp.querySelector(".rs-empty-title");
    const s = emp.querySelector(".rs-empty-sub");
    if (t) t.textContent = "Couldn’t load RunSpace";
    if (s) s.textContent = "The server may be waking up. Tap Retry in a moment.";
    // Swap the new-job button handler for a retry handler
    if (btnNewEmpty && btnNewEmpty && !btnNewEmpty._errWired) {
      btnNewEmpty._errWired = true;
      btnNewEmpty.addEventListener("click", (e) => {
        if (_jobsStatus !== "error") return;
        e.preventDefault(); e.stopPropagation();
        loadJobs();
      });
    }
  } else {
    // loaded — defer to _showWorkspace / _showEmpty / selectJob
    if (boot) boot.style.display = "none";
  }
}

async function loadJobs() {
  const list = document.getElementById("jobsList");
  if (!list) return;
  // Always enter 'loading' first. Stale-while-revalidate: if we already have
  // job rows on screen from a previous successful load, leave them in place
  // instead of swapping to skeleton (avoids flicker). Only show skeleton
  // when there is no prior content.
  const hasPrior = !!(window._lastJobs && window._lastJobs.length) || !!list.querySelector(".job-item");
  // SECOND leak of the same class as the one below, and the one that actually
  // fires FIRST. _setJobsStatus("loading") does `ws.style.display = "none"`.
  // On an account with zero saved jobs hasPrior is false, so every 7s poll
  // hid the workspace here — BEFORE the _composingNew guard further down ever
  // ran. An editor the user is typing into owns the main pane; a background
  // refresh may never take it away, so skip the visual state change entirely
  // and only track the internal flag.
  const _editorOwnsPane = _composingNew || _jobDirty;
  if (!hasPrior && !_editorOwnsPane) _setJobsStatus("loading"); else _jobsStatus = "loading";

  try {
    const data = await api("/api/jobs", "GET", null, true);
    const jobs = (data && data.jobs) || [];
    const sig = jobs.map(j => [j.id, j.status, j.restarts, j.web ? 1 : 0, j.web_public === false ? 0 : 1].join(":")).join("|");
    _lastJobsTs = Date.now();

    // The user is writing a brand-new job, or has unsaved edits in the open
    // one. _showEmpty()/_showWorkspace() below would hide or repaint the
    // editor and destroy that text — which is exactly what looked like a
    // spontaneous page reload. Refresh ONLY the sidebar list and stop.
    if (_composingNew || _jobDirty) {
      // ROOT CAUSE of "New RunSpace reloads after 3-4 seconds", found again
      // here because the PREVIOUS fix guarded the wrong layer. The guard
      // above correctly avoids _showEmpty()/_showWorkspace() — but then
      // called _setJobsStatus("empty"), and THAT function does
      // `ws.style.display = "none"` on the workspace (see the "empty" branch).
      // So on an account with zero saved jobs, every 7s poll hid the blank
      // New editor and swapped in the "No RunSpace yet" panel. It looked
      // exactly like a spontaneous page reload, and it also explains the
      // stray word on screen: that panel's subtitle is the sentence
      // "...it goes live in seconds."
      //
      // A composing/dirty editor owns the main pane. Only the SIDEBAR may be
      // refreshed here, and only through _renderJobList(), which touches the
      // list and nothing else.
      if (sig !== _lastJobsSig) { _lastJobsSig = sig; _renderJobList(jobs); }
      return;
    }

    if (jobs.length === 0) {
      // Confirmed zero — render once, preserve sig
      _lastJobsSig = sig;
      _setJobsStatus("empty");
      _showEmpty(true);
      return;
    }
    _setJobsStatus("loaded");
    if (sig !== _lastJobsSig) { _lastJobsSig = sig; renderJobs(jobs); }
    else {
      // Sig matched (nothing changed) — still make sure the right main
      // pane is visible: if we had a selected job, show workspace; else
      // show the "No job selected" empty panel (different copy from zero-jobs).
      if (_selectedJobId) {
        const cur = jobs.find(x => String(x.id) === String(_selectedJobId));
        if (cur) { _showWorkspace(cur); _updateJobUrl(cur); }
        else { _selectedJobId = null; _showEmpty(false); }
      } else {
        _showEmpty(false);
      }
    }
  } catch (e) {
    if (e && e.kind === "infra") {
      // Server waking up — keep skeleton + banner (thrown by api() already)
      // but DO NOT switch to error/empty state; retry via polling.
      if (!hasPrior && list) list.innerHTML = _skel(3);
      return;
    }
    // A background refresh failing must not disturb open work. Polling
    // already retries on its own; showing an error box here would replace the
    // sidebar and (previously) hide the editor with it.
    if (_composingNew || _jobDirty || _selectedJobId) return;
    const sig = "ERR:" + e.message;
    if (sig === _lastJobsSig) return;
    _lastJobsSig = sig;
    _setJobsStatus("error");
    _loadErrorBox(list, "deployments", loadJobs, e);
  }
}

function _fmtUptime(s) {
  s = s || 0;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + sec + "s";
  return sec + "s";
}

let _selectedJobId = null;
let _logSSE = null;
let _logFollow = true;
let _jobDirty = false;          // code changed since last deploy (enables Run button)
let _suppressAutoSelect = 0;   // ms epoch until which renderJobs() must NOT auto-select a job (New-flow race guard)
// TRUE from the moment "New" is clicked until the job is actually deployed.
// The old guard was a 1500ms timer, but the jobs list polls every 7s — so the
// first poll after that window auto-selected an existing job and wiped the
// blank editor while the user was still typing (it looked like a page reload).
let _composingNew = false;

function _fmtStatus(st) {
  st = (st || "offline").toLowerCase();
  const map = {
    "running":        {cls:"ok",   label:"RUNNING",       badge:"running",    dot:"running"},
    "starting":       {cls:"warn", label:"STARTING",      badge:"starting",   dot:"installing"},
    "installing":     {cls:"warn", label:"INSTALLING",    badge:"installing", dot:"installing"},
    "stopped":        {cls:"",     label:"STOPPED",       badge:"stopped",    dot:"stopped"},
    "offline":        {cls:"warn", label:"OFFLINE",       badge:"offline",    dot:"offline"},
    "crashed":        {cls:"err",  label:"CRASHED",       badge:"crashed",    dot:"crashed"},
    "install_failed": {cls:"err",  label:"INSTALL FAILED",badge:"error",     dot:"crashed"},
    // Runner unreachable — we genuinely do not know yet. Shown as a neutral
    // "checking" state instead of falsely claiming the job is stopped.
    "unknown":        {cls:"warn", label:"CHECKING…",     badge:"checking",   dot:"checking"},
  };
  return map[st] || {cls:"", label:st.toUpperCase(), badge:st, dot:"offline"};
}

// ─── RunSpace-local escape helper (alias to the global escapeHtml) ────
function _escapeHtml(s) { return escapeHtml(s == null ? "" : String(s)); }

// ─── Log line colorization ────────────────────────────────────────────
function _colorizeLine(line) {
  if (!line) return "";
  let s = _escapeHtml(line);
  if (/^\[system\]/.test(line)) return '<span class="log-line log-sys">' + s + '</span>';
  const re = /^(\[[^\]]+\])?\s*(\[[A-Za-z _]+\])?\s*((?:https?:\/\/|\/)[^\s]+)?\s*(\b\d{3}\b)?\s*(-|:)?\s*(.*)$/;
  const m = line.match(re);
  if (m) {
    let [, ts, lvl, url, code, , msg] = m;
    let out = '<span class="log-line">';
    if (ts)  out += '<span class="log-ts">' + _escapeHtml(ts) + '</span> ';
    if (lvl) {
      const raw = lvl.replace(/^\[/,"").replace(/\]$/,"").trim().toLowerCase();
      const cls = (raw === "info" ? "info" : raw === "warn" || raw === "warning" ? "warn" :
                   raw === "err" || raw === "error" ? "err" :
                   raw === "ok" || raw === "success" ? "ok" : "info");
      out += '<span class="log-lvl ' + cls + '">' + _escapeHtml(lvl) + '</span> ';
    }
    if (url) out += '<span class="log-url">' + _escapeHtml(url) + '</span> ';
    if (code) {
      const c = parseInt(code, 10);
      const cc = c >= 500 ? "c5xx" : c >= 400 ? "c4xx" : c >= 300 ? "c300" : c >= 200 ? "c2xx" : "";
      out += '<span class="log-code ' + cc + '">' + _escapeHtml(code) + '</span> ';
    }
    if (msg) out += '<span class="log-msg">' + _escapeHtml(msg) + '</span>';
    return out + '</span>';
  }
  s = s.replace(/\b(200 OK|201 Created|204 No Content)\b/g, '<span class="log-code c2xx">$1</span>');
  s = s.replace(/\b(4\d{2}(?:\s+[A-Za-z]+)?)\b/g, '<span class="log-code c4xx">$1</span>');
  s = s.replace(/\b(5\d{2}(?:\s+[A-Za-z]+)?)\b/g, '<span class="log-code c5xx">$1</span>');
  s = s.replace(/(\[INFO\])/gi, '<span class="log-lvl info">$1</span>');
  s = s.replace(/(\[WARN(?:ING)?\])/gi, '<span class="log-lvl warn">$1</span>');
  s = s.replace(/(\[ERR(?:OR)?\])/gi, '<span class="log-lvl err">$1</span>');
  s = s.replace(/(\[OK\])/gi, '<span class="log-lvl ok">$1</span>');
  s = s.replace(/((?:https?:\/\/|\/)[^\s]+)/g, '<span class="log-url">$1</span>');
  return '<span class="log-line">' + s + '</span>';
}

/* Logs are rendered into EXACTLY ONE pane: the editor pane, or the Details
   pane when Details is open. The old code built the editor HTML and then
   copied innerHTML into the Details pane on every SSE tick (~113 KB parsed
   twice, ~9 MB/min) which is what froze the tab, scrolling and tab switching.
   We also skip all work when the pane is not visible, and skip re-rendering
   when the log text has not actually changed. */
let _lastLogText = null;
let _lastLogTarget = null;

function _activeLogPane() {
  return _jdOpen
    ? document.getElementById("jdLogBody")
    : document.getElementById("jobLogBody");
}

function _renderLogs(text, force) {
  const body = _activeLogPane();
  const dot = document.getElementById("jobLogTitle");
  if (!body) return;

  // Same text into the same pane => nothing to do. This alone removes almost
  // all of the per-tick DOM churn, because logs usually grow by a line or two.
  if (!force && text === _lastLogText && body === _lastLogTarget) return;
  _lastLogText = text;
  _lastLogTarget = body;

  if (!text || !text.trim()) {
    body.innerHTML = '<span class="rs-log-empty">// Logs will appear here when you run the job.</span>';
    if (dot) { dot.className = "rs-log-dot"; dot.title = "idle"; }
    _reflectJobStatus(_selectedJobId);
    return;
  }

  // Only keep a bounded tail in the DOM — an unbounded log would grow the
  // document forever and degrade scrolling the longer a job runs.
  const tail = text.split(/\r?\n/).slice(-400);
  const follow = _jdOpen ? _jdLogFollow : _logFollow;
  // Measure BEFORE mutating; reading scroll metrics afterwards forces an
  // extra synchronous layout.
  const atBottom = follow !== false ||
    (body.scrollTop + body.clientHeight >= body.scrollHeight - 24);
  body.textContent = "";
  body.insertAdjacentHTML("afterbegin", tail.map(_colorizeLine).join("\n"));
  if (atBottom) body.scrollTop = body.scrollHeight;
  if (dot) { dot.className = "rs-log-dot running"; dot.title = "streaming"; }
  // The Logs tab is a full-height view of this same buffer. Mirror it only
  // when that tab is actually mounted — writing to a hidden panel on every
  // SSE tick is exactly the kind of wasted work that froze this page before.
  if (_jdOpen && _jdTab === "logs") _jdMirrorLogs();
}

// ─── Workspace chrome ─────────────────────────────────────────────────
/** Retrigger a CSS animation class (§4 tab-switch transition).
 *  Removing + reflowing + re-adding is required: re-adding a class that is
 *  already present does not restart a CSS animation. */
function _playSwap(el) {
  if (!el) return;
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.classList.remove("rs-swap");
    void el.offsetWidth;                 // force reflow so the animation restarts
    el.classList.add("rs-swap");
    setTimeout(() => el.classList.remove("rs-swap"), 260);
  } catch (e) {}
}

function _showWorkspace(job, animate) {
  const emp = document.getElementById("wbEmpty");
  const ws = document.getElementById("wbWorkspace");
  const boot = document.getElementById("wbBootLoader");
  if (emp) emp.style.display = "none";
  if (ws)  ws.style.display = "flex";
  if (boot) boot.style.display = "none";
  if (animate) _playSwap(ws);
  _reflectJobStatus(job);
  _jobCmRefresh();
}

function _clearWorkspaceChrome() {
  const body = document.getElementById("jobLogBody");
  if (body) body.innerHTML = '<span class="rs-log-empty">// Logs will appear here when you run the job.</span>';
  const dot = document.getElementById("jobLogTitle");
  if (dot) { dot.className = "rs-log-dot"; dot.title = "idle"; }
  const rs = document.getElementById("wbRunnerStat");
  if (rs) { rs.className = "rs-status-dot"; rs.title = "idle"; rs.style.background=""; rs.style.boxShadow=""; }
  const btnRun  = document.getElementById("btnStartJob");
  const btnStop = document.getElementById("btnStopJob");
  const btnRest = document.getElementById("btnRestartJob");
  if (btnRun)  btnRun.style.display = "";
  if (btnStop) btnStop.style.display = "none";
  if (btnRest) btnRest.style.display = "none";
}
function _showEmpty(zeroJobs) {
  const emp = document.getElementById("wbEmpty");
  const ws  = document.getElementById("wbWorkspace");
  const boot = document.getElementById("wbBootLoader");
  const btnNewEmpty = document.getElementById("btnNewEmpty");
  // While jobs are still loading, DO NOT reveal the empty panel — the caller
  // (loadJobs) will flip the state itself once data is confirmed.
  if (_jobsStatus === "loading") {
    if (ws) ws.style.display = "none";
    if (emp) emp.style.display = "none";
    if (boot) boot.style.display = "";
    if (btnNewEmpty) btnNewEmpty.style.display = "none";
    return;
  }
  if (emp) emp.style.display = "";
  if (ws)  ws.style.display = "none";
  if (boot) boot.style.display = "none";
  if (btnNewEmpty) btnNewEmpty.style.display = "";
  const t = emp && emp.querySelector(".rs-empty-title");
  const s = emp && emp.querySelector(".rs-empty-sub");
  if (t) t.textContent = zeroJobs ? "No RunSpace yet" : "No job selected";
  if (s) s.textContent = zeroJobs
    ? "Create your first 24/7 bot or service — it goes live in seconds."
    : "Create a new job or pick one from the left to start editing.";
  const n = document.getElementById("jobName"); if (n) n.value = "";
  const langEl = document.getElementById("jobLang");
  if (langEl) langEl.value = "python";
  _jobCmSetValue("");
  _jobCmSetMode("python");
  _clearWorkspaceChrome();
  _setHint("", "Ready");
  _updateStats();
  // Reset URL to plain /runspace when nothing is selected
  try {
    if (currentTab === "jobs" && !_routeNav) {
      history.replaceState({tab:"jobs"}, "", "/runspace");
    }
  } catch (e) {}
}

function _setHint(kind, msg) {
  const dot = document.getElementById("wbRunnerStat");
  if (!dot) return;
  dot.className = "rs-status-dot";
  dot.style.background = ""; dot.style.boxShadow = "";
  if (kind === "ok")  dot.classList.add("ok");
  if (kind === "err") dot.classList.add("bad");
  if (kind === "warn") { dot.style.background = "#d29922"; dot.style.boxShadow = "0 0 0 2px rgba(210,153,34,.18)"; }
  dot.title = msg || (kind === "ok" ? "ok" : kind === "warn" ? "working" : kind === "err" ? "error" : "idle");
}

let _statsLast = "";
function _updateStats() {
  const el = document.getElementById("codeStats");
  if (!el) return;
  // lineCount() is O(1) on CodeMirror's line tree; getValue()+split() rebuilt
  // and re-scanned the entire document on every keystroke.
  let lines, chars;
  if (_jobCm) {
    lines = _jobCm.lineCount();
    chars = _jobCm.getValue().length;
  } else {
    const v = _jobCmGetValue() || "";
    lines = v ? v.split("\n").length : 0;
    chars = v.length;
  }
  const txt = lines + " lines · " + chars + " chars";
  if (txt === _statsLast) return;      // skip identical DOM writes
  _statsLast = txt;
  el.textContent = txt;
}

// Reflect current job status onto toolbar action buttons + sidebar dots + log dot.
// Accepts a job object OR a job id (looked up from window._lastJobs).
function _reflectJobStatus(jobOrId) {
  let job = jobOrId;
  if (jobOrId && typeof jobOrId !== "object") {
    const id = String(jobOrId);
    job = (window._lastJobs || []).find(x => String(x.id) === id) || null;
  }
  const stKey = (job && job.status) ? (job.status || "").toLowerCase() : "stopped";
  const st = _fmtStatus(job && job.status);
  // §3: brief cross-fade whenever the status text changes, never a hard flip.
  if (_reflectJobStatus._last !== st.label) {
    _reflectJobStatus._last = st.label;
    document.querySelectorAll("#tab-jobs .rs-badge, #tab-jobs .jd-badge").forEach(b => {
      b.classList.remove("status-changed");
      void b.offsetWidth;                  // reflow so the animation restarts
      b.classList.add("status-changed");
    });
  }
  const isLive = (stKey === "running" || stKey === "starting" || stKey === "installing");

  const btnRun  = document.getElementById("btnStartJob");
  const btnStop = document.getElementById("btnStopJob");
  const btnRest = document.getElementById("btnRestartJob");
  const btnDet  = document.getElementById("btnJobDetails");
  const isSelected = !!job && !!btnRun && btnRun.dataset.editingId;
  // When a saved job is live and code isn't dirty: Details button PRIMARY (Run
  // hidden) because re-running would redeploy. Otherwise: Run primary + Details
  // available for all saved jobs (stopped too — user may want to download/
  // inspect env/timeline even after stop).
  const detailsPrimary = isSelected && isLive && !_jobDirty;
  // The rebuilt header hides controls with the `hidden` attribute (so they
  // leave the segmented group cleanly) — but older call sites still set
  // style.display. Drive BOTH, or a button set one way is un-hidden the other.
  const _show = (el, on) => {
    if (!el) return;
    el.hidden = !on;
    el.style.display = on ? "" : "none";
  };
  if (btnRun) {
    _show(btnRun, !detailsPrimary);
    // Visual "dirty" marker when code has been edited since last Run
    btnRun.classList.toggle("dirty", !!_jobDirty && !!isSelected);
    const lbl = btnRun.querySelector(".rs-seg-label") || btnRun.querySelector(".rs-btn-label");
    if (lbl && !btnRun.classList.contains("loading")) {
      lbl.textContent = _jobDirty ? "Save & run" : "Run";
    }
  }
  _show(btnDet,  !!isSelected);
  _show(btnStop, isLive);
  _show(btnRest, isLive);

  // Inspector: only meaningful with a job open. Hiding the toggle also
  // closes the panel, so the third column can never be left stranded
  // over an empty workspace.
  const btnInsp = document.getElementById("btnInspector");
  _show(btnInsp, !!isSelected);
  if (!isSelected) {
    document.body.classList.remove("rs-insp-open");
    if (btnInsp) btnInsp.setAttribute("aria-expanded", "false");
  } else if (document.body.classList.contains("rs-insp-open")) {
    renderInspector();
  }
  // The action group itself disappears when nothing is open, instead of
  // leaving an empty bordered shell in the header.
  const seg = document.getElementById("rsJobActions");
  if (seg) seg.hidden = !(isSelected || !detailsPrimary);
  const closeBtn = document.getElementById("btnDeselect");
  _show(closeBtn, !!isSelected || !!_composingNew);

  // Breadcrumb: "RunSpace / <job>" plus a readable state chip. The old header
  // showed the literal string "RunSpace" forever — #rsTitle was never once
  // written to by any code path, so the header never told you what was open.
  const crumbSep = document.getElementById("rsCrumbSep");
  const crumbCur = document.getElementById("rsTitle");
  const headChip = document.getElementById("rsHeadState");
  const openName = (job && job.name) || (_composingNew ? "new job" : "");
  if (crumbCur && crumbSep) {
    crumbCur.textContent = openName;
    crumbCur.hidden = !openName;
    crumbSep.hidden  = !openName;
  }
  if (headChip) {
    const showChip = !!job && !!openName && !_composingNew;
    headChip.hidden = !showChip;
    if (showChip) {
      headChip.textContent = st.label || stKey;
      headChip.className = "rs-chip is-" + String(stKey || "").replace(/[^a-z]/g, "");
    }
  }

  const rs = document.getElementById("wbRunnerStat");
  if (rs) {
    rs.className = "rs-status-dot";
    rs.style.background = ""; rs.style.boxShadow = "";
    if (stKey === "running")      { rs.classList.add("ok");  rs.title = "RUNNING"; }
    else if (stKey === "crashed" || stKey === "install_failed") { rs.classList.add("bad"); rs.title = st.label; }
    else if (stKey === "starting" || stKey === "installing")    { rs.style.background = "#d29922"; rs.style.boxShadow = "0 0 0 2px rgba(210,153,34,.18)"; rs.title = st.label; }
    else                          { rs.title = st.label; }
  }

  const dot = document.getElementById("jobLogTitle");
  if (dot) {
    dot.className = "rs-log-dot";
    if (stKey === "running")                               dot.classList.add("running");
    else if (stKey === "crashed" || stKey === "install_failed") dot.classList.add("crashed");
    else if (stKey === "starting" || stKey === "installing")   dot.classList.add("running"); // amber-ish via animation; keep pulse
    dot.title = st.label;
  }
}

/* ============================================================
   INSPECTOR  ·  desktop third column / mobile bottom sheet
   Renders ONLY fields the runner actually returns from _job_public():
   status, uptime_s, restarts, port, cpu_pct, mem_mb, env_keys,
   web_slug, language. A field that is absent renders an em dash — it
   never falls back to a plausible-looking number, because a made-up
   metric is worse than a visibly missing one.
   ============================================================ */
function _fmtUptime(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

function _inspSet(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = (value === undefined || value === null || value === "")
    ? "—" : String(value);
}

/* Memory has no fixed ceiling we can trust, so the bar is scaled against a
   512 MB reference (Render's free tier) purely for a sense of magnitude —
   the exact MB is always printed next to it. */
const _INSP_MEM_REF_MB = 512;

function _inspMeter(barId, valId, value, unit, pct) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  const has = typeof value === "number" && isFinite(value);
  if (val) val.textContent = has ? `${value}${unit}` : "—";
  if (!bar) return;
  const w = has ? Math.max(0, Math.min(100, pct)) : 0;
  bar.style.width = w + "%";
  bar.classList.toggle("warn", has && w >= 70 && w < 90);
  bar.classList.toggle("hot",  has && w >= 90);
}

function renderInspector() {
  const panel = document.getElementById("wbInspector");
  if (!panel) return;
  const job = (window._lastJobs || []).find(j => String(j.id) === String(_selectedJobId));
  if (!job) return;

  const st = _fmtStatus(job.status);
  const stKey = String(job.status || "offline").toLowerCase();

  const chip = document.getElementById("inspState");
  if (chip) {
    // Sentence case: the map is SHOUTING for the old badges, which reads as
    // an alert in a calm panel.
    const label = st.label || stKey;
    chip.textContent = label.charAt(0) + label.slice(1).toLowerCase();
    chip.className = "rs-chip is-" + stKey.replace(/[^a-z]/g, "");
  }
  _inspSet("inspUptime",   _fmtUptime(job.uptime_s));
  _inspSet("inspRestarts", (job.restarts === undefined || job.restarts === null) ? "—" : job.restarts);
  _inspSet("inspPort",     job.port || "—");
  _inspSet("inspLang",     job.language || "—");

  _inspMeter("inspCpuBar", "inspCpuVal", job.cpu_pct, "%", job.cpu_pct);
  _inspMeter("inspMemBar", "inspMemVal", job.mem_mb, " MB",
             (Number(job.mem_mb) / _INSP_MEM_REF_MB) * 100);

  const link = document.getElementById("inspUrl");
  if (link) {
    const url = job.web_url || (job.web_slug ? `/live/${job.web_slug}/` : "");
    if (url && job.web) {
      link.textContent = job.web_slug || url;
      link.href = url;
      link.removeAttribute("aria-disabled");
    } else {
      link.textContent = "—";
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
    }
  }

  const keys = Array.isArray(job.env_keys) ? job.env_keys : [];
  const cnt = document.getElementById("inspEnvCount");
  if (cnt) cnt.textContent = String(keys.length);
  const list = document.getElementById("inspEnvList");
  if (list) {
    if (!keys.length) {
      list.innerHTML = '<p class="rs-insp-none">No variables set.</p>';
    } else {
      // textContent per node — a key is user data and must never be parsed
      // as HTML.
      list.textContent = "";
      keys.forEach(k => {
        const s = document.createElement("span");
        s.className = "rs-env-key";
        s.textContent = k;
        list.appendChild(s);
      });
    }
  }
}

function _setRunnerStat(text, cls) {
  const s = document.getElementById("wbRunnerStat");
  if (!s) return;
  s.className = "rs-status-dot" + (cls ? " " + cls : "");
  s.style.background = ""; s.style.boxShadow = "";
  if (text) s.title = text;
}

function selectJob(id) {
  if (id === null || id === undefined || id === "") { deselectJob(); return; }
  id = String(id);
  // Already selected → no re-fetch, no SSE reconnect (instant tab switch)
  if (_selectedJobId === id) {
    _closeJobsRail();
    const tab = document.getElementById("tab-jobs");
    if (tab) tab.classList.remove("side-open");
    return;
  }
  // Switching away from unsaved work silently threw it away. Ask first.
  if (_jobDirty || (_composingNew && (_jobCmGetValue() || "").trim())) {
    if (!confirm("You have unsaved changes. Discard them and open this job?")) return;
  }
  _selectedJobId = id;
  _jobDirty = false;
  _composingNew = false;      // an existing job was chosen; New-flow is over
  // 👉 Paint sidebar selection + swap to workspace IMMEDIATELY (don't wait for
  // fetch/SSE to round-trip — that's what makes tab switches feel laggy).
  // Data fills in behind the paint with a subtle fade.
  document.querySelectorAll("#jobsList .job-item").forEach(el => {
    el.classList.toggle("active", el.dataset.jid === _selectedJobId);
  });
  const btn = document.getElementById("btnStartJob");
  if (btn) btn.dataset.editingId = _selectedJobId;
  // §2: show the bar the instant the switch is initiated (not after the
  // request resolves), so the wait never looks like a frozen UI.
  _progressStart();
  // Kick off data + log stream but DON'T await them. Instant visual response.
  fetchJobDetail(id).finally(() => _progressDone());
  restartLogStream(id);
  requestAnimationFrame(() => { try { _jobCmRefresh(); } catch(e){} });
  // Update URL once job detail loads (we need the name)
  setTimeout(() => { const j = (window._lastJobs||[]).find(x => String(x.id) === _selectedJobId); if (j) _updateJobUrl(j); }, 120);
  _closeJobsRail();
  const tab = document.getElementById("tab-jobs");
  if (tab) tab.classList.remove("side-open");
}

function deselectJob() {
  _selectedJobId = null;
  stopLogStream();
  document.querySelectorAll("#jobsList .job-item.active").forEach(el => el.classList.remove("active"));
  const btn = document.getElementById("btnStartJob");
  if (btn) delete btn.dataset.editingId;
  const n = document.getElementById("jobName"); if (n) n.value = "";
  const u = document.getElementById("jobRepoUrl"); if (u) u.value = "";
  _jobCmSetValue("");
  _updateStats();
  _setHint("", "Ready");
  document.body.classList.remove("rs-logs-open");
  _showEmpty(false);
}

/* When the runner was unreachable the status is "unknown". Retry a few times
   with backoff so the tab resolves itself — the user must never have to click
   something to discover a job is actually running. */
const _statusRecheck = {};
function _scheduleStatusRecheck(id, attempt) {
  id = String(id);
  attempt = attempt || 1;
  if (attempt > 4) { delete _statusRecheck[id]; return; }
  if (_statusRecheck[id]) clearTimeout(_statusRecheck[id]);
  _statusRecheck[id] = setTimeout(() => {
    delete _statusRecheck[id];
    // Only keep chasing while this job is still the one on screen.
    if (String(_selectedJobId) !== id) return;
    fetchJobDetail(id, { silent: true, attempt: attempt + 1 });
  }, attempt * 1500);
}

async function fetchJobDetail(id, opts) {
  opts = opts || {};
  try {
    const token = localStorage.getItem("ahad_token") || "";
    const r = await fetch("/api/jobs/" + id, {
      headers: token ? {"Authorization": "Bearer " + token} : {}
    });
    if (!r.ok) {
      // The caller owns the progress bar bracket; do not release it here.
      // A failed refresh must not blank an open editor.
      if (!_selectedJobId) _showEmpty(false);
      return;
    }
    const job = await r.json();
    window._lastJobs = window._lastJobs || [];
    const idx = window._lastJobs.findIndex(x => String(x.id) === String(id));
    // The runner was unreachable, so the server could not determine the state.
    // Keep the last KNOWN status rather than downgrading a running job, and
    // schedule a re-check — this is the stale-status bug's real fix.
    if (job.status_stale && idx >= 0) {
      const prev = window._lastJobs[idx];
      if (prev && prev.status && prev.status !== "unknown") {
        job.status = prev.status;
        job.uptime_s = prev.uptime_s;
        job.restarts = prev.restarts;
      }
      _scheduleStatusRecheck(id);
    } else if (job.status_stale) {
      _scheduleStatusRecheck(id);
    }
    if (idx >= 0) window._lastJobs[idx] = job; else window._lastJobs.push(job);
    // Avoid wiping + re-setting identical code (CM setValue is the slow part on
    // tab switch, especially for large files, and fires 'change' handlers).
    const nEl = document.getElementById("jobName");
    if (nEl && nEl.value !== (job.name || "")) nEl.value = job.name || "";
    const langEl = document.getElementById("jobLang");
    const newLang = job.language || "python";
    if (langEl && langEl.value !== newLang) {
      langEl.value = newLang; _jobCmSetMode(newLang);
    }
    const curCode = _jobCmGetValue();
    // A background status re-check must never touch the editor buffer.
    if (!opts.silent && !_jobDirty && curCode !== (job.code || "")) {
      _jobCmSetValue(job.code || "");
      _jobDirty = false;
    }
    _updateStats();
    _showWorkspace(job, true);   // animate: this is a job→job switch (§4)
    _reflectJobStatus(job);
    _setHint("ok", "");
    // If the detail drawer is open, re-render it with the new job's data so
    // clicking a different job in the sidebar swaps the drawer content too.
    if (_jdOpen) { renderJobDetails(); }
    // Same tick as the Details page: the inspector reads the very job
    // object that was just refreshed, so its numbers can never lag the
    // header's status chip.
    if (document.body.classList.contains("rs-insp-open")) renderInspector();
  } catch (e) {
    if (!_selectedJobId) _showEmpty(false);
  }
}

function stopLogStream() {
  if (_logSSE) {
    try { _logSSE.close(); } catch (e) {}
    // Drop any frame queued by the stream so it can't paint stale logs into
    // a pane that now belongs to a different job.
    try { if (_logSSE._raf) cancelAnimationFrame(_logSSE._raf); } catch (e) {}
    _logSSE = null;
  }
  _lastLogText = null;
  _lastLogTarget = null;
}

function restartLogStream(id) {
  stopLogStream();
  _renderLogs("");
  const token = localStorage.getItem("ahad_token") || "";
  fetch("/api/jobs/" + id + "/logs", {
    headers: token ? {"Authorization": "Bearer " + token} : {}
  }).then(r => r.json()).then(d => _renderLogs(d.logs || "")).catch(()=>{});
  try {
    const es = new EventSource("/api/jobs/" + id + "/logs/stream?token=" + encodeURIComponent(token));
    _logSSE = es;
    let _pending = null, _raf = 0;
    es._raf = 0;
    es.onmessage = (ev) => {
      // Coalesce bursts: paint at most once per animation frame. Rendering
      // synchronously inside every SSE message is what let a chatty job
      // saturate the main thread and freeze scrolling / tab switching.
      try { _pending = JSON.parse(ev.data); } catch (e) { return; }
      if (_raf) return;
      _raf = es._raf = requestAnimationFrame(() => {
        _raf = es._raf = 0;
        const d = _pending; _pending = null;
        if (!d) return;
        _applyStreamUpdate(id, d);
      });
    };
    function _applyStreamUpdate(id, d) {
      try {
        _renderLogs(d.logs || "");
        window._lastJobs = window._lastJobs || [];
        const job = window._lastJobs.find(x => String(x.id) === String(id));
        if (job) { job.status = d.status; job.uptime_s = d.uptime_s; job.restarts = d.restarts; _reflectJobStatus(job); }
        if (_jdOpen && String(_selectedJobId) === String(id)) renderJobDetails();
        if (document.body.classList.contains("rs-insp-open")
            && String(_selectedJobId) === String(id)) renderInspector();
        const it = document.querySelector('#jobsList .job-item[data-jid="' + String(id).replace(/"/g,'\\"') + '"]');
        if (it) {
          it.classList.remove("running","crashed");
          const sk = (d.status||"").toLowerCase();
          if (sk === "running" || sk === "starting" || sk === "installing") it.classList.add("running");
          if (sk === "crashed" || sk === "install_failed") it.classList.add("crashed");
          const dot = it.querySelector(".jstatus-dot");
          if (dot) {
            dot.classList.remove("running","crashed");
            if (sk === "running" || sk === "starting" || sk === "installing") dot.classList.add("running");
            if (sk === "crashed" || sk === "install_failed") dot.classList.add("crashed");
          }
        }
      } catch(e){}
    }
    // The server closes each stream after a bounded lifetime (so a forgotten
    // tab can't pin a connection forever) and sends this event first. Re-open
    // deliberately instead of relying on EventSource's error backoff.
    es.addEventListener("reconnect", () => {
      if (_logSSE !== es) return;               // superseded by another job
      if (String(_selectedJobId) !== String(id)) { stopLogStream(); return; }
      setTimeout(() => {
        if (_logSSE === es && String(_selectedJobId) === String(id)) restartLogStream(id);
      }, 400);
    });
    es.onerror = () => { /* SSE auto-retries */ };
  } catch(e) {}
}

function _langIcon(lang) {
  const l = (lang || "py").toLowerCase();
  if (l === "python" || l === "py" || l === "python3") return "py";
  if (l === "javascript" || l === "js" || l === "node" || l === "nodejs") return "js";
  if (l === "bash" || l === "sh" || l === "shell") return "sh";
  if (l === "ruby" || l === "rb") return "rb";
  if (l === "php") return "php";
  return (lang || "py").slice(0,2).toLowerCase();
}

/** Refresh ONLY the sidebar list + count. Never touches the editor panes.
 *  Used while the user is composing a new job or has unsaved edits, so the
 *  job list stays live without their typing being wiped. */
function _renderJobList(jobs) {
  window._lastJobs = jobs || [];
  const countEl = document.getElementById("txJobCount");
  if (countEl) countEl.textContent = (jobs || []).length;
  const list = document.getElementById("jobsList");
  if (!list) return;
  (jobs || []).forEach(j => {
    const row = list.querySelector('.job-item[data-jid="' + String(j.id).replace(/"/g, '\\"') + '"]');
    if (!row) return;
    const sk = (j.status || "").toLowerCase();
    row.classList.toggle("running", sk === "running" || sk === "starting" || sk === "installing");
    row.classList.toggle("crashed", sk === "crashed" || sk === "install_failed");
    const dot = row.querySelector(".jstatus-dot");
    if (dot) {
      dot.classList.toggle("running", sk === "running" || sk === "starting" || sk === "installing");
      dot.classList.toggle("crashed", sk === "crashed" || sk === "install_failed");
    }
  });
}

function renderJobs(jobs) {
  const list = document.getElementById("jobsList");
  const countEl = document.getElementById("txJobCount");
  window._lastJobs = jobs || [];
  if (countEl) countEl.textContent = jobs.length;
  if (!list) return;
  // Staggered fade-in for the list itself; skeleton is already visible.
  list.innerHTML = "";
  list.classList.remove("rs-fade-in");
  // eslint-disable-next-line no-unused-expressions
  void list.offsetWidth; // reflow to restart animation
  list.classList.add("rs-fade-in");
  if (!jobs.length) {
    // Confirmed zero jobs server-side
    _setJobsStatus("empty");
    if (!_selectedJobId) _showEmpty(true);
    return;
  }
  // Data loaded — make sure boot loader is gone
  _setJobsStatus("loaded");
  jobs.forEach((j, i) => {
    const st = _fmtStatus(j.status);
    const stKey = (j.status || "").toLowerCase();
    const item = document.createElement("div");
    item.className = "job-item rs-slide-in";
    item.style.animationDelay = (Math.min(i, 10) * 18) + "ms";
    if (_selectedJobId == j.id) item.classList.add("active");
    if (stKey === "running" || stKey === "starting" || stKey === "installing") item.classList.add("running");
    if (stKey === "crashed" || stKey === "install_failed") item.classList.add("crashed");
    item.dataset.jid = String(j.id);
    const li = _langIcon(j.language);
    item.innerHTML =
      '<span class="jlang-icon" title="' + _escapeHtml(j.language || "") + '">' + _escapeHtml(li) + '</span>' +
      '<span class="jname">' + _escapeHtml(j.name || "untitled") + '</span>' +
      '<span class="jstatus-dot' +
        (stKey === "running" || stKey === "starting" || stKey === "installing" ? " running" : "") +
        (stKey === "crashed" || stKey === "install_failed" ? " crashed" : "") +
      '" title="' + _escapeHtml(st.label) + '"></span>' +
      '<button type="button" class="jdel" title="Delete job" aria-label="Delete job">' +
        '<svg viewBox="0 0 24" class="rs-ic-sm" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>' +
      '</button>';
    item.addEventListener("click", (e) => {
      if (e.target.closest(".jdel")) return;
      selectJob(j.id);
    });
    const del = item.querySelector(".jdel");
    if (del) {
      del.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!confirm("Delete this job?")) return;
        deleteJobById(j.id, del);
      });
    }
    list.appendChild(item);
  });
  // Deep-link: if URL says /runspace/u/slug, pick that job regardless of running state
  let deepPick = null;
  if (window.__rs_deep_slug) deepPick = jobs.find(x => _slugify(x.name) === window.__rs_deep_slug);
  if (deepPick) {
    selectJob(deepPick.id);
    window.__rs_deep_slug = null;
    _suppressAutoSelect = 0;
    // Landing directly on .../page must open Details, not the editor.
    if (window.__rs_deep_details) {
      window.__rs_deep_details = false;
      openJobDetails(null, {noUrl: true});
    } else if (_jdOpen) {
      closeJobDetails({noUrl: true});
    }
  }
  else if (_composingNew || Date.now() < _suppressAutoSelect) {
    // A new job is being written — never auto-select, never repaint the
    // editor. Losing what the user typed is far worse than a stale list.
    document.querySelectorAll("#jobsList .job-item.active").forEach(el => el.classList.remove("active"));
    return;
  }
  else if (!_selectedJobId || !jobs.find(x => String(x.id) === String(_selectedJobId))) {
    const running = jobs.find(x => (x.status||"").toLowerCase() === "running");
    const pick = running || jobs[0];
    if (pick) selectJob(pick.id);
    else _showEmpty(false);
  } else {
    const cur = jobs.find(x => String(x.id) === String(_selectedJobId));
    // _jobDirty => unsaved edits in the editor. Re-showing the workspace here
    // would reset the pane from server data and discard them.
    if (cur && !_jobDirty) { _showWorkspace(cur); _updateJobUrl(cur); }
  }
}

/* Close the jobs rail. Must clear BOTH classes: rs-side-open drives the
   mobile drawer, rs-side-collapsed drives the desktop rail, and the toggle
   now sets them together. Leaving one behind is what let the panel reappear
   or refuse to hide after crossing the breakpoint. */
function _closeJobsRail() {
  document.body.classList.remove("rs-side-open");
  document.body.classList.add("rs-side-collapsed");
}
/* Open it again (used when the user asks for the list explicitly). */
function _openJobsRail() {
  document.body.classList.add("rs-side-open");
  document.body.classList.remove("rs-side-collapsed");
}

function _initWbWiring() {
  // Guard: never wire twice
  const sentinel = document.getElementById("btnNew");
  if (sentinel && sentinel.dataset.wired === "1") return;

  const newBtn   = document.getElementById("btnNew");
  const newBtn2  = document.getElementById("btnNew2");
  const newBtnE  = document.getElementById("btnNewEmpty");
  const menuBtn  = document.getElementById("wbMenuBtn");
  const backdrop = document.getElementById("wbBackdrop");
  const deselectBtn = document.getElementById("btnDeselect");
  const btnStart = document.getElementById("btnStartJob");
  const btnStop  = document.getElementById("btnStopJob");
  const btnRest  = document.getElementById("btnRestartJob");

  const onNew = (ev) => {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    // Hard reset: stop streams, null out selection, clear dirty flag
    stopLogStream();
    _selectedJobId = null;
    _jobDirty = false;
    // Stays true until this job is deployed or the user picks another job, so
    // background polling can never replace the blank editor mid-typing.
    _composingNew = true;
    document.querySelectorAll("#jobsList .job-item.active").forEach(el => el.classList.remove("active"));
    const btn = document.getElementById("btnStartJob");
    if (btn) delete btn.dataset.editingId;
    // Suppress auto-select for the next 1500ms so any in-flight poll/loadJobs
    // race cannot steal our blank editor and reload an old job.
    _suppressAutoSelect = Date.now() + 1500;
    const ws = document.getElementById("wbWorkspace");
    const emp = document.getElementById("wbEmpty");
    if (ws) ws.style.display = "flex";
    if (emp) emp.style.display = "none";
    _clearWorkspaceChrome();
    _renderLogs("");
    const n = document.getElementById("jobName"); if (n) { n.value = ""; n.classList.remove("rs-inp-err"); }
    const u = document.getElementById("jobRepoUrl"); if (u) u.value = "";
    const langEl = document.getElementById("jobLang");
    if (langEl) { langEl.value = "python"; _jobCmSetMode("python"); }
    _jobCmSetValue("");
    _jobCmSetMode("python");
    _setHint("", "Ready");
    _updateStats();
    document.body.classList.remove("rs-side-open","rs-logs-open");
    const tab = document.getElementById("tab-jobs");
    if (tab) tab.classList.remove("side-open");
    // Reset URL to /runspace
    try { if (!_routeNav) history.replaceState({tab:"jobs"}, "", "/runspace"); } catch(e){}
    setTimeout(() => {
      try { if (n) { n.focus(); } } catch(e){}
      _jobCmRefresh();
      _jobCmFocus();
    }, 60);
  };
  if (newBtn)  { newBtn.addEventListener("click", onNew); newBtn.dataset.wired = "1"; newBtn.type = "button"; }

  /* ── the "···" overflow menu ────────────────────────────────────────────
     Every toolbar action now lives behind one button, so the header row
     cannot overflow at any width. Same contract as the Job Details kebab
     (#jdMoreBtn): toggle `hidden`, close on outside click, close on Escape,
     close after an item is chosen.

     Three details that matter:
       · the item handlers are bound elsewhere and are untouched — this only
         shows and hides the container, so no action can break by moving.
       · closing happens on a 0ms timeout so the item's own click handler
         runs first; closing synchronously would unmount the button
         mid-dispatch.
       · rows that CONTAIN a field (runtime select, GitHub URL) must not
         close the menu when clicked, or the select can never be used. */
  /* Code Studio's "···" — identical contract to RunSpace's, wired here so
     both live in one place and cannot drift apart. */
  const csMoreBtn  = document.getElementById("csMoreBtn");
  const csMoreMenu = document.getElementById("csMoreMenu");
  if (csMoreBtn && csMoreMenu) {
    const closeCs = () => {
      csMoreMenu.hidden = true;
      csMoreBtn.setAttribute("aria-expanded", "false");
    };
    csMoreBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const open = csMoreMenu.hidden;
      csMoreMenu.hidden = !open;
      csMoreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    csMoreMenu.addEventListener("click", (e) => {
      if (!e.target.closest(".cs-menu-item")) return;
      setTimeout(closeCs, 0);      // let the item's own handler run first
    });
    document.addEventListener("click", (e) => {
      if (csMoreMenu.hidden) return;
      if (csMoreMenu.contains(e.target) || csMoreBtn.contains(e.target)) return;
      closeCs();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !csMoreMenu.hidden) { e.stopPropagation(); closeCs(); }
    });
  }

  const moreBtn  = document.getElementById("rsMoreBtn");
  const moreMenu = document.getElementById("rsMoreMenu");
  if (moreBtn && moreMenu) {
    const closeMore = () => {
      moreMenu.hidden = true;
      moreBtn.setAttribute("aria-expanded", "false");
      document.body.classList.remove("rs-menu-open");
    };
    const openMore = () => {
      moreMenu.hidden = false;
      moreBtn.setAttribute("aria-expanded", "true");
      document.body.classList.add("rs-menu-open");
    };
    moreBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (moreMenu.hidden) openMore(); else closeMore();
    });
    moreMenu.addEventListener("click", (e) => {
      // A click inside a field row is for the field, not for dismissing.
      if (e.target.closest(".rs-menu-field")) return;
      if (!e.target.closest(".rs-menu-item")) return;
      setTimeout(closeMore, 0);
    });
    document.addEventListener("click", (e) => {
      if (moreMenu.hidden) return;
      if (moreMenu.contains(e.target) || moreBtn.contains(e.target)) return;
      closeMore();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !moreMenu.hidden) { e.stopPropagation(); closeMore(); }
    });
    // Changing the runtime is a decision; the menu has done its job.
    const langSel = document.getElementById("jobLang");
    if (langSel) langSel.addEventListener("change", () => setTimeout(closeMore, 120));

    // Tapping the scrim behind the mobile sheet dismisses it.
    const scrim = document.getElementById("rsMenuScrim");
    if (scrim) scrim.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); closeMore();
    });

    /* "New job" and "Job list" inside the menu.
       #btnNew is the real control but it lives inside the job rail, which
       is an off-canvas overlay at every width — on a fresh load it is not
       on screen, so it could not be reached at all. These forward to the
       existing handlers instead of duplicating them, so there is still one
       implementation of each action. */
    const newInMenu = document.getElementById("btnNewInMenu");
    if (newInMenu) newInMenu.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      closeMore();
      const real = document.getElementById("btnNew");
      if (real) real.click();
      // The rail is where the new draft is listed; leave it closed so the
      // editor stays full-bleed, which is what the user asked for.
    });

    const jobsInMenu = document.getElementById("btnJobsInMenu");
    if (jobsInMenu) jobsInMenu.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      closeMore();
      document.body.classList.add("rs-side-open");
      document.body.classList.remove("rs-side-collapsed");
      const mb = document.getElementById("wbMenuBtn");
      if (mb) mb.setAttribute("aria-expanded", "true");
    });
  }
  if (newBtn2) { newBtn2.addEventListener("click", onNew); newBtn2.type = "button"; newBtn2._w = 1; }
  if (newBtnE) { newBtnE.addEventListener("click", onNew); newBtnE.type = "button"; newBtnE._w = 1; }
  // Enter key in name / repo fields → Run (mobile keyboard "Go" support)
  const nameField = document.getElementById("jobName");
  const repoField = document.getElementById("jobRepoUrl");
  const _enterRun = (e) => {
    if (e.key === "Enter" || e.keyCode === 13) {
      e.preventDefault(); e.stopPropagation();
      startJob();
    }
  };
  if (nameField) nameField.addEventListener("keydown", _enterRun);
  if (repoField) repoField.addEventListener("keydown", _enterRun);
  // Escape closes the Details page (the old dropdown it also handled no
  // longer exists — downloads are plain buttons now).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      if (document.body.classList.contains("rs-detail-open")) closeJobDetails();
    }
  });
  if (deselectBtn) {
    deselectBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); deselectJob(); });
    deselectBtn.type = "button";
  }
  if (menuBtn) {
    // The toggle used to only ever flip "rs-side-open", which does nothing on
    // desktop because the rail is statically 250px there — a dead control in
    // the primary toolbar. Now it means the right thing per breakpoint:
    // desktop collapses the rail, mobile slides the drawer over.
    const _isPhone = () => window.matchMedia("(max-width: 760px)").matches;
    const _syncMenuBtn = () => {
      // Same truth the toggle uses: is the rail actually on screen?
      const el = document.getElementById("wbSide");
      const open = !!el && el.getBoundingClientRect().width > 4;
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    // ROOT CAUSE of "the job list bar will not hide": this used to pick the
    // class from _isPhone(). On a phone with a dynamic browser toolbar the
    // viewport crosses the 760px breakpoint as the bar hides/shows, so a tap
    // could evaluate to the DESKTOP branch and set rs-side-collapsed — which
    // had no mobile rule, so nothing happened and the panel looked stuck.
    //
    // Derive the state from what is ACTUALLY on screen instead of from a
    // media query, and drive both classes together so the result is the same
    // whichever side of the breakpoint we are on.
    const _sideVisible = () => {
      const el = document.getElementById("wbSide");
      if (!el) return false;
      // A drawer parked off-screen has no width in the layout sense.
      return el.getBoundingClientRect().width > 4;
    };
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      const show = !_sideVisible();
      document.body.classList.toggle("rs-side-open", show);
      document.body.classList.toggle("rs-side-collapsed", !show);
      _syncMenuBtn();
    });
    if (backdrop) {
      backdrop.addEventListener("click", () => {
        _closeJobsRail();
        _syncMenuBtn();
      });
    }
    // Crossing the breakpoint must not strand the drawer state.
    window.addEventListener("resize", () => {
      if (!_isPhone()) document.body.classList.remove("rs-side-open");
      _syncMenuBtn();
    });

    // Explicit close button inside the drawer. The toggle and the backdrop
    // both already worked, but neither was discoverable: the toggle is a
    // small icon in the header, and the backdrop starts BELOW the header so
    // it does not read as tappable. Reported three times as the jobs panel
    // being permanently open over the editor.
    const sideClose = document.getElementById("btnSideClose");
    if (sideClose) {
      sideClose.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        _closeJobsRail();
        _syncMenuBtn();
      });
    }

    // Escape closes the drawer — but only if nothing more modal is on top.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!document.body.classList.contains("rs-side-open")) return;
      if (document.body.classList.contains("rs-detail-open")) return;
      _closeJobsRail();
      _syncMenuBtn();
    });

    // Swipe left to dismiss. On a phone the drawer sits over the editor, so
    // the gesture people already expect from a nav drawer should work.
    const sideEl = document.getElementById("wbSide");
    if (sideEl) {
      let x0 = null, y0 = null;
      sideEl.addEventListener("touchstart", (ev) => {
        if (!_isPhone() || ev.touches.length !== 1) { x0 = null; return; }
        x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY;
      }, { passive: true });
      sideEl.addEventListener("touchend", (ev) => {
        if (x0 === null) return;
        const t = ev.changedTouches[0];
        const dx = t.clientX - x0, dy = t.clientY - y0;
        x0 = null;
        // Horizontal intent only, or scrolling the job list would close it.
        if (dx < -48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          _closeJobsRail();
          _syncMenuBtn();
        }
      }, { passive: true });
    }
    _syncMenuBtn();
  }
  // Inspector toggle — one control, two presentations (column / sheet).
  const inspBtn = document.getElementById("btnInspector");
  const inspClose = document.getElementById("wbInspClose");
  const _syncInsp = () => {
    const open = document.body.classList.contains("rs-insp-open");
    if (inspBtn) inspBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderInspector();
  };
  if (inspBtn) {
    inspBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      document.body.classList.toggle("rs-insp-open");
      _syncInsp();
    });
  }
  if (inspClose) {
    inspClose.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      document.body.classList.remove("rs-insp-open");
      _syncInsp();
    });
  }
  // Escape closes the sheet before anything else claims the key.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.body.classList.contains("rs-insp-open")) return;
    if (document.body.classList.contains("rs-detail-open")) return;
    document.body.classList.remove("rs-insp-open");
    _syncInsp();
  });

  // Breadcrumb root returns to the job list (and, on a phone, opens it).
  const crumbRoot = document.getElementById("rsCrumbRoot");
  if (crumbRoot) {
    crumbRoot.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (window.matchMedia("(max-width: 760px)").matches) {
        _openJobsRail();
      } else {
        document.body.classList.remove("rs-side-collapsed");
      }
    });
  }

  try { initJobCodeMirror(); } catch (e) { console.error("[workbench] cm init:", e); }

  const sel = document.getElementById("jobLang");
  if (sel) sel.addEventListener("change", () => {
    _jobCmSetMode(sel.value);
    _updateStats();
  });

  // GitHub import helper — bound once; e.stopPropagation prevents bubbling
  async function _handleImportGh() {
    const u = ((document.getElementById("jobRepoUrl") || {}).value || "").trim();
    if (!u) { toast("Paste a GitHub repo URL first", "warn"); return; }
    btnGh.classList.add("loading");
    btnGh.disabled = true;
    _setHint("warn", "");
    try {
      let autoName = "";
      const mm = u.match(/github\.com\/[^/]+\/([^/]+)/);
      if (mm) autoName = mm[1].replace(/\.git$/,"");
      const nameInp = document.getElementById("jobName");
      if (nameInp && !nameInp.value.trim() && autoName) nameInp.value = autoName;
      if (nameInp && !nameInp.value.trim()) nameInp.value = "Untitled Job";
      const editingId = btnStart && btnStart.dataset.editingId;
      const name = nameInp ? nameInp.value.trim() : (autoName || "Untitled Job");
      const body = { repo_url: u, name, language: document.getElementById("jobLang").value, code: _jobCmGetValue() || "" };
      const info = editingId
        ? await api("/api/jobs/" + editingId, "PATCH", body, true)
        : await api("/api/jobs", "POST", body, true);
      toast("Repo deployed", "success");
      await loadJobs();
      if (info && info.job_db_id) selectJob(info.job_db_id);
      _setHint("ok","");
    } catch (err) {
      toast(err.message, "error");
      _setHint("err", err.message);
    } finally {
      btnGh.disabled = false;
      btnGh.classList.remove("loading");
    }
  }
  const btnGh = document.getElementById("btnImportGh");
  if (btnGh && !btnGh._w) {
    btnGh._w = 1;
    btnGh.type = "button";
    btnGh.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); _handleImportGh(); });
  }
  const repoInp = document.getElementById("jobRepoUrl");
  if (repoInp) {
    repoInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); btnGh && btnGh.click(); }
    });
  }

  // Stop / Restart buttons → real API calls using currently selected job.
  if (btnStop) {
    btnStop.type = "button";
    btnStop.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = _selectedJobId || (btnStart && btnStart.dataset.editingId);
      if (!id) return;
      stopJobById(id);
    });
  }
  if (btnRest) {
    btnRest.type = "button";
    btnRest.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = _selectedJobId || (btnStart && btnStart.dataset.editingId);
      if (!id) return;
      restartJobById(id);
    });
  }

  // Copy-success check icon (uses same stroke-width / viewBox as other icons)
  const _checkIc = '<svg viewBox="0 0 24 24" class="rs-ic-sm" fill="none" stroke="#3fb950" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  // Log controls
  const copy = document.getElementById("jobLogCopy");
  if (copy) { copy.onclick = null; copy.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const body = document.getElementById("jobLogBody");
    const t = body ? body.textContent : "";
    if (!navigator.clipboard || !t) return;
    navigator.clipboard.writeText(t).then(() => {
      copy.classList.add("is-ok");
      const orig = copy.innerHTML;
      copy.innerHTML = _checkIc;
      setTimeout(() => { copy.classList.remove("is-ok"); copy.innerHTML = orig; }, 1000);
    });
  }); }
  const reload = document.getElementById("jobLogRefresh");
  if (reload) { reload.onclick = null; reload.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const svg = reload.querySelector(".rs-ic-sm");
    if (svg) { reload.classList.add("is-spinning"); svg.style.animation = "rsSpin .7s linear"; setTimeout(()=>{ svg.style.animation=""; reload.classList.remove("is-spinning"); },720); }
    if (_selectedJobId) { fetchJobDetail(_selectedJobId); restartLogStream(_selectedJobId); }
  }); }
  const bottom = document.getElementById("jobLogBottom");
  if (bottom) { bottom.onclick = null; bottom.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const body = document.getElementById("jobLogBody");
    if (body) { _logFollow = true; body.scrollTop = body.scrollHeight; }
  }); }
  const clear = document.getElementById("jobLogClear");
  if (clear) { clear.onclick = null; clear.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const body = document.getElementById("jobLogBody");
    if (body) body.innerHTML = '<span class="rs-log-empty">// Logs cleared.</span>';
  }); }
  const dl = document.getElementById("jobLogDl");
  if (dl) { dl.onclick = null; dl.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const body = document.getElementById("jobLogBody");
    const name = (document.getElementById("jobName")||{}).value || "job";
    const text = body ? body.textContent : "";
    if (!text) { toast("Logs are empty","error"); return; }
    const blob = new Blob([text],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download = name.replace(/[^\w.\-]+/g,"_")+'-'+new Date().toISOString().slice(0,10)+'.log';
    document.body.appendChild(a); a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},100);
    toast("Logs downloaded","success");
  }); }
  const logBody = document.getElementById("jobLogBody");
  if (logBody) logBody.addEventListener("scroll", () => {
    _logFollow = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 40;
  });

  _initSplitDrag();
  _updateStats();
}

function _initSplitDrag() {
  const divider = document.getElementById("wbDivider");
  const split = document.getElementById("wbSplit");
  const codePane = split && split.querySelector(".rs-pane.rs-editor");
  const logPane  = split && split.querySelector(".rs-pane.rs-logs");
  if (!divider || !split || !codePane || !logPane) return;
  let dragging = false, startY = 0, startCodeH = 0, startLogH = 0;
  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startCodeH = codePane.getBoundingClientRect().height;
    startLogH  = logPane.getBoundingClientRect().height;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const splitH = split.getBoundingClientRect().height - divider.getBoundingClientRect().height;
    let newCode = startCodeH + dy;
    const min = 120;
    if (newCode < min) newCode = min;
    if (newCode > splitH - min) newCode = splitH - min;
    const newLog = splitH - newCode;
    codePane.style.flex = `0 0 ${newCode}px`;
    logPane.style.flex  = `0 0 ${newLog}px`;
    if (_jobCm) _jobCm.refresh();
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; }
  });
  // Touch support
  divider.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    dragging = true; startY = t.clientY;
    startCodeH = codePane.getBoundingClientRect().height;
    startLogH  = logPane.getBoundingClientRect().height;
  }, {passive:true});
  window.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const dy = t.clientY - startY;
    const splitH = split.getBoundingClientRect().height - divider.getBoundingClientRect().height;
    let newCode = startCodeH + dy;
    const min = 100;
    if (newCode < min) newCode = min;
    if (newCode > splitH - min) newCode = splitH - min;
    codePane.style.flex = `0 0 ${newCode}px`;
    logPane.style.flex  = `0 0 ${splitH - newCode}px`;
    if (_jobCm) _jobCm.refresh();
  }, {passive:true});
  window.addEventListener("touchend", () => { dragging = false; });
}

// ─── Job Details drawer ──────────────────────────────────────────────
let _jdOpen = false;
let _jdHealthTimer = null;
let _jdHealthBusy = false;
let _jdTimeline = [];
let _jdLogFollow = true;
function openJobDetails(id, opts) {
  if (id) selectJob(id);
  const panel = document.getElementById("jobDetailPanel");
  if (!panel) return;                       // markup missing -> stay in editor
  _jdOpen = true;
  _jdLogFollow = true;
  panel.setAttribute("aria-hidden", "false");
  document.body.classList.add("rs-detail-open", "rs-drawer-open");

  // Always land on Code. Reopening on whatever tab was last used means the
  // page shows something different each time for no reason the user chose.
  _initJdTabs();
  jdSwitchTab("code");
  renderJobDetails();
  _jdEnvLoad();
  _jdRefreshBackupRow();
  // The visible log pane just changed: repaint the cached text into it.
  _renderLogs(_lastLogText || "", true);
  const sc = document.getElementById("jdScroll");
  if (sc) sc.scrollTop = 0;
  const fw = document.getElementById("jdFollow");
  if (fw) fw.checked = true;

  if (!(opts && opts.noUrl)) {
    const job = _jdCurrentJob();
    if (job) _updateJobUrl(job, {details: true, push: true});
  }
  _startHealthCheck();
}
function closeJobDetails(opts) {
  document.body.classList.remove("rs-detail-open");
  document.body.classList.remove("rs-drawer-open");
  _jdOpen = false;
  const panel = document.getElementById("jobDetailPanel");
  if (panel) panel.setAttribute("aria-hidden", "true");
  if (_jdHealthTimer) { clearInterval(_jdHealthTimer); _jdHealthTimer = null; }
  // Repaint the cached log text back into the editor pane.
  _renderLogs(_lastLogText || "", true);
  _playSwap(document.getElementById("wbWorkspace"));
  // Drop the /page suffix again so the URL matches the editor view.
  if (!(opts && opts.noUrl)) {
    const job = (window._lastJobs || []).find(x => String(x.id) === String(_selectedJobId));
    if (job) _updateJobUrl(job, {details: false, push: true});
  }
}
function _jdSet(name, value) {
  const el = document.getElementById(name);
  if (el && value !== undefined) el.textContent = value;
}
/* ============================================================
   JOB DETAILS PAGE  —  rebuilt
   Rules that keep it fast (these are why it used to freeze):
     * render only when the page is actually visible
     * write each field only when its value CHANGED
     * logs live in exactly one pane and are bounded
     * no innerHTML mirroring of the editor's log pane
   ============================================================ */

/** Set textContent only if it differs — avoids needless layout invalidation. */
function _jdText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = value === undefined || value === null ? "" : String(value);
  if (el.textContent !== v) el.textContent = v;
}

function _jdCurrentJob() {
  return (window._lastJobs || []).find(x => String(x.id) === String(_selectedJobId)) || null;
}

function renderJobDetails() {
  if (!_jdOpen || document.hidden) return;      // nothing to do when unseen
  const job = _jdCurrentJob();
  if (!job) { closeJobDetails(); return; }

  const stKey = (job.status || "").toLowerCase();
  const st = _fmtStatus(job.status);
  const live = (stKey === "running" || stKey === "starting" || stKey === "installing");

  // ---- header -------------------------------------------------------
  _jdText("jdName", job.name || "untitled");
  _jdText("jdLang", _langIcon(job.language));
  const badge = document.getElementById("jdBadge");
  if (badge) {
    // Now a PILL (dot + word), not a bare coloured dot: a dot alone forces
    // the reader to decode a colour, and colour-blind users cannot.
    const cls = "jd-pill " + (stKey === "running" ? "running"
      : (stKey === "crashed" || stKey === "install_failed") ? "crashed"
      : (stKey === "starting" || stKey === "installing") ? "starting" : "");
    if (badge.className !== cls) badge.className = cls;
    // The status map SHOUTS for the old badges; sentence case reads calmer.
    const lbl = st.label || stKey;
    _jdText("jdBadge", lbl.charAt(0) + lbl.slice(1).toLowerCase());
  }
  // Primary button reflects what pressing it will do.
  const startBtn = document.getElementById("jdStart");
  if (startBtn) {
    const sp = startBtn.querySelector("span");
    if (sp) sp.textContent = live ? "Redeploy" : "Deploy";
  }

  // ---- 1 status ------------------------------------------------------
  _jdText("jdState", st.label);
  _jdText("jdUptime", live ? _fmtUptime(job.uptime_s || 0) : "—");
  _jdText("jdRestarts", String(job.restarts || 0));
  // Filename, not a bare language word — the Code tab is showing a file.
  const _ext = {python:"py", javascript:"js", bash:"sh", ruby:"rb", php:"php"};
  _jdText("jdLangName", "main." + (_ext[job.language] || "txt"));
  // Read-only preview. textContent, never innerHTML: this is user code.
  const _cp = document.getElementById("jdCodePreview");
  if (_cp) {
    const src = job.code || "";
    _cp.textContent = src || "// Nothing saved yet — open in editor to write code.";
  }
  _jdText("jdPid", job.runner_job_id || "—");
  _jdText("jdPort", job.port || "—");
  _jdText("jdCpu", job.cpu_pct != null ? job.cpu_pct + "%" : "—");
  _jdText("jdMem", job.mem_mb != null ? job.mem_mb + " MB" : "—");

  // ---- 2 controls: reflect what is actually possible right now -------
  const start = document.getElementById("jdStart");
  const stop = document.getElementById("jdStop");
  const restart = document.getElementById("jdRestart");
  if (start) start.disabled = live;
  if (stop) stop.disabled = !live;
  if (restart) restart.disabled = false;

  // ---- 3 public URL --------------------------------------------------
  const card = document.getElementById("jdUrlCard");
  const url = job.web_url || job.url || "";
  if (card) {
    const show = !!(live && url);
    if (card.hidden === show) card.hidden = !show;
    if (show) {
      const a = document.getElementById("jdUrl");
      if (a && a.textContent !== url) { a.href = url; a.textContent = url; }
      const o = document.getElementById("jdUrlOpen");
      if (o) o.href = url;
    }
  }

  // ---- 7 run history: append only on a real state change -------------
  if (!job._tl) job._tl = [];
  const last = job._tl[job._tl.length - 1];
  if (!last || last.ev !== st.label) {
    job._tl.push({
      t: new Date(), ev: st.label,
      cls: stKey === "running" ? "ok"
        : (stKey === "crashed" || stKey === "install_failed") ? "err"
        : (stKey === "starting" || stKey === "installing") ? "warn" : ""
    });
    if (job._tl.length > 30) job._tl.shift();
    const tl = document.getElementById("jdTimeline");
    if (tl) {
      tl.innerHTML = job._tl.slice().reverse().map(e =>
        '<li><span class="jd-ts">' +
        e.t.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"}) +
        '</span><span class="jd-ev ' + e.cls + '">' + _escapeHtml(e.ev) + "</span></li>"
      ).join("");
    }
  }
}

/* ---- health check -------------------------------------------------- */
function _jdSetHealth(cls, text, sub) {
  const h = document.getElementById("jdHealth");
  if (h) {
    h.className = "jd-health " + (cls || "");
    const tx = h.querySelector(".jd-h-tx");
    if (tx) tx.textContent = text;
  }
  if (sub !== undefined) _jdText("jdHealthSub", sub);
}

async function _jdCheckHealth() {
  if (!_jdOpen || document.hidden) return;
  if (_jdHealthBusy) return;                 // never stack probes
  const job = _jdCurrentJob();
  const url = job && (job.web_url || job.url);
  if (!url) return;
  _jdHealthBusy = true;
  _jdSetHealth("", "checking…");
  // A sleeping free-tier target can hang; without a timeout these pile up.
  const ctl = ("AbortController" in window) ? new AbortController() : null;
  const killer = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} }, 8000);
  const t0 = performance.now();
  try {
    await fetch(url, {method: "GET", mode: "no-cors", cache: "no-store",
                      signal: ctl ? ctl.signal : undefined});
    _jdSetHealth("ok", "live (" + Math.round(performance.now() - t0) + "ms)",
                 "Checked " + new Date().toLocaleTimeString());
  } catch (e) {
    _jdSetHealth("bad", "unreachable", "Checked " + new Date().toLocaleTimeString());
  } finally {
    clearTimeout(killer);
    _jdHealthBusy = false;
  }
}

function _startHealthCheck() {
  if (_jdHealthTimer) clearInterval(_jdHealthTimer);
  _jdCheckHealth();
  _jdHealthTimer = setInterval(_jdCheckHealth, 20000);
}

/* ---- environment variables ----------------------------------------- */
function _jdEnvRow(k, v) {
  const row = document.createElement("div");
  row.className = "jd-env-row";
  const ki = document.createElement("input");
  ki.placeholder = "KEY"; ki.value = k || ""; ki.dataset.k = "1";
  const vi = document.createElement("input");
  vi.placeholder = "value"; vi.value = v || ""; vi.dataset.v = "1";
  const del = document.createElement("button");
  del.type = "button"; del.className = "jd-env-del"; del.textContent = "✕";
  del.title = "Remove";
  del.addEventListener("click", () => { row.remove(); _jdEnvSave(); });
  ki.addEventListener("change", _jdEnvSave);
  vi.addEventListener("change", _jdEnvSave);
  row.append(ki, vi, del);
  return row;
}

/* Env vars are stored SERVER-SIDE on the job row and injected into the
   process at spawn. They used to be written to localStorage only, so the job
   never actually received them and they vanished on another device. */
function _jdEnvCollect() {
  const list = document.getElementById("jdEnvList");
  const out = {};
  if (!list) return out;
  list.querySelectorAll(".jd-env-row").forEach(r => {
    const k = r.querySelector("[data-k]").value.trim();
    const v = r.querySelector("[data-v]").value;
    if (k) out[k] = v;
  });
  return out;
}

let _jdEnvTimer = null;
function _jdEnvSave() {
  if (!_selectedJobId) return;
  // Debounce: typing a token fires a change per field.
  if (_jdEnvTimer) clearTimeout(_jdEnvTimer);
  _jdText("jdEnvHint", "Saving…");
  _jdEnvTimer = setTimeout(async () => {
    const id = _selectedJobId;
    try {
      await api("/api/jobs/" + id, "PATCH", { env: _jdEnvCollect() }, true);
      const job = (window._lastJobs || []).find(x => String(x.id) === String(id));
      if (job) job.env = _jdEnvCollect();
      _jdText("jdEnvHint", "Saved · applies on the next restart.");
    } catch (e) {
      _jdText("jdEnvHint", "Could not save: " + (e.message || "error"));
    }
  }, 600);
}

function _jdEnvLoad() {
  const list = document.getElementById("jdEnvList");
  if (!list) return;
  list.innerHTML = "";
  const job = _jdCurrentJob();
  const data = (job && job.env) || {};
  const keys = Object.keys(data);
  if (!keys.length) list.appendChild(_jdEnvRow("", ""));
  else keys.forEach(k => list.appendChild(_jdEnvRow(k, data[k])));
  _jdText("jdEnvHint", "Changes apply on the next restart.");
}

/* ---- downloads ------------------------------------------------------ */
async function _jdDownload(kind) {
  const job = _jdCurrentJob();
  if (!job) return;
  const token = localStorage.getItem("ahad_token") || "";
  const safe = (job.name || "job").replace(/[^\w.-]+/g, "_");

  if (kind === "logs") {
    const body = document.getElementById("jdLogBody");
    const txt = body ? body.textContent : "";
    if (!txt.trim()) { toast("No logs to download", "error"); return; }
    _downloadBlob(new Blob([txt], {type: "text/plain;charset=utf-8"}), safe + ".log");
    toast("Logs downloaded", "success");
    return;
  }

  if (kind === "source") {
    try {
      const d = await api("/api/jobs/" + job.id, "GET", null, true);
      const code = (d && d.code) || "";
      if (!code) { toast("No source stored for this job", "error"); return; }
      const ext = {python: "py", javascript: "js", bash: "sh", ruby: "rb", php: "php"}[job.language] || "txt";
      _downloadBlob(new Blob([code], {type: "text/plain;charset=utf-8"}), safe + "." + ext);
      toast("Source downloaded", "success");
    } catch (e) { toast(e.message || "Download failed", "error"); }
    return;
  }

  // database / data files.
  //
  // /api/jobs/{id}/files reads the runner's filesystem with plain os.path,
  // which only works when the runner is EMBEDDED in this process. In the
  // two-service deployment (the production layout) the runner is a separate
  // host, so that path finds nothing. /download goes through the runner's own
  // snapshot endpoint and additionally falls back to the stored backup, so it
  // still returns data after a deploy has wiped the container.
  /* "Data files" looked dead on tap. It was not: the request runs, but a
     tar.gz of a workspace can take seconds to build on the runner, and
     nothing on screen changed in the meantime — no spinner, no text. When
     the job had never written a file the only feedback was a toast that is
     easy to miss behind the details sheet. So the button now reports its
     own state, and an empty result explains itself instead of vanishing. */
  const btn = document.getElementById("jdDlDb");
  const label = btn && btn.querySelector("span");
  const original = label ? label.textContent : "";
  if (btn) { btn.disabled = true; btn.classList.add("loading"); }
  if (label) label.textContent = "Preparing…";
  try {
    const dl = await fetch("/api/jobs/" + job.id + "/download",
                           {headers: token ? {Authorization: "Bearer " + token} : {}});
    if (dl.ok) {
      const blob = await dl.blob();
      // A 0-byte body is a success status with nothing in it — say so rather
      // than handing the user an empty file and letting them discover it.
      if (!blob.size) {
        toast("The archive came back empty — the job has not written any data files yet.", "error");
      } else {
        _downloadBlob(blob, safe + "-data.tar.gz");
        toast("Data downloaded (" + Math.max(1, Math.round(blob.size / 1024)) + " KB)", "success");
      }
      return;
    }
    let msg = "No data files yet";
    try { msg = (await dl.json()).detail || msg; } catch (_e) {}
    if (dl.status === 404) {
      msg = "Nothing to download yet — this job has not written a database or "
          + "data file. Files the bot creates while running will appear here.";
    }
    toast(msg, "error");
  } catch (e) {
    toast("Download failed: " + (e.message || "network error"), "error");
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
    if (label) label.textContent = original;
  }
}

/* Back up this job's data files to the database right now. */
async function _jdBackupNow() {
  const job = _jdCurrentJob();
  if (!job) return;
  try {
    const d = await api("/api/jobs/" + job.id + "/snapshot", "POST", null, true);
    toast(`Backed up ${d.files} file(s)`, "success");
    _jdRefreshBackupRow();
  } catch (e) { toast(e.message || "Backup failed", "error"); }
}

/* Force the stored backup back over the live workspace. Destructive, so it
   asks first — this rolls the bot back to the backup's point in time. */
async function _jdRestoreBackup() {
  const job = _jdCurrentJob();
  if (!job) return;
  if (!confirm("Restore the last backup?\n\nThis OVERWRITES the job's current "
             + "data files and restarts it. Anything the bot has written since "
             + "the backup will be lost.")) return;
  try {
    const d = await api("/api/jobs/" + job.id + "/snapshot/restore", "POST", null, true);
    toast(`Restored ${d.restored} file(s) — restarting`, "success");
    _jdRefreshBackupRow();
  } catch (e) { toast(e.message || "Restore failed", "error"); }
}

/* Show when the data was last backed up. */
async function _jdRefreshBackupRow() {
  const job = _jdCurrentJob();
  const el = document.getElementById("jdBackup");
  if (!job || !el) return;
  try {
    const d = await api("/api/jobs/" + job.id + "/snapshot", "GET", null, true);
    if (!d.enabled) { el.textContent = "disabled"; return; }
    if (!d.snapshot) { el.textContent = "no backup yet"; return; }
    const kb = Math.max(1, Math.round((d.snapshot.bytes || 0) / 1024));
    el.textContent = `${d.snapshot.files} file(s) · ${kb} KB · ${_agoText(d.snapshot.updated_at)}`;
  } catch (e) { el.textContent = "—"; }
}

function _agoText(iso) {
  if (!iso) return "unknown";
  const t = Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/* ---- wiring: every control below performs a real action ------------- */
/* ============================================================
   JOB DETAIL PAGE  ·  pill tab router
   The old page stacked eight always-visible cards. Now exactly one
   panel is mounted at a time, so switching tabs replaces the whole
   content area rather than scrolling to a different card.
   ============================================================ */
let _jdTab = "code";

function jdSwitchTab(name) {
  const tabs = document.querySelectorAll("#jdTabs .jd-tab");
  if (!tabs.length) return;
  const valid = [...tabs].some(t => t.dataset.jdtab === name);
  if (!valid) name = "code";
  _jdTab = name;

  tabs.forEach(t => {
    const on = t.dataset.jdtab === name;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("#jdScroll .jd-panel").forEach(p => {
    const on = p.id === "jdPanel" + name.charAt(0).toUpperCase() + name.slice(1);
    p.classList.toggle("is-active", on);
    p.hidden = !on;
  });

  // The Logs tab shows the same stream as the Code tab's Output pane, so
  // mirror the buffer instead of opening a second connection.
  if (name === "logs") _jdMirrorLogs();
  // CodeMirror paints blank if it was sized while display:none.
  if (name === "code") { try { _jobCmRefresh(); } catch (e) {} }
}

/* Keep the full-height Logs panel in step with the Output pane. */
function _jdMirrorLogs() {
  const src = document.getElementById("jdLogBody");
  const dst = document.getElementById("jdLogFull");
  if (!src || !dst) return;
  // textContent, never innerHTML: log lines are untrusted program output.
  dst.textContent = src.textContent || "";
  if (_jdLogFollow) dst.scrollTop = dst.scrollHeight;
}

function _initJdTabs() {
  const bar = document.getElementById("jdTabs");
  if (!bar || bar.dataset.wired === "1") return;
  bar.dataset.wired = "1";
  bar.addEventListener("click", (e) => {
    const t = e.target.closest(".jd-tab");
    if (!t) return;
    e.preventDefault();
    jdSwitchTab(t.dataset.jdtab);
  });
  // Arrow keys move between tabs, per the ARIA tablist pattern.
  bar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...bar.querySelectorAll(".jd-tab")];
    const i = tabs.findIndex(t => t.classList.contains("is-active"));
    if (i < 0) return;
    e.preventDefault();
    const n = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    jdSwitchTab(tabs[n].dataset.jdtab);
    tabs[n].focus();
  });

  // Overflow menu — Restart / Stop / Open in editor / Delete.
  const moreBtn = document.getElementById("jdMoreBtn");
  const menu = document.getElementById("jdMoreMenu");
  if (moreBtn && menu) {
    const close = () => { menu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); };
    moreBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // Clicking an item runs its own handler; the menu just gets out of the way.
    menu.addEventListener("click", () => setTimeout(close, 0));
    document.addEventListener("click", (e) => {
      if (menu.hidden) return;
      if (!menu.contains(e.target) && e.target !== moreBtn) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) { e.stopPropagation(); close(); }
    });
  }

  // Theme toggle in the detail header reuses the app-wide toggle.
  const th = document.getElementById("jdThemeToggle");
  if (th) th.addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof toggleTheme === "function") toggleTheme();
  });
}

function _initDetailWiring() {
  _initJdTabs();
  const panel = document.getElementById("jobDetailPanel");
  if (!panel || panel.dataset.wired === "1") return;
  panel.dataset.wired = "1";

  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); fn(el); });
  };

  // open from the editor
  const openBtn = document.getElementById("btnJobDetails");
  if (openBtn) openBtn.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation(); openJobDetails();
  });

  on("jobDetailBack", () => closeJobDetails());
  // A stopped job is brought back up through the same in-place restart
  // endpoint the editor uses — there is no separate "start" API.
  on("jdStart",   () => { if (_selectedJobId) restartJobById(_selectedJobId); });
  on("jdStop",    () => { if (_selectedJobId) stopJobById(_selectedJobId); });
  on("jdRestart", () => { if (_selectedJobId) restartJobById(_selectedJobId); });
  on("jdEditCode", () => { closeJobDetails(); setTimeout(_jobCmFocus, 220); });
  on("jdDelete", (btn) => {
    if (!_selectedJobId) return;
    if (!confirm("Delete this job? This cannot be undone.")) return;
    const id = _selectedJobId;
    closeJobDetails();
    deleteJobById(id, btn);
  });

  on("jdHealthNow", () => _jdCheckHealth());
  on("jdUrlCopy", () => {
    const a = document.getElementById("jdUrl");
    const u = a ? a.textContent : "";
    if (!u || !navigator.clipboard) { toast("Nothing to copy", "error"); return; }
    navigator.clipboard.writeText(u).then(() => toast("URL copied", "success"));
  });

  on("jdCopy", () => {
    const b = document.getElementById("jdLogBody");
    const t = b ? b.textContent : "";
    if (!t.trim()) { toast("Nothing to copy", "error"); return; }
    if (!navigator.clipboard) { toast("Clipboard not available", "error"); return; }
    navigator.clipboard.writeText(t).then(() => toast("Logs copied", "success"));
  });
  on("jdClear", () => {
    const b = document.getElementById("jdLogBody");
    if (b) b.innerHTML = '<span class="rs-log-empty">// Cleared.</span>';
    _lastLogText = null;                      // allow the next tick to repaint
  });

  const follow = document.getElementById("jdFollow");
  if (follow) follow.addEventListener("change", () => { _jdLogFollow = follow.checked; });

  on("jdEnvAdd", () => {
    const list = document.getElementById("jdEnvList");
    if (list) list.appendChild(_jdEnvRow("", ""));
  });

  on("jdDlSource", () => _jdDownload("source"));
  on("jdDlLogs",   () => _jdDownload("logs"));
  on("jdDlDb",     () => _jdDownload("db"));

  on("jdBackupNow",     () => _jdBackupNow());
  on("jdRestoreBackup", () => _jdRestoreBackup());

  // Escape closes the page, like any full-screen view.
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && _jdOpen) closeJobDetails();
  });
}

(function _waitBoot(){
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(_initWbWiring, 30);
    setTimeout(_initDetailWiring, 40);
  } else {
    document.addEventListener("DOMContentLoaded", () => { setTimeout(_initWbWiring, 30); setTimeout(_initDetailWiring, 40); });
  }
})();

// ─── Actions ──────────────────────────────────────────────────────────
async function toggleJobAccess(id, makePublic) {
  try {
    const info = await api(`/api/jobs/${id}/access`, "POST", { public: makePublic }, true);
    if (info && info.web_private_url) {
      toast("Private link copied ✓", "success"); copyText(info.web_private_url);
    } else {
      toast(makePublic ? "Forge is now PUBLIC" : "Forge is now PRIVATE", "info");
    }
    loadJobs();
  } catch (e) { toast(e.message, "error"); }
}

async function startJob() {
  const nameEl = document.getElementById("jobName");
  let name = (nameEl && nameEl.value || "").trim();
  const language = document.getElementById("jobLang").value;
  const code = _jobCmGetValue();
  const repoUrl = ((document.getElementById("jobRepoUrl") || {}).value || "").trim();
  if (!name && repoUrl) {
    const m = repoUrl.match(/github\.com\/[^/]+\/([^/]+)/);
    if (m) name = m[1].replace(/\.git$/,"");
    if (nameEl && !nameEl.value.trim()) nameEl.value = name;
  }
  const finalName = (nameEl && nameEl.value || "").trim() || name;
  if (nameEl) nameEl.value = finalName;
  if (!finalName) { toast("Name required", "error"); if (nameEl) nameEl.focus(); return; }
  if (!code.trim() && !repoUrl) { toast("Write code or paste a GitHub URL", "error"); return; }
  // Client-side duplicate name guard (server enforces authoritatively)
  if (window._lastJobs) {
    const btn = document.getElementById("btnStartJob");
    const editingId = btn && btn.dataset.editingId;
    const dup = window._lastJobs.find(j => (j.name||"").toLowerCase() === finalName.toLowerCase() && String(j.id) !== String(editingId||""));
    if (dup) {
      toast("You already have a job named \u201c"+finalName+"\u201d \u2014 choose a different name.", "error");
      _setHint("err", "duplicate name");
      if (nameEl) { nameEl.focus(); nameEl.select(); }
      return;
    }
  }
  const btn = document.getElementById("btnStartJob");
  const editingId = btn && btn.dataset.editingId;
  setLoading(btn, true);
  if (btn) {
    btn.classList.add("is-firing","loading");
    const lbl = btn.querySelector(".rs-btn-label");
    btn._origLabel = lbl ? lbl.textContent : null;
    if (lbl) lbl.textContent = editingId ? "Saving\u2026" : "Starting\u2026";
  }
  _setHint("warn", "");
  try {
    const payload = { name: finalName, language, code };
    if (repoUrl) payload.repo_url = repoUrl;
    let info;
    if (editingId) {
      info = await api("/api/jobs/" + editingId, "PATCH", payload, true);
    } else {
      info = await api("/api/jobs", "POST", payload, true);
    }
    toast("Deployed \u2713", "success");
    _setHint("ok", "");
    _jobDirty = false;
    _composingNew = false;      // deployed — polling may take over again
    // 👉 Optimistic UI update: insert the new job into _lastJobs immediately
    // with status="starting" so sidebar + stats reflect the launch right away
    // instead of waiting 7s for the next poll round. SSE will correct to
    // "running"/"crashed" within 1.5s once it connects.
    if (info && info.job_db_id) {
      const stub = {
        id: info.job_db_id,
        name: finalName,
        language: language,
        runner_job_id: info.id,
        status: "starting",
        restarts: 0,
        web: !!info.web,
        web_url: info.web_url || null,
        web_slug: info.web_slug || null,
        web_public: info.web_public !== false,
        code: code,
      };
      window._lastJobs = window._lastJobs || [];
      // remove any prior stub with same id
      window._lastJobs = window._lastJobs.filter(x => String(x.id) !== String(info.job_db_id));
      window._lastJobs.unshift(stub);
      _lastJobsSig = "";  // force renderJobs to repaint
      renderJobs(window._lastJobs);
      selectJob(info.job_db_id);
      if (info.web_url) setTimeout(() => toast("Live URL ready \u2014 tap Details to open", "info"), 800);
    } else {
      await loadJobs();
    }
    // Always refresh the list in the background after 2.5s so the real status
    // (running/installing/crashed) overtakes our optimistic stub.
    setTimeout(() => { loadJobs().catch(()=>{}); }, 2500);
  } catch (e) {
    toast(e.message, "error");
    _setHint("err", e.message);
  } finally {
    setLoading(btn, false);
    if (btn) {
      btn.classList.remove("is-firing","loading");
      const lbl = btn.querySelector(".rs-btn-label");
      if (lbl && btn._origLabel) lbl.textContent = btn._origLabel;
      setTimeout(() => btn.classList.remove("is-firing"), 700);
    }
  }
}

async function stopJobById(id) {
  const btn = document.getElementById("btnStopJob");
  const svg = btn && btn.querySelector(".rs-ic-sm");
  try {
    if (svg) { svg.style.animation = "rsSpin .7s linear"; btn.disabled = true; }
    await api("/api/jobs/" + id + "/stop", "POST", null, true);
    toast("Stopped", "info");
    const j = (window._lastJobs||[]).find(x => String(x.id) === String(id));
    if (j) { j.status = "stopped"; _reflectJobStatus(j); }
    loadJobs();
    if (String(_selectedJobId) === String(id)) restartLogStream(id);
    setTimeout(() => { if (svg) { svg.style.animation = ""; btn.disabled = false; } }, 500);
  } catch (e) {
    if (svg) { svg.style.animation = ""; btn.disabled = false; }
    toast(e.message, "error");
  }
}
async function restartJobById(id) {
  const btn = document.getElementById("btnRestartJob");
  const svg = btn && btn.querySelector(".rs-ic-sm");
  try {
    if (svg) { svg.style.animation = "rsSpin .7s linear"; }
    await api("/api/jobs/" + id + "/restart", "POST", null, true);
    toast("Restarted", "success");
    const j = (window._lastJobs||[]).find(x => String(x.id) === String(id));
    if (j) { j.status = "starting"; _reflectJobStatus(j); }
    loadJobs();
    if (String(_selectedJobId) === String(id)) restartLogStream(id);
    setTimeout(()=>{ if (svg) svg.style.animation=""; }, 720);
  } catch (e) {
    if (svg) svg.style.animation="";
    toast(e.message, "error");
  }
}
async function deleteJobById(id, btn) {
  try {
    await api("/api/jobs/" + id, "DELETE", null, true);
    if (String(_selectedJobId) === String(id)) deselectJob();
    toast("Deleted", "info");
    const row = btn && btn.closest && btn.closest(".job-item");
    if (row) { row.classList.add("row-leave"); await new Promise(r => setTimeout(r, 180)); }
    loadJobs();
  } catch (e) { toast(e.message, "error"); }
}

function startJobPolling()  { loadJobs(); if (_jobsTimer) clearInterval(_jobsTimer); _jobsTimer = setInterval(loadJobs, 7000); }
function stopJobPolling()   { if (_jobsTimer) { clearInterval(_jobsTimer); _jobsTimer = null; } }

// Refresh CM when switching TO the jobs tab (CM needs a refresh any time it
// transitions from display:none to visible otherwise it paints blank).
(function() {
  const orig = window.switchTab;
  window.switchTab = function(tabId) {
    const r = orig.apply(this, arguments);
    if (tabId === "jobs") {
      // If we have no prior data at all, enter 'loading' immediately so the
      // boot skeleton is painted on top of the empty panel before loadJobs
      // fires (prevents the premature "No job selected" flash). Stale cache
      // stays visible via stale-while-revalidate inside loadJobs.
      const hasPrior = !!(window._lastJobs && window._lastJobs.length);
      if (!hasPrior) _setJobsStatus("loading");
      _lastJobsTs = 0;
      startJobPolling();
      const cmRefresh = () => {
        try {
          initJobCodeMirror();
          _jobCmRefresh();
          requestAnimationFrame(() => requestAnimationFrame(_jobCmRefresh));
        } catch(e){}
      };
      setTimeout(cmRefresh, 30);
      setTimeout(cmRefresh, 200);
    }
    return r;
  };
})();

/* ==================== ADMIN CONSOLE (owner-only) ====================
   The sidebar button stays hidden until /profile says is_admin. The server
   answers 404 (not 403) for everybody else, so the panel's existence is
   never leaked. Destructive actions re-ask the admin's OWN 2FA code. */
/* ==================== ADMIN CONSOLE (owner-only) ====================
   The sidebar button stays hidden until /profile says is_admin. The server
   answers 404 (not 403) for everybody else, so the panel's existence is
   never leaked. Destructive actions re-ask the admin's OWN 2FA code. */
/* ==================== ADMIN CONSOLE (owner-only) ====================
   The sidebar button stays hidden until /profile says is_admin. The server
   answers 404 (not 403) for everybody else, so the panel's existence is
   never leaked. Destructive actions re-ask the admin's OWN 2FA code. */
let _admPending = null;   // { user_id, suspended } awaiting 2FA confirm

let _adminFetching = false;  // guard: one in-flight markup fetch at a time
let _adminSectHtml = null;   // pristine copy so the panel can come BACK on
                             // this device when an actual admin signs in next
function applyAdminVisibility(profile) {
  const isAdm = !!(profile && profile.is_admin);
  let btn = document.getElementById("tabBtnAdmin");
  // The nav button is stripped from the shell too, for the same reason as the
  // section: a hidden button is still discoverable in the page source.
  if (isAdm && !btn) {
    const bar = document.querySelector(".dash-tabs");
    if (bar) {
      bar.insertAdjacentHTML("beforeend",
        '<button title="Admin console" class="dash-tab tab-secondary" ' +
        'id="tabBtnAdmin" data-tab="admin">' +
        '<svg class="tab-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 3.5 5 6v5.5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6z"/>' +
        '<path d="M9.2 11.8l2 2 3.6-4"/></svg>' +
        '<span class="tab-tx">Admin</span></button>');
      btn = document.getElementById("tabBtnAdmin");
      if (btn && typeof _wireTabButton === "function") _wireTabButton(btn);
      else if (btn) btn.addEventListener("click", () => switchTab("admin"));
    }
  }
  if (btn) btn.classList.toggle("hidden", !isAdm);
  let sect = document.getElementById("tab-admin");

  if (isAdm) {
    // The shell no longer ships the console's markup — it was readable in the
    // page source by any anonymous visitor. Fetch it once, from an endpoint
    // behind the same 404 gate as the admin data.
    if (!sect) {
      if (_adminSectHtml) {
        const host = document.querySelector(".dash-main");
        if (host) host.insertAdjacentHTML("beforeend", _adminSectHtml);
      } else if (!_adminFetching) {
        _adminFetching = true;
        // Plain fetch, not api(): api() parses JSON and its 5th argument is a
        // retry flag, not options. This endpoint returns HTML.
        fetch(API + "/admin/panel-html", {
          headers: authToken ? {Authorization: "Bearer " + authToken} : {},
        })
          .then(r => (r.ok ? r.text() : Promise.reject(r.status)))
          .then(html => {
            _adminSectHtml = html;
            const host = document.querySelector(".dash-main");
            if (host && !document.getElementById("tab-admin")) {
              host.insertAdjacentHTML("beforeend", html);
            }
            if (currentTab === "admin" && typeof loadAdminPanel === "function") {
              loadAdminPanel();
            }
          })
          .catch(() => {})          // 404 => not an admin after all; stay quiet
          .finally(() => { _adminFetching = false; });
      }
    }
    return;
  }

  // STEALTH for everyone else — the panel must not merely hide its DATA, it
  // must not EXIST: non-admins get "this page isn't here", exactly like the
  // server's 404. Remove the section from the DOM (switchTab then no-ops on
  // it), bounce anyone sitting on it, and scrub the /admin URL + any saved
  // deep-link so the address bar never advertises it either.
  if (sect && !_adminSectHtml) _adminSectHtml = sect.outerHTML;
  if (currentTab === "admin") switchTab("overview");
  if (sect) sect.remove();
  try {
    if (_clientPath() === "/admin") history.replaceState({}, "", "/dashboard");
    if (sessionStorage.getItem("ahad_return_to") === "/admin") sessionStorage.removeItem("ahad_return_to");
  } catch (e) {}
}

/* Live refresh for the admin panel.
   10s, and ONLY while the tab is open and the document is visible. A
   monitoring tool that keeps polling in a background tab is just a second
   source of load on the box it is supposed to be watching — the exact
   mistake worth avoiding on a 512MB free tier. */
let _admTimer = null;
const ADM_POLL_MS = 10000;

function _admSetPolling(on) {
  if (_admTimer) { clearInterval(_admTimer); _admTimer = null; }
  if (!on) return;
  _admTimer = setInterval(() => {
    // The age label has to keep counting even while the tab is hidden or a
    // request is failing, otherwise it freezes at a reassuring "updated 3s
    // ago" that is no longer true.
    _admRenderFreshness();
    if (document.hidden) return;                 // tab in the background
    if (!document.getElementById("admStats")) return;
    loadAdminPanel(true).catch(() => {});        // a failed poll is not fatal
  }, ADM_POLL_MS);
}
// Resume immediately when the admin comes back to the tab, rather than
// waiting out the remainder of an interval on stale numbers.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && _admTimer) loadAdminPanel(true).catch(() => {});
});

/* Every render here replaces innerHTML wholesale, which is fine on first load
 * and destructive on a poll: the row the admin was reading scrolls back to the
 * top and keyboard focus falls out to <body>. That makes the panel unusable by
 * keyboard and jumpy on a phone — every 10 seconds, silently.
 *
 * Rather than teach seven renderers to diff, preserve the two things a person
 * actually notices across a repaint: where they had scrolled, and what they
 * had focused. Rows are re-findable because they carry a stable id. */
function _admPreserve(fn) {
  const active = document.activeElement;
  // Only track focus that is INSIDE the panel. Restoring it otherwise would
  // steal focus from, say, the 2FA box in the confirm modal.
  const panel = document.getElementById("tab-admin");
  // Identify the focused element by a stable key the renderers stamp on, not
  // by its onclick string — quoting an arbitrary attribute back into a
  // selector is a bug waiting to happen.
  const tracked = active && panel && panel.contains(active) && active !== document.body
    ? active.getAttribute("data-adm-key")
    : null;
  const scrolls = [...document.querySelectorAll("#tab-admin .adm-table-wrap")]
    .map(el => [el.id || el.querySelector("table")?.id || "", el.scrollTop]);

  fn();

  scrolls.forEach(([key, top]) => {
    if (!top) return;
    const el = document.getElementById(key)?.closest(".adm-table-wrap");
    if (el) el.scrollTop = top;
  });
  if (tracked) {
    // The key names the LOGICAL row ("job:12"), so the same row is refocused
    // even though the element itself was replaced.
    const again = document.querySelector(
      `#tab-admin [data-adm-key="${tracked}"]`);
    if (again && again.focus) again.focus();
  }
}

let _admInFlight = false;

async function loadAdminPanel(force) {
  const stats = document.getElementById("admStats");
  if (!stats) return;
  // A slow poll must not stack on the previous one. Without this, a runner
  // taking longer than the interval to answer queues refreshes until the
  // whole pool is being hammered by the panel watching it.
  if (_admInFlight) return;
  _admInFlight = true;
  // Whether the panel currently HAS real numbers on screen. Read before
  // force clears the marker: the poll always passes force=true, so testing
  // dataset.loaded in the catch below would always have seen "not loaded"
  // and blanked a perfectly good panel on the first failed refresh.
  const hadData = stats.dataset.loaded === "1";
  if (force) delete stats.dataset.loaded;
  if (!hadData) {
    stats.innerHTML = '<div class="adm-stat"><b>…</b><span>loading</span></div>';
  }
  try {
    const [ov, usersR, jobsR, reportsR, auditR, libsR] = await Promise.all([
      api("/admin/overview", "GET", null, true),
      api("/admin/users", "GET", null, true),
      api("/admin/jobs", "GET", null, true),
      api("/admin/abuse-reports", "GET", null, true),
      api("/admin/audit-log", "GET", null, true),
      api("/admin/libraries", "GET", null, true).catch(() => null),
    ]);
    _admPreserve(() => {
      renderAdminStats(ov || {});
      renderAdminSpark(ov || {});
      renderAdminJobs((jobsR && jobsR.jobs) || []);
      renderAdminUsers((usersR && usersR.users) || []);
      renderAdminReports((reportsR && reportsR.reports) || []);
      renderAdminAudit((auditR && auditR.audit) || []);
      renderAdminLibs(libsR || {});
    });
    _admMarkFresh();
    stats.dataset.loaded = "1";
  } catch (e) {
    // 404 for non-admins — stay quiet and ambiguous, just like the server.
    // On a POLL, though, leave the numbers alone: one failed request is
    // usually a sleeping worker, and blanking a working panel to "Nothing
    // here" over it is a lie about the platform's state.
    if (hadData) {
      _admMarkStale();
      stats.dataset.loaded = "1";      // the numbers are old, not absent
    } else {
      stats.innerHTML = '<div class="adm-empty">Nothing here.</div>';
    }
  } finally {
    _admInFlight = false;
  }
}

/* When the numbers were last true. A live panel that silently stops updating
 * is worse than one that never claimed to be live, so the timestamp is shown
 * and goes stale visibly. */
let _admLastOk = 0;

function _admMarkFresh() {
  _admLastOk = Date.now();
  _admRenderFreshness();
}

function _admMarkStale() {
  _admRenderFreshness(true);
}

function _admRenderFreshness(failed) {
  const el = document.getElementById("admFresh");
  if (!el) return;
  if (!_admLastOk) { el.textContent = ""; return; }
  const age = Math.round((Date.now() - _admLastOk) / 1000);
  const when = age < 15 ? "just now" : age < 90 ? `${age}s ago` :
               `${Math.round(age / 60)}m ago`;
  el.textContent = failed || age > 30 ? `last updated ${when} · retrying` :
                   `updated ${when}`;
  el.classList.toggle("stale", !!failed || age > 30);
}

/* Installed packages, heaviest first.
 *
 * This used to be a popularity list ordered by count, with the owners hidden
 * in a title= tooltip — which does not exist on a phone, so on mobile the
 * panel answered nothing at all. On a 512MB box the question is never "which
 * package is popular", it is "what is eating the memory and whose is it".
 */
function renderAdminLibs(data) {
  const el = document.getElementById("admLibs");
  if (!el) return;
  const rows = (data && data.libraries) || [];
  const hint = document.getElementById("admLibsHint");
  if (hint) {
    // A job importing numpy AND requests adds its whole RSS to both rows, so
    // this column does not sum to the platform total. Saying so is the
    // difference between a useful signal and a wrong number.
    hint.textContent = data && data.mem_attributed
      ? `attributed memory — a job counts toward every package it imports · ${data.jobs_sampled || 0} job${data.jobs_sampled === 1 ? "" : "s"} sampled`
      : "across running jobs";
  }
  if (!rows.length) {
    el.innerHTML = '<div class="adm-empty">No packages recorded yet.</div>';
    return;
  }
  // textContent per cell — a package name is untrusted input and must never
  // be parsed as HTML.
  el.textContent = "";
  rows.slice(0, 60).forEach(r => {
    const row = document.createElement("div");
    row.className = "adm-lib";

    const main = document.createElement("div");
    main.className = "adm-lib-main";
    const name = document.createElement("span");
    name.className = "adm-lib-name";
    name.textContent = r.library;
    main.appendChild(name);
    if (r.heavy || r.watch) {
      const tag = document.createElement("span");
      tag.className = "adm-lib-tag " + (r.watch ? "watch" : "heavy");
      // "review", not "abuse" — a flag is a prompt to look, not a verdict.
      tag.textContent = r.watch ? "review" : "heavy";
      main.appendChild(tag);
    }

    // The owners, ON the row rather than in a tooltip. Each one opens the app
    // it belongs to, so "numpy is holding 240MB" leads somewhere.
    const who = document.createElement("div");
    who.className = "adm-lib-who";
    (r.jobs || []).slice(0, 6).forEach((j, i) => {
      if (i) who.append(document.createTextNode(", "));
      const a = document.createElement("a");
      a.className = "adm-link";
      a.href = "#";
      a.textContent = `${j.owner}/${j.name}`;
      a.onclick = (e) => { e.preventDefault(); openAdminJob(j.job_id); };
      who.appendChild(a);
    });
    if ((r.jobs || []).length > 6) {
      who.append(document.createTextNode(` +${r.jobs.length - 6} more`));
    }
    main.appendChild(who);

    const count = document.createElement("span");
    count.className = "adm-lib-count";
    count.textContent = r.mem_mb != null
      ? `${Math.round(r.mem_mb)}MB · ${r.count} job${r.count === 1 ? "" : "s"}`
      : `${r.count} job${r.count === 1 ? "" : "s"} · ${r.pct_of_jobs}%`;

    row.append(main, count);
    el.appendChild(row);
  });
}

function renderAdminStats(ov) {
  const el = document.getElementById("admStats");
  const chip = (label, val, cls) =>
    `<div class="adm-stat${cls ? " " + cls : ""}"><b>${val}</b><span>${label}</span></div>`;
  el.innerHTML =
    chip("users", ov.users ?? 0) +
    chip("verified", ov.verified ?? 0) +
    chip("suspended", ov.suspended ?? 0, ov.suspended ? "warn" : "") +
    chip("apps live", ov.jobs_deployed ?? 0) +
    chip("on telegram", ov.telegram_linked ?? 0) +
    chip("memory", ov.mem_safe_mb != null
        ? `${Math.round(ov.mem_used_mb ?? 0)}MB / ${ov.mem_safe_mb}MB`
        : "—",
      (ov.mem_pct ?? 0) >= 90 ? "warn" : "");
  const cap = document.getElementById("admCap");
  if (cap) {
    // Capacity is MEMORY, not slots. 20 idle bots and 3 heavy ones can occupy
    // the same RAM, so a slot count never predicted whether the next job fits.
    if (ov.mem_safe_mb != null) {
      const jobs = ov.runner_running ?? 0;
      let txt = `${Math.round(ov.mem_used_mb ?? 0)}MB / ${ov.mem_safe_mb}MB`
              + ` (${ov.mem_pct ?? 0}%) — ${jobs} job${jobs === 1 ? "" : "s"} running`;
      if (ov.mem_total_mb) txt += ` · ${ov.mem_total_mb}MB total`;
      if ((ov.workers || []).length > 1) {
        txt += ` · ${ov.workers_online ?? 0}/${ov.workers.length} workers online`;
      }
      cap.textContent = txt;
    } else {
      cap.textContent = "capacity: runner unreachable";
    }
  }
}

function renderAdminSpark(ov) {
  const el = document.getElementById("admSpark");
  if (!el) return;
  const byDay = {};
  (ov.signups_daily || []).forEach(r => { byDay[r.day] = r.count; });
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    days.push({ label: key.slice(5), count: byDay[key] || 0 });
  }
  const max = Math.max(1, ...days.map(d => d.count));
  el.innerHTML = days.map(d => {
    const h = Math.max(6, Math.round((d.count / max) * 56));
    return `<span class="adm-bar${d.count ? "" : " zero"}" style="height:${h}px" title="${d.label}: ${d.count} signup${d.count === 1 ? "" : "s"}"></span>`;
  }).join("");
}

/* The list answers "what exists". Memory and restarts are here because they
   are what makes a row worth opening — a table of names and uptimes gives no
   reason to look closer at any particular app. */
function renderAdminJobs(jobs) {
  const el = document.getElementById("admJobs");
  if (!el) return;
  if (!jobs.length) { el.innerHTML = '<tr><td class="adm-empty">No RunSpace apps yet.</td></tr>'; return; }
  el.innerHTML = '<tr><th>App</th><th>Owner</th><th>Status</th><th>Memory</th><th>Uptime</th><th>Restarts</th></tr>' +
    jobs.map(j => {
      const st = (j.live_status || (j.runner_job_id ? "offline" : "stopped")).toLowerCase();
      const live = st === "running";
      const mem = j.mem_mb != null
        ? `${Math.round(j.mem_mb)}MB${j.peak_mem_mb ? ` <small>peak ${Math.round(j.peak_mem_mb)}MB</small>` : ""}`
        : "—";
      // A restart count above zero is the single loudest signal in this table:
      // the app is crash-looping. It gets the warning treatment, not a number
      // buried in grey.
      const rs = j.restarts
        ? `<span class="adm-pill warn">${j.restarts}×</span>`
        : '<span class="adm-num-zero">0</span>';
      return `<tr tabindex="0" role="button" data-adm-key="job:${j.id}" onclick="openAdminJob(${j.id})" ` +
      `onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openAdminJob(${j.id});}">` +
      `<td><b>${escapeHtml(j.name)}</b><small>${escapeHtml(j.language)} · ${escapeHtml((j.created_at || "").slice(0, 10))}</small></td>` +
      `<td>${escapeHtml(j.owner)}${j.owner_suspended ? ' <span class="adm-pill warn">suspended</span>' : ""}` +
      // The owner can drive this app from a chat. That changes who to contact
      // when something is wrong, so it belongs on the row.
      `${j.source === "telegram" ? ' <span class="adm-pill tg">tg</span>' : ""}</td>` +
      `<td><span class="adm-pill${live ? " ok" : ""}">${escapeHtml(st)}</span></td>` +
      `<td>${mem}</td>` +
      `<td>${j.uptime_s ? _fmtUptime(j.uptime_s) : "—"}</td>` +
      `<td>${rs}</td></tr>`;
    }).join("");
}

/* ---------- per-app detail ---------- */

// Why an app died, in the language of the person reading it. The runner emits
// a short machine token; leaving that on screen makes the console look like a
// log file instead of an answer.
// The four tokens runner/app.py actually writes to last_exit_reason. I first
// wrote this map from memory and invented "killed"/"error", which the runner
// never emits — so every real crash would have fallen through to the raw
// token. The keys below are read off the source, not guessed.
const ADM_EXIT_REASON = {
  oom: "Stopped — it used more memory than it is allowed.",
  crash: "Crashed with a non-zero exit code — see the log below.",
  manual: "Stopped on request.",
  exit: "Finished on its own and exited cleanly.",
};

function _admRow(label, value, cls) {
  const td = document.createElement("td");
  if (value instanceof Node) td.appendChild(value);
  else td.textContent = value == null || value === "" ? "—" : String(value);
  if (cls) td.className = cls;
  const th = document.createElement("th");
  th.textContent = label;
  const tr = document.createElement("tr");
  tr.append(th, td);
  return tr;
}

async function openAdminJob(jobId) {
  const modal = document.getElementById("admJobModal");
  const body = document.getElementById("admJobBody");
  if (!modal || !body) return;
  document.getElementById("admJobTitle").textContent = "Loading…";
  body.textContent = "";
  openModal("admJobModal");
  let d;
  try {
    d = await api("/admin/jobs/" + jobId, "GET", null, true);
  } catch (e) {
    // 404 here means the row vanished between the list load and the click,
    // or the caller is not an admin. Either way: say nothing revealing.
    body.innerHTML = '<div class="adm-empty">Nothing here.</div>';
    return;
  }
  renderAdminJobDetail(d);
}

function renderAdminJobDetail(d) {
  const j = (d && d.job) || {};
  const body = document.getElementById("admJobBody");
  const title = document.getElementById("admJobTitle");
  if (!body) return;
  title.textContent = j.name || "App";
  body.textContent = "";

  const st = (j.status || "unknown").toLowerCase();
  const head = document.createElement("div");
  head.className = "adm-jd-head";
  const pill = document.createElement("span");
  pill.className = "adm-pill" + (st === "running" ? " ok" : (st === "unknown" ? " warn" : ""));
  pill.textContent = st;
  head.appendChild(pill);
  if (j.status_stale) {
    // "offline" would be a claim about the app; the truth is that we could not
    // reach the worker. Saying the wrong one manufactures a false alarm.
    const note = document.createElement("span");
    note.className = "adm-hint";
    note.textContent = "the worker did not answer — this status is stale, not a diagnosis";
    head.appendChild(note);
  }
  body.appendChild(head);

  if (j.last_exit_reason) {
    const why = document.createElement("div");
    why.className = "adm-jd-why";
    why.textContent = ADM_EXIT_REASON[j.last_exit_reason] || ("Last exit: " + j.last_exit_reason);
    body.appendChild(why);
  }

  const t = document.createElement("table");
  t.className = "adm-table adm-jd-table";
  const mem = j.mem_mb != null
    ? `${Math.round(j.mem_mb)}MB now · ${Math.round(j.peak_mem_mb || 0)}MB peak`
    : "—";
  const ownerCell = document.createElement("span");
  ownerCell.textContent = j.owner || "—";
  if (j.owner_suspended) {
    const s = document.createElement("span");
    s.className = "adm-pill warn";
    s.textContent = "suspended";
    ownerCell.append(" ", s);
  }
  // Now that the per-account view exists, this is a way through to it: "one
  // heavy app" and "this account is the load" are different findings and the
  // console should let you tell them apart in one click.
  const link = document.createElement("a");
  link.className = "adm-link";
  link.href = "#";
  link.textContent = `${j.owner_job_count || 0} app${j.owner_job_count === 1 ? "" : "s"} on this account →`;
  link.onclick = (e) => { e.preventDefault(); closeModal("admJobModal"); openAdminUser(j.user_id); };
  ownerCell.append(document.createElement("br"), link);

  t.append(
    _admRow("Owner", ownerCell),
    _admRow("Email", j.owner_email),
    _admRow("Created via", j.source
      ? j.source + (j.owner_telegram_name ? ` · ${j.owner_telegram_name}` : "")
        + " (inferred)"
      : "—"),
    _admRow("Language", j.language),
    _admRow("Memory", mem),
    _admRow("CPU", j.cpu_pct != null ? j.cpu_pct + "%" : "—"),
    _admRow("Uptime", j.uptime_s ? _fmtUptime(j.uptime_s) : "—"),
    _admRow("Restarts", j.restarts != null ? String(j.restarts) : "—"),
    _admRow("Worker", j.worker),
    _admRow("Created", (j.created_at || "").slice(0, 16)),
  );
  if (j.web_slug) t.appendChild(_admRow("Public URL", "/live/" + j.web_slug + "/"));
  // KEYS only. The values are bot tokens and API secrets; the console has no
  // reason to display a credential to prove it exists.
  if ((j.env_keys || []).length) {
    t.appendChild(_admRow("Env keys", j.env_keys.join(", ")));
  }
  if ((j.libs || []).length) t.appendChild(_admRow("Packages", j.libs.join(", ")));
  body.appendChild(t);

  const logHead = document.createElement("div");
  logHead.className = "adm-panel-head";
  const h = document.createElement("h3");
  h.textContent = "Recent log";
  const hint = document.createElement("span");
  hint.className = "adm-hint";
  hint.textContent = d.log_truncated ? "last 200 lines" : "the app's own output";
  logHead.append(h, hint);
  body.appendChild(logHead);

  // textContent, not innerHTML: a job's log is whatever the user's program
  // decided to print, which makes it the most obviously untrusted string on
  // the page.
  const pre = document.createElement("pre");
  pre.className = "adm-jd-log";
  pre.textContent = d.logs || (d.runner_reachable ? "(no output yet)" : "(the worker did not answer)");
  body.appendChild(pre);
}

function renderAdminUsers(users) {
  const el = document.getElementById("admUsers");
  if (!el) return;
  if (!users.length) { el.innerHTML = '<tr><td class="adm-empty">No users yet.</td></tr>'; return; }
  const meId = _lastProfile && _lastProfile.id;
  el.innerHTML = '<tr><th>User</th><th>Joined</th><th>Apps</th><th>Telegram</th><th>Status</th><th></th></tr>' +
    users.map(u => {
      const isMe = meId && u.id === meId;
      const state = u.is_suspended
        ? '<span class="adm-pill warn">suspended</span>'
        : (u.is_verified ? '<span class="adm-pill ok">active</span>' : '<span class="adm-pill">unverified</span>');
      const act = isMe
        ? '<span class="adm-hint">you</span>'
        : `<button class="adm-act${u.is_suspended ? " ok" : ""}" onclick="askSuspend(${u.id}, ${u.is_suspended ? 0 : 1}, this)">${u.is_suspended ? "Reactivate" : "Suspend"}</button>`;
      // The Suspend button lives inside the row, so its click must not also
      // open the drill-down behind the confirm modal.
      return `<tr tabindex="0" role="button" data-adm-key="user:${u.id}" onclick="if(!event.target.closest('.adm-act'))openAdminUser(${u.id})" ` +
        `onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openAdminUser(${u.id});}">` +
        `<td><b>${escapeHtml(u.username)}</b><small>${escapeHtml(u.email)}</small></td>` +
        `<td>${escapeHtml((u.created_at || "").slice(0, 10))}</td>` +
        `<td>${u.job_count}</td>` +
        `<td>${u.telegram_id
            ? `<span class="adm-pill tg">${escapeHtml(u.telegram_name || String(u.telegram_id))}</span>`
            : '<span class="adm-num-zero">—</span>'}</td>` +
        `<td>${state}</td><td>${act}</td></tr>`;
    }).join("");
}

/* ---------- per-account drill-down ---------- */

async function openAdminUser(userId) {
  const body = document.getElementById("admUserBody");
  if (!body) return;
  document.getElementById("admUserTitle").textContent = "Loading…";
  body.textContent = "";
  openModal("admUserModal");
  let d;
  try {
    d = await api("/admin/users/" + userId, "GET", null, true);
  } catch (e) {
    body.innerHTML = '<div class="adm-empty">Nothing here.</div>';
    return;
  }
  renderAdminUserDetail(d);
}

function renderAdminUserDetail(d) {
  const u = (d && d.user) || {};
  const body = document.getElementById("admUserBody");
  if (!body) return;
  document.getElementById("admUserTitle").textContent = u.username || "Account";
  body.textContent = "";

  const head = document.createElement("div");
  head.className = "adm-jd-head";
  const pill = document.createElement("span");
  pill.className = "adm-pill" + (u.is_suspended ? " warn" : (u.is_verified ? " ok" : ""));
  pill.textContent = u.is_suspended ? "suspended" : (u.is_verified ? "active" : "unverified");
  head.appendChild(pill);
  if (u.is_admin) {
    const a = document.createElement("span");
    a.className = "adm-pill";
    a.textContent = "admin";
    head.appendChild(a);
  }
  body.appendChild(head);

  const t = document.createElement("table");
  t.className = "adm-table adm-jd-table";
  t.append(
    _admRow("Email", u.email),
    // Inferred from which credential exists — there is no auth_method column,
    // and presenting a guess as a recorded fact is how a console starts lying.
    _admRow("Signed up via", u.auth_method
      ? u.auth_method + (u.auth_method_inferred ? " (inferred)" : "") : "—"),
    _admRow("Joined", (u.created_at || "").slice(0, 16)),
    _admRow("Apps", `${(d.jobs || []).length} total · ${d.jobs_running || 0} running`),
    _admRow("Memory", `${Math.round(d.mem_used_mb || 0)}MB across their running apps`),
    _admRow("Devices seen", `${d.devices || 0} device${d.devices === 1 ? "" : "s"} · ${d.networks || 0} network${d.networks === 1 ? "" : "s"}`),
    _admRow("Telegram", u.telegram_id
      ? `${u.telegram_name || "linked"} · ID ${u.telegram_id}`
      : "not connected"),
    _admRow("Last IP", u.last_ip),
  );
  body.appendChild(t);

  // ---- their apps, each openable ----
  body.appendChild(_admSubhead("Apps", "tap one for its full detail"));
  if (!(d.jobs || []).length) {
    body.appendChild(_admEmpty("No apps on this account."));
  } else {
    const jt = document.createElement("table");
    jt.className = "adm-table clickable";
    jt.innerHTML = "<tr><th>App</th><th>Status</th><th>Memory</th></tr>";
    d.jobs.forEach(j => {
      const tr = document.createElement("tr");
      tr.setAttribute("role", "button");
      tr.tabIndex = 0;
      const open = () => { closeModal("admUserModal"); openAdminJob(j.id); };
      tr.onclick = open;
      tr.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      };
      const c1 = document.createElement("td");
      const b = document.createElement("b");
      b.textContent = j.name;
      const sm = document.createElement("small");
      sm.textContent = j.language || "";
      c1.append(b, sm);
      const st = (j.live_status || "stopped").toLowerCase();
      const c2 = document.createElement("td");
      const p = document.createElement("span");
      p.className = "adm-pill" + (st === "running" ? " ok" : "");
      p.textContent = st;
      c2.appendChild(p);
      const c3 = document.createElement("td");
      c3.textContent = j.mem_mb != null ? `${Math.round(j.mem_mb)}MB` : "—";
      tr.append(c1, c2, c3);
      jt.appendChild(tr);
    });
    body.appendChild(jt);
  }

  // ---- other accounts on the same device/network ----
  // The reason a per-user view exists on a free host: one person running six
  // accounts is invisible in a user list and obvious here.
  const linked = d.linked_accounts || [];
  body.appendChild(_admSubhead(
    `Linked accounts (${linked.length})`,
    linked.length ? "same device or network" : ""));
  if (!linked.length) {
    body.appendChild(_admEmpty("No other account shares this device or IP."));
  } else {
    const note = document.createElement("div");
    note.className = "adm-jd-why neutral";
    // A shared IP is a household, an office or a mobile carrier as often as
    // it is a farm. Stating that stops the panel reading as an accusation.
    note.textContent = d.linked_note || "";
    body.appendChild(note);
    const lt = document.createElement("table");
    lt.className = "adm-table clickable";
    lt.innerHTML = "<tr><th>Account</th><th>Joined</th><th>Status</th></tr>";
    linked.forEach(o => {
      const tr = document.createElement("tr");
      tr.setAttribute("role", "button");
      tr.tabIndex = 0;
      const open = () => openAdminUser(o.id);
      tr.onclick = open;
      tr.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      };
      const c1 = document.createElement("td");
      const b = document.createElement("b");
      b.textContent = o.username;
      const sm = document.createElement("small");
      sm.textContent = o.email || "";
      c1.append(b, sm);
      const c2 = document.createElement("td");
      c2.textContent = (o.created_at || "").slice(0, 10);
      const c3 = document.createElement("td");
      const p = document.createElement("span");
      p.className = "adm-pill" + (o.is_suspended ? " warn" : "");
      p.textContent = o.is_suspended ? "suspended" : "active";
      c3.appendChild(p);
      tr.append(c1, c2, c3);
      lt.appendChild(tr);
    });
    body.appendChild(lt);
  }

  // ---- login history ----
  body.appendChild(_admSubhead("Recent logins", "IP and device, newest first"));
  const sessions = (d.sessions || []).slice(0, 12);
  if (!sessions.length) {
    body.appendChild(_admEmpty("No sessions recorded."));
  } else {
    const stb = document.createElement("table");
    stb.className = "adm-table";
    stb.innerHTML = "<tr><th>When</th><th>IP</th><th>Device</th></tr>";
    sessions.forEach(sv => {
      const tr = document.createElement("tr");
      [(sv.created_at || "").slice(0, 16), sv.ip_address || "—",
       sv.device_info || "—"].forEach(v => {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
      });
      stb.appendChild(tr);
    });
    body.appendChild(stb);
  }
}

function _admSubhead(title, hint) {
  const h = document.createElement("div");
  h.className = "adm-panel-head adm-jd-sub";
  const t = document.createElement("h3");
  t.textContent = title;
  h.appendChild(t);
  if (hint) {
    const s = document.createElement("span");
    s.className = "adm-hint";
    s.textContent = hint;
    h.appendChild(s);
  }
  return h;
}

function _admEmpty(text) {
  const e = document.createElement("div");
  e.className = "adm-empty";
  e.textContent = text;
  return e;
}

function renderAdminReports(reports) {
  const el = document.getElementById("admReports");
  if (!el) return;
  if (!reports.length) { el.innerHTML = '<tr><td class="adm-empty">No abuse reports — all quiet. 🎉</td></tr>'; return; }
  el.innerHTML = '<tr><th>When</th><th>Reported URL</th><th>Reason</th><th>Status</th></tr>' +
    reports.map(r =>
      `<tr><td>${escapeHtml((r.created_at || "").slice(0, 16))}</td>` +
      `<td><a class="adm-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url.length > 48 ? r.url.slice(0, 48) + "…" : r.url)}</a></td>` +
      `<td>${escapeHtml(r.reason || "—")}</td>` +
      `<td><span class="adm-pill${r.status === "open" ? " warn" : ""}">${escapeHtml(r.status)}</span></td></tr>`
    ).join("");
}

function renderAdminAudit(audit) {
  const el = document.getElementById("admAudit");
  if (!el) return;
  if (!audit.length) { el.innerHTML = '<tr><td class="adm-empty">No admin actions recorded yet.</td></tr>'; return; }
  el.innerHTML = '<tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th></tr>' +
    audit.map(a =>
      `<tr><td>${escapeHtml((a.created_at || "").slice(0, 16))}</td>` +
      `<td>${escapeHtml(a.admin_name || "—")}</td>` +
      `<td><span class="adm-pill">${escapeHtml(a.action)}</span></td>` +
      `<td>${escapeHtml(a.target || "")}</td></tr>`
    ).join("");
}

function askSuspend(userId, suspend, btn) {
  const row = btn.closest("tr");
  const uname = row ? (row.querySelector("b") || {}).textContent || "this user" : "this user";
  _admPending = { user_id: userId, suspended: !!suspend };
  document.getElementById("adminModalTitle").textContent = suspend ? `Suspend ${uname}?` : `Reactivate ${uname}?`;
  document.getElementById("adminModalText").textContent = suspend
    ? `${uname} will be signed out on every device and their RunSpace apps will stop. You can reactivate anytime. Confirm with YOUR authenticator code.`
    : `${uname} gets their access back immediately. Confirm with YOUR authenticator code.`;
  document.getElementById("adminTfaCode").value = "";
  openModal("adminModal");
  setTimeout(() => { const i = document.getElementById("adminTfaCode"); if (i) i.focus(); }, 80);
}

async function confirmAdminAction() {
  if (!_admPending) { closeModal("adminModal"); return; }
  const btn = document.getElementById("adminModalGo");
  const code = document.getElementById("adminTfaCode").value.trim();
  if (!code) { toast("Enter your 6-digit authenticator code.", "error"); return; }
  setLoading(btn, true);
  try {
    const res = await api("/admin/users/set-suspended", "POST",
      { user_id: _admPending.user_id, suspended: _admPending.suspended, code }, true);
    _admPending = null;
    closeModal("adminModal");
    toast((res && res.message) || "Done.", "success");
    loadAdminPanel(true);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

// Enter inside the admin 2FA box = confirm. (Wired once at boot.)
(function () {
  const box = document.getElementById("adminTfaCode");
  if (box) box.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmAdminAction(); });
})();

// Code Studio full-bleed: toggle body class so CSS can strip dash-main padding
(function(){
  const origSwitch = window.switchTab;
  if(!origSwitch) return;
  window.switchTab = function(t){
    document.body.classList.toggle('code-active', t === 'code');
    return origSwitch.apply(this, arguments);
  };
})();

/* ---------- Code Studio: explorer / terminal / status wiring ---------- */
(function(){
  function csReady(){
    var studio = document.getElementById('tab-code');
    if(!studio) return false;
    var root = studio;
    function $(id){ return document.getElementById(id); }
    var codeEl = $('snippetContent');
    var titleEl = $('snippetTitle');
    var langEl = $('snippetLanguage');
    var expBtn = $('btnExplorer');
    var termTgl = $('btnToggleTerm');
    var termAct = $('btnTermActivity');
    var ahClose = $('ahTermClose');

    // Explorer toggle
    if(expBtn){
      expBtn.addEventListener('click', function(){
        root.classList.toggle('explorer-open');
        expBtn.classList.toggle('active', root.classList.contains('explorer-open'));
        if(termAct) termAct.classList.remove('active');
        setTimeout(function(){ if(window._cmEditor) window._cmEditor.refresh(); }, 220);
      });
      // Default open on desktop
      if(window.innerWidth > 900) {
        root.classList.add('explorer-open');
        expBtn.classList.add('active');
      }
    }
    // Terminal toggle
    function toggleTerm(force){
      var isOpen = root.classList.contains('term-open');
      if(typeof force === 'boolean') isOpen = !force;
      if(isOpen){ root.classList.remove('term-open'); if(termTgl)termTgl.classList.remove('active'); if(termAct)termAct.classList.remove('active'); }
      else { root.classList.add('term-open'); if(termTgl)termTgl.classList.add('active'); if(termAct)termAct.classList.add('active'); }
    }
    if(termTgl) termTgl.addEventListener('click', function(){ toggleTerm(); });
    if(termAct) termAct.addEventListener('click', function(){
      root.classList.remove('explorer-open');
      if(expBtn) expBtn.classList.remove('active');
      toggleTerm(true);
    });
    if(ahClose) ahClose.addEventListener('click', function(){ toggleTerm(true); });

    // Auto-open terminal when Run pressed (defer until Run is wired)
    document.addEventListener('click', function(e){
      var t = e.target.closest('#btnRunCode');
      if(t) { if(!root.classList.contains('term-open')) toggleTerm(); }
    });

    // Status bar: Ln/Col
    function updateCursor(){
      var ln = $('csStatusLn');
      var ln2 = $('csStatusLang');
      if(ln2 && langEl) ln2.textContent = (langEl.options[langEl.selectedIndex]||{}).textContent || 'Plaintext';
      if(!ln) return;
      if(window._cmEditor){
        var c = window._cmEditor.getCursor();
        ln.textContent = 'Ln '+(c.line+1)+', Col '+(c.ch+1);
      } else if(codeEl && document.activeElement===codeEl) {
        var v = codeEl.value.substring(0, codeEl.selectionStart);
        var line = v.split('\n').length;
        var col = v.length - v.lastIndexOf('\n');
        ln.textContent = 'Ln '+line+', Col '+col;
      }
    }
    setInterval(updateCursor, 250);

    // Ctrl+B = explorer, Ctrl+` = terminal, Esc close preview/term
    document.addEventListener('keydown', function(e){
      if(!document.body.classList.contains('code-active')) return;
      if((e.ctrlKey||e.metaKey) && e.key==='b' && !e.shiftKey && !e.altKey){ e.preventDefault(); if(expBtn) expBtn.click(); }
      if(e.key==='`' && !e.ctrlKey && !e.metaKey && !e.shiftKey && document.activeElement!==codeEl && (!window._cmEditor || !window._cmEditor.hasFocus())) { e.preventDefault(); toggleTerm(); }
      if(e.key==='Escape'){
        if(root.classList.contains('term-open')) { root.classList.remove('term-open'); if(termTgl)termTgl.classList.remove('active'); if(termAct)termAct.classList.remove('active'); }
      }
    });
    return true;
  }
  if(!csReady()){
    var iv = setInterval(function(){ if(csReady()) clearInterval(iv); }, 150);
  }
})();

// Copy current editor content
(function(){
  var b = document.getElementById("btnCopySnippet");
  if(b) b.addEventListener("click", async function(){
    try {
      var c = window.cmEditor ? window.cmEditor.getValue() : (document.getElementById("snippetContent")||{}).value || "";
      if(!c){ toast("Nothing to copy", "error"); return; }
      await navigator.clipboard.writeText(c);
      toast("Code copied to clipboard", "success");
    } catch(e){ toast("Copy failed", "error"); }
  });
  var d = document.getElementById("btnDownloadSnippet");
  if(d) d.addEventListener("click", function(){
    var c = window.cmEditor ? window.cmEditor.getValue() : (document.getElementById("snippetContent")||{}).value || "";
    var t = ((document.getElementById("snippetTitle")||{}).value||"untitled").trim();
    var lang = (document.getElementById("snippetLanguage")||{}).value||"txt";
    var ext = {html:"html",css:"css",javascript:"js",typescript:"ts",python:"py",markdown:"md",bash:"sh",text:"txt",json:"json",sql:"sql",java:"java",cpp:"cpp",c:"c",go:"go",php:"php",ruby:"rb"}[lang]||"txt";
    var fname = t + (t.indexOf('.')===-1 ? '.'+ext : '');
    var blob = new Blob([c], {type:"text/plain;charset=utf-8"});
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 100);
    toast("Downloaded "+fname, "success");
  });
  // Capture username for pretty @url
  try {
    var n = document.getElementById("dashUsername");
    if(n && n.textContent) window.__user = n.textContent.trim();
    var n2 = document.getElementById("dashUsername2");
    if(n2 && n2.textContent && !window.__user) window.__user = n2.textContent.trim();
  } catch(e){}
})();

/* ---------- RunSpace/Code/Terminal body class scoping ---------- */
(function(){
  function hook(){
    if(!window.switchTab){ setTimeout(hook,50); return; }
    var orig = window.switchTab;
    window.switchTab = function(t){
      var r = orig.apply(this,arguments);
      document.body.classList.toggle('rs-active', t==='jobs');
      document.body.classList.toggle('code-active', t==='code');
      document.body.classList.toggle('term-active', t==='term');
      // Always close drawer/log-toggle when leaving jobs
      if (t !== 'jobs') {
        document.body.classList.remove('rs-side-open','rs-logs-open');
      }
      return r;
    };
  }
  hook();
})();

/* Files popover (Apple-glass) — replaces sidebar on desktop, always on mobile */
(function(){
  var pop = null;
  function closePop(){
    if(pop){ pop.remove(); pop = null; }
    document.querySelectorAll('#btnExplorer').forEach(b=>b.classList.remove('active'));
  }
  function openPop(){
    if(pop) { closePop(); return; }
    var btn = document.getElementById('btnExplorer');
    if(!btn) return;
    var list = document.getElementById('snippetsList');
    pop = document.createElement('div');
    pop.className = 'cs-files-pop';
    // Build items from current snippetsList
    var items = list ? list.querySelectorAll('.snippet-item') : [];
    var html = '<div class="cs-fp-head">Files<span class="cs-fp-count">'+items.length+'</span></div>';
    html += '<button class="cs-fp-item" data-action="new" style="color:#3fb950"><span>+</span><span class="cs-fpi-name">New file…</span></button>';
    items.forEach(function(it){
      var id = it.dataset.id;
      var name = it.querySelector('h4');
      var isPub = it.classList.contains('published');
      if(name) html += '<div class="cs-fp-item'+(isPub?' is-pub':'')+'" data-id="'+id+'"><span style="font-size:12px">📄</span><span class="cs-fpi-name">'+name.textContent+'</span><span class="cs-fpi-act"><button class="dl" title="Download" data-dl="'+id+'"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button></span></div>';
    });
    pop.innerHTML = html;
    document.getElementById('tab-code').appendChild(pop);
    btn.classList.add('active');
    // Actions
    pop.querySelectorAll('[data-id]').forEach(function(el){
      el.addEventListener('click', function(e){
        if(e.target.closest('button[data-dl]')) return;
        loadSnippetIntoEditor(+el.dataset.id);
        closePop();
      });
    });
    pop.querySelector('[data-action=new]').addEventListener('click', function(){
      if(typeof newSnippetDraft==='function') newSnippetDraft();
      closePop();
    });
    pop.querySelectorAll('button[data-dl]').forEach(function(b){
      b.addEventListener('click', function(e){
        e.stopPropagation();
        (async function(){
          var id = +b.dataset.dl;
          try {
            var data = await api('/snippets','GET',null,true);
            var s = (data.snippets||[]).find(x=>x.id===id); if(!s) return;
            var ext = ({html:'html',css:'css',javascript:'js',typescript:'ts',python:'py',markdown:'md',bash:'sh',text:'txt',json:'json'}[s.language])||'txt';
            var fname = s.title + (s.title.indexOf('.')===-1?'.'+ext:'');
            var blob = new Blob([s.content||''],{type:'text/plain;charset=utf-8'});
            var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=fname;
            document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},100);
            toast('Downloaded '+fname,'success');
          } catch(err){ toast(err.message,'error'); }
        })();
      });
    });
    setTimeout(function(){
      document.addEventListener('click', onDoc, {once:true});
    }, 50);
  }
  function onDoc(e){
    if(pop && !pop.contains(e.target) && e.target.id!=='btnExplorer' && !e.target.closest('#btnExplorer')) closePop();
  }
  document.addEventListener('click', function(e){
    var b = e.target.closest('#btnExplorer');
    if(b) { e.preventDefault(); e.stopPropagation(); openPop(); }
  });
  // Move the sidebar to be a companion hidden store for snippetsList — we render from there into popover
  // Keep original list rendering so loadSnippets() still works
})();

// ── RunSpace extra wiring (Clear / Download / mobile log toggle) ──
(function(){
  var _wired = false;
  function wire(){
    if(_wired) return;
    if(!document.getElementById('tab-jobs')) return;
    var clr = document.getElementById('jobLogClear');
    if(clr) clr.addEventListener('click', function(){
      var body = document.getElementById('jobLogBody');
      if(body) body.innerHTML = '<span class="rs-log-empty">// Logs cleared.</span>';
    });
    var dl = document.getElementById('jobLogDl');
    if(dl) dl.addEventListener('click', function(){
      var body = document.getElementById('jobLogBody');
      var name = (document.getElementById('jobName')||{}).value || 'job';
      var text = body ? body.textContent : '';
      if(!text){ toast('Logs are empty','error'); return; }
      var blob = new Blob([text],{type:'text/plain;charset=utf-8'});
      var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download = name+'-'+new Date().toISOString().slice(0,10)+'.log';
      document.body.appendChild(a); a.click();
      setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},100);
      toast('Logs downloaded','success');
    });
    _wired = true;
  }
  if(document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(wire, 40);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(wire, 40); });

  // Mobile: tap log header to toggle logs panel
  document.addEventListener('click', function(e){
    if(window.innerWidth > 760) return;
    if(e.target.closest('.rs-log-head')) {
      document.body.classList.toggle('rs-logs-open');
      // CodeMirror needs a refresh after the flex transition, otherwise it paints
      // blank/chopped until the next keystroke.
      setTimeout(function(){ try { if(_jobCm) _jobCm.refresh(); } catch(e){} }, 240);
    }
  });
})();


/* ============================================================
   TELEGRAM LOGIN WIDGET
   The bot @username is deployment-specific, so it is fetched from
   /api/public-config at runtime instead of being hardcoded in the
   markup (the old data-telegram-login="YOUR_BOT_USERNAME" placeholder
   meant the widget never rendered at all).

   We use the callback flow (data-onauth) rather than data-auth-url:
   the backend POST /auth/telegram returns a JSON session token, which
   a full-page redirect could not hand back to this SPA.
   ============================================================ */
window.onTelegramAuth = async function (user) {
  try {
    // §3: fingerprint must be captured on EVERY auth event, Telegram included.
    const payload = Object.assign({}, user, { fingerprint: await ensureFingerprint() });
    const data = await api("/auth/telegram", "POST", payload);
    authToken = data.token;
    localStorage.setItem("ahad_token", authToken);
    try {
      localStorage.setItem("ahad_user", JSON.stringify({ username: data.username, ts: Date.now() }));
    } catch (e) {}
    resetLocalActivity();
    logEvent("success", "Telegram sign-in", `Welcome, ${data.username}`);
    showScreen("screen-dashboard");
    _consumeReturnTo();
    toast(`Welcome, ${data.username}!`, "success");
    loadDashboard();
  } catch (err) {
    toast(err.message || "Telegram sign-in failed", "error");
  }
};

(function initTelegramLogin() {
  function mountWidget(slotId, username) {
    const slot = document.getElementById(slotId);
    if (!slot || slot.dataset.mounted) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.setAttribute("data-telegram-login", username);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-onauth", "onTelegramAuth(user)");
    s.setAttribute("data-request-access", "write");
    slot.appendChild(s);
    slot.dataset.mounted = "1";
  }

  async function mount() {
    let cfg = {};
    try {
      const r = await fetch("/api/public-config");
      if (r.ok) cfg = await r.json();
    } catch (e) { /* older backend / offline */ }

    const username = (cfg.telegram_bot_username || "").trim();
    // Telegram-only mode (server-driven). When Telegram is NOT configured we
    // fall back to showing the e-mail forms so the site is never unusable.
    const tgOnly = cfg.telegram_only !== false;

    const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };

    if (username) {
      mountWidget("telegramLoginBtn", username);
      mountWidget("telegramSignupBtn", username);
      show("telegramLogin", true);
      show("telegramSignup", true);
      show("telegramUnavailable", false);
      show("telegramUnavailableSignup", false);
      show("emailAuthSignin", !tgOnly);
      show("emailAuthSignup", !tgOnly);
      // SAFETY NET. telegram-widget.js is a third-party script: it can be
      // blocked by an extension, blocked by a network, or simply slow. When it
      // never renders its iframe the card showed the hint sentence and NOTHING
      // else — a user who signed out could not get back into their account.
      // Config cannot save them here, because the config is what hid the form,
      // so this checks the DOM for a button that actually exists.
      setTimeout(() => {
        ["telegramLoginBtn", "telegramSignupBtn"].forEach((slotId) => {
          const slot = document.getElementById(slotId);
          if (!slot) return;
          if (slot.querySelector("iframe")) return;     // widget is fine
          const isSignin = slotId === "telegramLoginBtn";
          show(isSignin ? "telegramUnavailable" : "telegramUnavailableSignup", true);
          show(isSignin ? "emailAuthSignin" : "emailAuthSignup", true);
        });
      }, 4000);
    } else {
      // No bot configured: hide Telegram, reveal e-mail so users can still log in.
      show("telegramLogin", false);
      show("telegramSignup", false);
      show("telegramUnavailable", tgOnly);
      show("telegramUnavailableSignup", tgOnly);
      show("emailAuthSignin", true);
      show("emailAuthSignup", true);
    }
  }
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(mount, 60);
  else document.addEventListener("DOMContentLoaded", function () { setTimeout(mount, 60); });
})();



// Warm the fingerprint cache at boot so the first job-create request already
// carries X-Fingerprint (the device limit is useless if the header is absent).
(function warmFingerprint() {
  const go = function () { ensureFingerprint(); };
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(go, 300);
  else document.addEventListener("DOMContentLoaded", function () { setTimeout(go, 300); });
})();


/* Warn before the tab/window closes with unsaved RunSpace work. Without this
   a refresh or accidental close silently discarded whatever was typed. */
window.addEventListener("beforeunload", function (e) {
  const hasWork = (typeof _jobDirty !== "undefined" && _jobDirty) ||
    (typeof _composingNew !== "undefined" && _composingNew &&
     (function () { try { return (_jobCmGetValue() || "").trim().length > 0; } catch (err) { return false; } })());
  if (!hasWork) return;
  e.preventDefault();
  e.returnValue = "";
  return "";
});


/* ============================================================
   TOP PROGRESS BAR (§2) — Chrome / NProgress style
   Grows smoothly toward ~90% while a tab switch loads, then snaps to
   100% and fades. Animated with transform: scaleX() only, so the
   compositor handles it and no layout/paint work is triggered.
   ============================================================ */
let _progEl = null, _progTimer = 0, _progVal = 0, _progDepth = 0;

function _progressBar() {
  if (_progEl) return _progEl;
  const el = document.createElement("div");
  el.id = "rsProgress";
  el.className = "rs-progress";
  el.innerHTML = '<div class="rs-progress-fill"></div>';
  document.body.appendChild(el);
  _progEl = el;
  return el;
}

function _progressSet(v) {
  const fill = _progressBar().querySelector(".rs-progress-fill");
  _progVal = v;
  fill.style.transform = "scaleX(" + v + ")";
}

function _progressStart() {
  // Nested loads share one bar instead of restarting it.
  _progDepth++;
  if (_progDepth > 1) return;
  const el = _progressBar();
  el.classList.remove("done");
  el.classList.add("active");
  _progressSet(0.08);
  clearInterval(_progTimer);
  // Asymptotic crawl: each tick closes part of the remaining gap, so the bar
  // keeps moving but never reaches the end until the load actually finishes.
  _progTimer = setInterval(() => {
    const remaining = 0.9 - _progVal;
    if (remaining <= 0.001) return;
    _progressSet(_progVal + remaining * 0.12);
  }, 120);
}

function _progressDone() {
  if (_progDepth > 0) _progDepth--;
  if (_progDepth > 0) return;          // another load still running
  clearInterval(_progTimer);
  _progTimer = 0;
  const el = _progressBar();
  _progressSet(1);
  el.classList.add("done");
  setTimeout(() => {
    el.classList.remove("active", "done");
    _progressSet(0);
  }, 260);
}

/* ══════════════════════════════════════════════════════════════════════════
   CODE STUDIO — FILE UPLOAD  (single file; .zip deferred, see the note)

   Two entry points, ONE handler: the "Upload file" menu row and the
   drag-and-drop zone both feed _csHandleUpload(). Once the text is in the
   editor there is no "uploaded" state anywhere -- it is the same draft the
   user would have typed, so save / run / publish need no new code path.
   That is requirement 5, and it is met by construction rather than by
   remembering to keep two paths in sync.

   ON .zip (requirement 3): the brief says to reuse the file-tree component
   from the GitHub-import work and explicitly NOT to build a second one.
   That component does not exist yet -- GitHub import currently lives in
   RunSpace and clones server-side with no tree UI, and #snippetsList is a
   flat list of saved snippets, not a tree. Building a tree here would
   create exactly the duplicate the brief forbids, so .zip is rejected with
   a message that says why rather than half-implemented. The brief also
   ranks single-file as the higher-value piece to do first.
   ══════════════════════════════════════════════════════════════════════════ */

/* 9 MB. The editor holds the whole file in memory as a string, CodeMirror
   re-tokenises it on every keystroke, and /snippets stores it in one row --
   past roughly this size the tab janks rather than fails, which is worse. */
const CS_UPLOAD_MAX_BYTES = 9 * 1024 * 1024;

/* Extension -> the language values #snippetLanguage actually offers. An
   extension not listed still uploads; it just opens as plain text. */
const CS_EXT_LANG = {
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json", webmanifest: "json",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql",
  java: "java", kt: "java",
  c: "cpp", h: "cpp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  go: "go",
  php: "php", phtml: "php",
  rb: "ruby", rake: "ruby", gemfile: "ruby",
  txt: "text", log: "text", env: "text", ini: "text", cfg: "text",
  conf: "text", toml: "text", yml: "text", yaml: "text", xml: "text",
  csv: "text", tsv: "text", rs: "text", swift: "text", lua: "text",
  pl: "text", r: "text", dart: "text", gitignore: "text", dockerfile: "text",
};

/* Extensions that must never reach the editor. This is the cheap first
   gate; the byte sniff below is the one that actually decides, because an
   extension is trivially renamed. */
const CS_BLOCKED_EXT = new Set([
  "exe","dll","so","dylib","bin","com","msi","app","apk","ipa","deb","rpm",
  "jar","war","class","pyc","pyo","o","a","lib","obj","wasm","elf",
  "zip","tar","gz","bz2","xz","7z","rar","iso","dmg","pkg",
  "png","jpg","jpeg","gif","webp","bmp","ico","tiff","svgz","avif","heic",
  "mp3","mp4","wav","ogg","webm","avi","mov","mkv","flac","m4a",
  "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods",
  "db","sqlite","sqlite3","mdb","dat","pack","idx",
  "ttf","otf","woff","woff2","eot",
]);

/* Magic numbers for formats that commonly arrive renamed as .txt/.py. */
const CS_MAGIC = [
  { sig: [0x4d, 0x5a],                   name: "a Windows executable" },      // MZ
  { sig: [0x7f, 0x45, 0x4c, 0x46],       name: "a Linux executable" },        // ELF
  { sig: [0xca, 0xfe, 0xba, 0xbe],       name: "a Java class file" },
  { sig: [0x50, 0x4b, 0x03, 0x04],       name: "a zip archive" },
  { sig: [0x50, 0x4b, 0x05, 0x06],       name: "a zip archive" },
  { sig: [0x1f, 0x8b],                   name: "a gzip archive" },
  { sig: [0x89, 0x50, 0x4e, 0x47],       name: "a PNG image" },
  { sig: [0xff, 0xd8, 0xff],             name: "a JPEG image" },
  { sig: [0x47, 0x49, 0x46, 0x38],       name: "a GIF image" },
  { sig: [0x25, 0x50, 0x44, 0x46],       name: "a PDF" },
  { sig: [0x52, 0x61, 0x72, 0x21],       name: "a RAR archive" },
  { sig: [0x37, 0x7a, 0xbc, 0xaf],       name: "a 7-Zip archive" },
  { sig: [0x00, 0x61, 0x73, 0x6d],       name: "a WebAssembly module" },
  { sig: [0xfe, 0xed, 0xfa, 0xce],       name: "a macOS executable" },
  { sig: [0xcf, 0xfa, 0xed, 0xfe],       name: "a macOS executable" },
];

function _csExt(name) {
  const base = String(name || "").toLowerCase().split(/[\\/]/).pop();
  if (base === "dockerfile" || base === "makefile") return base;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

/* Decide whether these bytes are text.
 *
 * Extension and MIME are both attacker-controlled, so the verdict comes
 * from the CONTENT:
 *   · a known binary magic number is an immediate reject, named so the
 *     message is useful;
 *   · a NUL byte in the first 8 KB means binary -- no text encoding this
 *     editor supports produces one (UTF-16 would, which is why the BOM is
 *     checked first and rejected explicitly rather than mangled);
 *   · a high proportion of non-printable control characters means binary
 *     even without a NUL.
 */
function _csSniff(bytes, fileName) {
  const n = Math.min(bytes.length, 8192);
  if (!n) return { ok: true };                       // empty file is fine

  for (const m of CS_MAGIC) {
    if (bytes.length >= m.sig.length && m.sig.every((b, i) => bytes[i] === b))
      return { ok: false, why: "This looks like " + m.name + ", not source code." };
  }
  // UTF-16/32 BOMs: technically text, but decoded as UTF-8 they become
  // mojibake, so say so instead of loading garbage.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    return { ok: false, why: "This file is UTF-16. Save it as UTF-8 and try again." };

  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return { ok: false, why: "This file contains binary data, not text." };
    // Printable, or one of tab / LF / CR / form feed / escape.
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) ctrl++;
  }
  if (ctrl / n > 0.10)
    return { ok: false, why: "This file does not look like text." };
  return { ok: true };
}

function _csBytesLabel(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/* The single handler. Both entry points call this. */
async function _csHandleUpload(file) {
  if (!file) return;

  const ext = _csExt(file.name);

  // .zip gets its own message: it is a deliberate deferral, not a bug.
  if (ext === "zip") {
    toast("Zip upload is not available yet — it needs the file-tree view. Upload a single file for now.", "error");
    return;
  }
  if (CS_BLOCKED_EXT.has(ext)) {
    toast("." + ext + " files cannot be opened in the editor — text and code only.", "error");
    return;
  }
  if (file.size > CS_UPLOAD_MAX_BYTES) {
    toast("That file is " + _csBytesLabel(file.size) + ". The limit is "
          + _csBytesLabel(CS_UPLOAD_MAX_BYTES) + ".", "error");
    return;
  }

  let buf;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    toast("Could not read that file.", "error");
    return;
  }

  const verdict = _csSniff(buf, file.name);
  if (!verdict.ok) { toast(verdict.why, "error"); return; }

  let text;
  try {
    // fatal:true so invalid UTF-8 is caught here rather than silently
    // replaced with U+FFFD all through the user's code.
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    toast("This file is not valid UTF-8 text.", "error");
    return;
  }

  _csLoadTextIntoEditor(text, file.name, ext);
  toast("Opened " + file.name + " (" + _csBytesLabel(file.size) + ")", "success");
}

/* Put text in the editor exactly the way loadSnippetIntoEditor() does, so
   an uploaded file and a saved snippet are indistinguishable afterwards. */
function _csLoadTextIntoEditor(text, fileName, ext) {
  // A fresh draft: this is a new file, not an edit of the open snippet.
  if (typeof editingSnippetId !== "undefined") editingSnippetId = null;

  const titleEl = document.getElementById("snippetTitle");
  if (titleEl) titleEl.value = String(fileName || "untitled").replace(/\.[^.]+$/, "").slice(0, 60);

  const langEl = document.getElementById("snippetLanguage");
  const lang = CS_EXT_LANG[ext] || "text";
  if (langEl) {
    // Only select a value the <select> actually has.
    const has = [...langEl.options].some(o => o.value === lang);
    langEl.value = has ? lang : "text";
  }

  const ta = document.getElementById("snippetContent");
  if (ta) ta.value = text;
  if (typeof cmEditor !== "undefined" && cmEditor) cmEditor.setValue(text);

  if (typeof updateCodeMirrorMode === "function") updateCodeMirrorMode();
  if (typeof updateEditorMeta === "function") updateEditorMeta();
  if (typeof runLivePreview === "function") runLivePreview();
  _csRefreshEmptyState();
}

/* The empty-state upload prompt is only for an empty editor. */
function _csRefreshEmptyState() {
  const box = document.getElementById("csEmptyUpload");
  if (!box) return;
  const ta = document.getElementById("snippetContent");
  let val = ta ? ta.value : "";
  if (typeof cmEditor !== "undefined" && cmEditor && typeof cmEditor.getValue === "function") {
    try { val = cmEditor.getValue(); } catch (e) {}
  }
  box.hidden = !!(val && val.trim());
}

function _initCsUpload() {
  const input = document.getElementById("csFileInput");
  if (!input || input.dataset.wired === "1") return;
  input.dataset.wired = "1";

  const pick = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    input.click();
  };
  const menuBtn  = document.getElementById("btnUploadFile");
  const emptyBtn = document.getElementById("btnUploadFileEmpty");
  if (menuBtn)  menuBtn.addEventListener("click", pick);
  if (emptyBtn) emptyBtn.addEventListener("click", pick);

  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    // Reset first: without this, choosing the SAME file twice fires no
    // change event and the second attempt silently does nothing.
    input.value = "";
    if (f) _csHandleUpload(f);
  });

  // ── drag and drop ────────────────────────────────────────────────────
  const zone = document.getElementById("ideEditor");
  const drop = document.getElementById("csDropZone");
  if (zone && drop) {
    // dragenter/dragleave fire for every child element the pointer crosses,
    // so a naive show/hide flickers. Count the enters instead.
    let depth = 0;
    const show = () => { drop.classList.add("is-over"); drop.setAttribute("aria-hidden", "false"); };
    const hide = () => { depth = 0; drop.classList.remove("is-over"); drop.setAttribute("aria-hidden", "true"); };

    const isFileDrag = (e) =>
      !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"));

    zone.addEventListener("dragenter", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); depth++; show();
    });
    zone.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    zone.addEventListener("dragleave", (e) => {
      if (!isFileDrag(e)) return;
      depth--; if (depth <= 0) hide();
    });
    zone.addEventListener("drop", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation(); hide();
      const files = e.dataTransfer.files;
      if (!files || !files.length) return;
      if (files.length > 1) {
        toast("One file at a time for now — zip/multi-file needs the file tree.", "error");
        return;
      }
      _csHandleUpload(files[0]);
    });
  }

  // The browser's default is to NAVIGATE to a dropped file, which throws
  // away unsaved work. Suppress that everywhere outside the drop zone.
  ["dragover", "drop"].forEach(evt => {
    document.addEventListener(evt, (e) => {
      if (e.target && e.target.closest && e.target.closest("#ideEditor")) return;
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) e.preventDefault();
    });
  });

  _csRefreshEmptyState();
  const ta = document.getElementById("snippetContent");
  if (ta) ta.addEventListener("input", _csRefreshEmptyState);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => setTimeout(_initCsUpload, 40));
else setTimeout(_initCsUpload, 40);

/* ══════════════════════════════════════════════════════════════════════════
   RUNSPACE FILE BROWSER  —  cloned repos are multi-file

   Until now only one file of a cloned repo was reachable, so a user could
   not even open the requirements.txt whose install had failed. This lists
   the job's working directory, opens any text file in the editor, and lets
   the user pin which file Run executes when auto-detection guessed wrong.

   Row markup reuses the .cs-fp-* classes from Code Studio's file popover
   rather than introducing a second file-row component.

   The listing is fetched fresh on every open. There is no client cache on
   purpose: a stale tree is the same class of bug as the stale entry scan
   this work fixed on the server.
   ══════════════════════════════════════════════════════════════════════════ */

let _rsFilesEntry = null;   // entry path as the RUNNER currently sees it

function _rsFilesPanel() { return document.getElementById("rsFiles"); }

function _rsFileIcon(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (["py","js","mjs","ts","rb","php","sh","go","java","c","cpp","rs"].includes(ext)) return "‹›";
  if (["json","yml","yaml","toml","ini","cfg","env"].includes(ext)) return "⚙";
  if (["md","txt","rst"].includes(ext)) return "¶";
  if (ext === "txt" || path === "requirements.txt") return "≡";
  return "•";
}

async function rsLoadFiles(force) {
  const panel = _rsFilesPanel();
  const list = document.getElementById("rsFilesList");
  if (!panel || !list) return;
  if (!_selectedJobId) {
    list.innerHTML = '<div class="rs-log-empty">Select a job first.</div>';
    return;
  }
  list.innerHTML = '<div class="rs-log-empty">Loading…</div>';
  try {
    const data = await api("/api/jobs/" + _selectedJobId + "/files", "GET", null, true);
    const files = data.files || [];
    _rsFilesEntry = data.entry || null;
    const count = document.getElementById("rsFileCount");
    if (count) count.textContent = String(files.length);

    if (!files.length) {
      list.innerHTML = '<div class="rs-log-empty">' +
        (data.note || "No files yet — start the job once.") + "</div>";
      return;
    }

    list.innerHTML = files.map(f => {
      const isEntry = f.path === _rsFilesEntry;
      const openable = f.text !== false;
      // textContent-safe: build with escaped text, never raw interpolation.
      const safe = f.path.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const kb = f.size < 1024 ? f.size + " B" : Math.round(f.size / 1024) + " KB";
      return '<div class="cs-fp-item rs-file-row' + (isEntry ? " is-entry" : "") + '"' +
             ' data-path="' + safe + '"' + (openable ? "" : ' data-binary="1"') + '>' +
               '<span class="rs-file-ic" aria-hidden="true">' + _rsFileIcon(f.path) + "</span>" +
               '<span class="cs-fpi-name">' + safe + "</span>" +
               (isEntry ? '<span class="rs-file-entry" title="Runs on Start">entry</span>' : "") +
               '<span class="rs-file-size">' + kb + "</span>" +
               '<span class="cs-fpi-act">' +
                 (isEntry || !openable ? "" :
                   '<button class="rs-file-pin" data-pin="' + safe + '" title="Set as entry point">⌖</button>') +
               "</span>" +
             "</div>";
    }).join("");

    if (data.truncated) {
      list.insertAdjacentHTML("beforeend",
        '<div class="rs-log-empty">Listing truncated — this repo has a lot of files.</div>');
    }
  } catch (err) {
    list.innerHTML = '<div class="rs-log-empty">' +
      String(err.message || "Could not list files").replace(/</g, "&lt;") + "</div>";
  }
}

async function rsOpenFile(path) {
  if (!_selectedJobId) return;
  try {
    const data = await api("/api/jobs/" + _selectedJobId + "/file?path=" +
                           encodeURIComponent(path), "GET", null, true);
    // Reuse the ordinary editor setter — an opened repo file is just code.
    _jobCmSetValue(data.content || "");
    const ext = (path.split(".").pop() || "").toLowerCase();
    const map = { py: "python", js: "javascript", mjs: "javascript",
                  rb: "ruby", php: "php", sh: "bash", json: "javascript" };
    if (map[ext]) _jobCmSetMode(map[ext]);
    _setHint("", "Viewing " + path);
    toast("Opened " + path, "info");
  } catch (err) {
    toast(err.message || "Could not open that file", "error");
  }
}

async function rsPinEntry(path) {
  if (!_selectedJobId) return;
  try {
    const res = await api("/api/jobs/" + _selectedJobId + "/entry", "POST",
                          { path }, true);
    _rsFilesEntry = res.entry || path;
    toast("Entry point set to " + _rsFilesEntry + " — press Restart to apply", "success");
    await rsLoadFiles(true);
  } catch (err) {
    toast(err.message || "Could not set the entry point", "error");
  }
}

function _initRsFiles() {
  const panel = document.getElementById("rsFiles");
  if (!panel || panel.dataset.wired === "1") return;
  panel.dataset.wired = "1";

  const open = () => { panel.hidden = false; rsLoadFiles(true); };
  const close = () => { panel.hidden = true; };

  const menuItem = document.getElementById("btnFilesInMenu");
  if (menuItem) menuItem.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    open();
  });
  const closeBtn = document.getElementById("rsFilesClose");
  if (closeBtn) closeBtn.addEventListener("click", (e) => { e.preventDefault(); close(); });
  const refresh = document.getElementById("rsFilesRefresh");
  if (refresh) refresh.addEventListener("click", (e) => { e.preventDefault(); rsLoadFiles(true); });

  // One delegated listener: rows are rebuilt on every refresh, so binding
  // per row would leak handlers and miss anything added later.
  const list = document.getElementById("rsFilesList");
  if (list) list.addEventListener("click", (e) => {
    const pin = e.target.closest("[data-pin]");
    if (pin) { e.preventDefault(); e.stopPropagation(); rsPinEntry(pin.getAttribute("data-pin")); return; }
    const row = e.target.closest(".rs-file-row");
    if (!row) return;
    if (row.getAttribute("data-binary") === "1") {
      toast("That file is binary — it cannot be opened in the editor.", "error");
      return;
    }
    rsOpenFile(row.getAttribute("data-path"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) { e.stopPropagation(); close(); }
  });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => setTimeout(_initRsFiles, 50));
else setTimeout(_initRsFiles, 50);

/* ══════════════════════════════════════════════════════════════════════════
   RUNSPACE — upload a file from the device

   RunSpace only had the GitHub URL field, which clones a REPO. There was no
   way to take example.py off a phone and deploy it, which is what was asked
   for. This adds that one thing.

   It reuses the validation already written for Code Studio's upload
   (_csHandleUpload's helpers): same size cap, same blocked extensions, same
   magic-number sniff, same UTF-8 decode. Duplicating that logic would mean
   two places to keep in step, and the security half is not worth having
   twice.

   Once the text is in the editor it is an ordinary draft — Run, save and
   deploy work exactly as if it had been typed.
   ══════════════════════════════════════════════════════════════════════════ */

/* Extension -> the values #jobLang offers. Deliberately smaller than Code
   Studio's map: RunSpace can only RUN these five. */
const RS_EXT_LANG = {
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  sh: "bash", bash: "bash",
  rb: "ruby",
  php: "php",
};

async function _rsHandleUpload(file) {
  if (!file) return;
  const ext = _csExt(file.name);

  if (ext === "zip") {
    toast("Zip upload is not available yet — upload a single file, or import a GitHub repo.", "error");
    return;
  }
  if (CS_BLOCKED_EXT.has(ext)) {
    toast("." + ext + " files cannot be opened — text and code only.", "error");
    return;
  }
  if (file.size > CS_UPLOAD_MAX_BYTES) {
    toast("That file is too large (limit " + Math.round(CS_UPLOAD_MAX_BYTES / 1048576) + " MB).", "error");
    return;
  }

  let buf;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    toast("Could not read that file.", "error");
    return;
  }

  // Same content check as Code Studio: an extension proves nothing, and this
  // code can be deployed as a job.
  const verdict = _csSniff(buf, file.name);
  if (!verdict.ok) { toast(verdict.why, "error"); return; }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    toast("This file is not valid UTF-8 text.", "error");
    return;
  }

  // Name the job after the file, but never clobber a name already typed.
  const nameInp = document.getElementById("jobName");
  if (nameInp && !nameInp.value.trim()) {
    nameInp.value = String(file.name).replace(/\.[^.]+$/, "").slice(0, 60);
  }

  const lang = RS_EXT_LANG[ext];
  const langEl = document.getElementById("jobLang");
  if (langEl && lang && [...langEl.options].some(o => o.value === lang)) {
    langEl.value = lang;
    _jobCmSetMode(lang);
  }

  _jobCmSetValue(text);
  if (typeof _setHint === "function") _setHint("", "Loaded " + file.name);

  if (!lang) {
    toast("Opened " + file.name + " — pick a runtime before running it.", "info");
  } else {
    toast("Opened " + file.name + " — press Run to deploy.", "success");
  }
}

function _initRsUpload() {
  const input = document.getElementById("rsFileInput");
  if (!input || input.dataset.wired === "1") return;
  input.dataset.wired = "1";

  const btn = document.getElementById("btnUploadJobFile");
  if (btn) btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    input.click();
  });

  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    // Clear first: picking the same file twice fires no change event
    // otherwise, and the second attempt appears to do nothing.
    input.value = "";
    if (f) _rsHandleUpload(f);
  });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => setTimeout(_initRsUpload, 60));
else setTimeout(_initRsUpload, 60);

/* ══════════════════════════════════════════════════════════════════════════
   RUNSPACE HEADER ACTIONS
   Save & Run beside the status text, and a "Full details page" row that
   opens the standalone view (with its existing back button) rather than the
   half-height inspector sheet.
   ══════════════════════════════════════════════════════════════════════════ */
function _initRsHeaderActions() {
  const run = document.getElementById("btnRunQuick");
  if (!run || run.dataset.wired === "1") return;
  run.dataset.wired = "1";

  // Forward to the real Run button so there is one deploy implementation.
  run.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const real = document.getElementById("btnStartJob");
    if (real) real.click();
  });

  // Mirror the real button's visibility: Run only means something once a
  // job is open. #rsJobActions is what the app already toggles for that.
  const seg = document.getElementById("rsJobActions");
  const sync = () => {
    const on = !!seg && !seg.hasAttribute("hidden");
    run.hidden = !on;
    const real = document.getElementById("btnStartJob");
    if (real) {
      const label = run.querySelector("span");
      const txt = (real.textContent || "").trim();
      if (label && txt) label.textContent = txt.includes("Run") ? "Save & Run" : txt;
      run.classList.toggle("loading", real.classList.contains("loading"));
    }
  };
  if (seg) new MutationObserver(sync).observe(seg, { attributes: true, attributeFilter: ["hidden"] });
  const realBtn = document.getElementById("btnStartJob");
  if (realBtn) new MutationObserver(sync).observe(realBtn, { attributes: true, attributeFilter: ["class"] });
  sync();

  const full = document.getElementById("btnFullDetails");
  if (full) full.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    // Close the menu, then open the standalone details view. Its own back
    // button already returns to the editor.
    const menu = document.getElementById("rsMoreMenu");
    if (menu) { menu.hidden = true; document.body.classList.remove("rs-menu-open"); }
    if (typeof openJobDetails === "function" && _selectedJobId) openJobDetails(_selectedJobId);
  });

  // "Full details" is only meaningful with a job selected — same rule as Run.
  const syncFull = () => {
    if (full) full.hidden = !seg || seg.hasAttribute("hidden");
  };
  if (seg) new MutationObserver(syncFull).observe(seg, { attributes: true, attributeFilter: ["hidden"] });
  syncFull();
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => setTimeout(_initRsHeaderActions, 70));
else setTimeout(_initRsHeaderActions, 70);

/* ══════════════════════════════════════════════════════════════════════════
   JOB LIST PANEL  —  standalone, opens like the "···" menu

   The old .rs-side rail is driven by two body classes and eight competing
   CSS blocks; tapping "Job list" toggled those classes and the result
   depended on which block won. This renders the same jobs into its own
   panel with the menu's styling, and touches none of that.

   It reads window._lastJobs, which loadJobs() already keeps current, so
   there is no second fetch and no second source of truth.
   ══════════════════════════════════════════════════════════════════════════ */
function _rsJobsPopRender() {
  const list = document.getElementById("rsJobsPopList");
  if (!list) return;
  const jobs = window._lastJobs || [];
  if (!jobs.length) {
    list.innerHTML = '<div class="rs-jp-empty">No jobs yet — create one below.</div>';
    return;
  }
  const esc = (t) => String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  list.innerHTML = jobs.map(j => {
    const st = String(j.status || "").toLowerCase();
    const cls = st === "running" ? "running" : (st === "crashed" ? "crashed" : "");
    const active = String(j.id) === String(_selectedJobId) ? " is-active" : "";
    return '<button type="button" class="rs-jp-item' + active + '" data-jid="' + esc(j.id) + '">' +
             '<span class="rs-jp-dot ' + cls + '"></span>' +
             '<span class="rs-jp-name">' + esc(j.name || "untitled") + "</span>" +
             '<span class="rs-jp-meta">' + esc(j.language || "") + "</span>" +
           "</button>";
  }).join("");
}

function rsJobsPopOpen() {
  const pop = document.getElementById("rsJobsPop");
  if (!pop) return;
  const menu = document.getElementById("rsMoreMenu");
  if (menu) menu.hidden = true;          // only one panel at a time
  _rsJobsPopRender();
  pop.hidden = false;
  document.body.classList.add("rs-menu-open");
}
function rsJobsPopClose() {
  const pop = document.getElementById("rsJobsPop");
  if (!pop) return;
  pop.hidden = true;
  const menu = document.getElementById("rsMoreMenu");
  if (!menu || menu.hidden) document.body.classList.remove("rs-menu-open");
}

function _initRsJobsPop() {
  const pop = document.getElementById("rsJobsPop");
  if (!pop || pop.dataset.wired === "1") return;
  pop.dataset.wired = "1";

  // The menu row opens this instead of toggling the legacy rail classes.
  const trigger = document.getElementById("btnJobsInMenu");
  if (trigger) {
    const fresh = trigger.cloneNode(true);   // drop the old rail handler
    trigger.parentNode.replaceChild(fresh, trigger);
    fresh.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const menu = document.getElementById("rsMoreMenu");
      if (menu) menu.hidden = true;
      rsJobsPopOpen();
    });
  }

  pop.addEventListener("click", (e) => {
    const row = e.target.closest(".rs-jp-item");
    if (row) {
      e.preventDefault(); e.stopPropagation();
      rsJobsPopClose();
      if (typeof selectJob === "function") selectJob(row.getAttribute("data-jid"));
      return;
    }
    if (e.target.closest("#rsJobsPopNew")) {
      e.preventDefault(); e.stopPropagation();
      rsJobsPopClose();
      const real = document.getElementById("btnNew");
      if (real) real.click();
    }
  });

  document.addEventListener("click", (e) => {
    if (pop.hidden) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest("#btnJobsInMenu, #rsMoreBtn")) return;
    rsJobsPopClose();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) { e.stopPropagation(); rsJobsPopClose(); }
  });

  const scrim = document.getElementById("rsMenuScrim");
  if (scrim) scrim.addEventListener("click", rsJobsPopClose);
}

/* Tapping the inspector sheet itself dismisses it, as asked. */
function _initRsInspDismiss() {
  const insp = document.getElementById("wbInspector") ||
               document.querySelector("#tab-jobs .rs-insp");
  if (!insp || insp.dataset.dismissWired === "1") return;
  insp.dataset.dismissWired = "1";
  insp.addEventListener("click", (e) => {
    // Only a tap on the sheet's own background closes it; controls inside
    // must keep working.
    if (e.target !== insp && !e.target.classList.contains("rs-insp-head")) return;
    document.body.classList.remove("rs-insp-open");
    insp.classList.remove("rs-insp-open");
  });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => setTimeout(() => {
    _initRsJobsPop(); _initRsInspDismiss();
  }, 80));
else setTimeout(() => { _initRsJobsPop(); _initRsInspDismiss(); }, 80);

/* ══════════════════════════════════════════════════════════════════════════
   REPO JOBS — show the cloned entry file in the editor

   A GitHub-imported job stores no inline code: the source arrives with the
   clone and lives in the runner's workspace. selectJob() fills the editor
   from the DB row, so for those jobs it filled it with "" and the editor
   looked empty even though the project was running fine.

   The file-browser endpoint added earlier already serves the workspace, so
   this asks it for the current entry file. Read-only intent: the user can
   still edit and redeploy, exactly as with a pasted job.
   ══════════════════════════════════════════════════════════════════════════ */
async function _rsPullRepoEntry(jobId) {
  if (!jobId) return;
  try {
    const listing = await api("/api/jobs/" + jobId + "/files", "GET", null, true);
    const entry = listing && listing.entry;
    if (!entry) return;
    const got = await api("/api/jobs/" + jobId + "/file?path=" +
                          encodeURIComponent(entry), "GET", null, true);
    if (!got || typeof got.content !== "string") return;
    // Do not clobber unsaved edits.
    const cur = (typeof _jobCmGetValue === "function" ? _jobCmGetValue() : "") || "";
    if (cur.trim()) return;
    _jobCmSetValue(got.content);
    const ext = (entry.split(".").pop() || "").toLowerCase();
    const map = { py: "python", js: "javascript", mjs: "javascript",
                  rb: "ruby", php: "php", sh: "bash" };
    if (map[ext]) _jobCmSetMode(map[ext]);
    if (typeof _setHint === "function") _setHint("", entry);
  } catch (e) {
    /* The job may not be running yet, or the runner may have restarted —
       neither is worth a toast on a background fill. */
  }
}

/* Hook it onto selectJob without editing that function: wrap it once. */
(function _wrapSelectJobForRepo() {
  if (typeof selectJob !== "function" || window.__repoEntryWrapped) return;
  window.__repoEntryWrapped = true;
  const orig = selectJob;
  window.selectJob = function (id) {
    const r = orig.apply(this, arguments);
    // After the normal fill, top up from the workspace when it left the
    // editor empty — which is exactly the repo-job case.
    setTimeout(() => {
      const cur = (typeof _jobCmGetValue === "function" ? _jobCmGetValue() : "") || "";
      if (!cur.trim()) _rsPullRepoEntry(id);
    }, 350);
    return r;
  };
  selectJob = window.selectJob;
})();
