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
function showScreen(id) {
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
async function api(path, method = "POST", body = null, auth = false, _retried = false) {
  const headers = { "Content-Type": "application/json" };
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
    // Free-tier cold starts can 401 briefly while the Supabase pooler is
    // spinning up — a single 401 during a cold boot is NOT a real expired
    // session. Retry once after 800ms; only log out if the retry ALSO 401s.
    // Skip retry on auth endpoints themselves (login/logout) so a bad token
    // during sign-in surfaces immediately.
    const isSafe = path.indexOf("/api/jobs") === 0 ||
                   path.indexOf("/profile") === 0 ||
                   path.indexOf("/snippets") === 0 ||
                   path.indexOf("/stats") === 0;
    if (isSafe && !_retried) {
      await new Promise(r => setTimeout(r, 800));
      try { return await api(path, method, body, auth, true); }
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
    b.addEventListener("click", () => window.location.reload());
  }
  b.innerHTML = `${ic("refresh")}<span>Waking up your RunSpace... this can take up to a minute on the free tier. Please wait...</span>`;
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
   Fintech-style: subtle, fast, no glitter. CSS lives in classic.css. */
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
function _showTaken(el) {
  if (!el || el.classList.contains("taken")) return;
  const f = el.closest(".field");
  if (!f) return;
  const note = document.createElement("div");
  note.className = "field-taken";
  note.innerHTML = 'This email/username is already registered. <a onclick="showScreen(\'screen-forgot1\')">Reset password →</a>';
  f.appendChild(note);
  el.classList.add("taken");
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
      if ((field === "username" && r.username_taken) || (field === "email" && r.email_taken)) _showTaken(el);
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
      _showTaken(document.getElementById(av.username_taken ? "su_username" : "su_email"));
      toast("This email/username is already registered.", "error");
      return;
    }
  } catch (e) { /* check endpoint hiccup — /signup will decide anyway */ }

  // CAPTCHA — provider widget when configured, arithmetic box otherwise.
  // The math input existed in the markup but was never read, so the server
  // saw captcha=undefined and rejected EVERY signup.
  const captchaEl = document.getElementById("su_captcha");
  const captcha = captchaEl ? captchaEl.value.trim() : "";
  const captchaToken = _captchaToken();
  if (!captchaToken && captchaEl && !captcha) {
    toast("Please answer the CAPTCHA question", "error");
    captchaEl.focus();
    return;
  }

  // Collect strong device fingerprint for abuse prevention
  const fingerprint = await ensureFingerprint();
  btnBusy(btn);
  try {
    const res = await api("/signup", "POST", {
      username, email, password, agreed_terms: true,
      captcha, captcha_token: captchaToken,
      fingerprint: fingerprint
    });
    signupUsername = username;
    localStorage.setItem("ahad_signup_username", username);
    localStorage.setItem("ahad_signup_email", email);
    clearOtpBoxes("otpBoxesSignup");
    document.getElementById("otpEmailNote").textContent = `A 6-digit code was sent to ${email}. It's valid for 10 minutes — you can switch apps to check your mail safely.`;
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
      document.getElementById("otpEmailNote").textContent =
        "Your email isn't verified yet. Enter the 6-digit code, or resend a new one below.";
      logEvent("warning", "Verification required", `Please verify ${data.username}`);
      btnOk(btn, () => {
        showScreen("screen-otp");
        startResendTimer(10);
        startOtpExpiry(data.expires_in || 600, "otpExpire");
        toast("Please verify your email to continue.", "warning");
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
    toast(err.message, "error");
  }
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
  if (!ta || typeof CodeMirror === "undefined") return;
  if (cmEditor) return;
  cmEditor = CodeMirror.fromTextArea(ta, {
    lineNumbers: true,
    theme: "default",
    mode: "python",
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      "Ctrl-S": function(cm) { saveSnippet(); },
      "Cmd-S": function(cm) { saveSnippet(); },
      "Ctrl-Enter": function(cm) {
        const curLang = (document.getElementById("snippetLanguage").value || "").toLowerCase();
        if (_RUNNABLE_LANGS[curLang]) { runLivePreview(); } else { executeCode(); }
      },
      "Cmd-Enter": function(cm) {
        const curLang = (document.getElementById("snippetLanguage").value || "").toLowerCase();
        if (_RUNNABLE_LANGS[curLang]) { runLivePreview(); } else { executeCode(); }
      }
    }
  });
  cmEditor.on("change", (cm) => {
    ta.value = cm.getValue();
    updateEditorMeta();
    clearTimeout(_livePreviewTimer);
    const l = (document.getElementById("snippetLanguage").value || "").toLowerCase();
    if (_RUNNABLE_LANGS[l]) _livePreviewTimer = setTimeout(runLivePreview, 400);
  });
  updateCodeMirrorMode();
}

function updateCodeMirrorMode() {
  if (!cmEditor || typeof CodeMirror === "undefined") return;
  const lang = (document.getElementById("snippetLanguage").value || "text").toLowerCase();
  let mode = "text/plain";
  if (lang === "python" || lang === "python3") mode = "python";
  else if (lang === "javascript" || lang === "js") mode = "javascript";
  else if (lang === "html") mode = "htmlmixed";
  else if (lang === "css") mode = "css";
  else if (lang === "markdown" || lang === "md") mode = "markdown";
  else if (lang === "bash" || lang === "sh") mode = "shell";
  else if (lang === "c" || lang === "cpp" || lang === "c++") mode = "text/x-csrc";
  else if (lang === "java") mode = "text/x-java";
  else if (lang === "sql") mode = "sql";
  cmEditor.setOption("mode", mode);
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
  const val = cmEditor ? cmEditor.getValue() : (ta.value || "");
  const lines = val.split("\n").length;
  meta.textContent = lines + " lines · " + val.length + " chars";
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
function updateGutter() {
  const ta = document.getElementById("snippetContent");
  const gutter = document.getElementById("csGutter");
  if (!ta || !gutter) return;
  const lines = ta.value.split("\n").length;
  let nums = "";
  for (let i = 1; i <= lines; i++) nums += i + "\n";
  gutter.textContent = nums;
}

/* Sync gutter scroll with textarea scroll */
function initGutterScroll() {
  const ta = document.getElementById("snippetContent");
  const gutter = document.getElementById("csGutter");
  if (!ta || !gutter) return;
  ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
}

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
  try { applyTheme(localStorage.getItem("ahad_theme") || "light"); } catch (e) { applyTheme("light"); }
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
      '<p>The app hit an unexpected error while starting up. Reloading usually fixes it.</p>' +
      (message ? '<code>' + escapeHtml(String(message).slice(0, 200)) + '</code>' : '') +
      '<div class="fatal-btns"><button class="btn-primary" onclick="window.location.reload()">Reload</button>' +
      '<button class="btn-ghost" onclick="document.getElementById(\'fatalOverlay\').remove()">Keep trying</button></div>' +
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
    try { await api("/logout", "POST", null, true); } catch (e) {}
    logEvent("info", "Signed out", "Session ended");
    authToken = null;
    localStorage.removeItem("ahad_token");
    resetLocalActivity();   // next account on this device starts with a clean feed
    toast("Logged out", "success");
    showScreen("screen-landing");
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
  document.querySelectorAll(".dash-tabs .dash-tab").forEach(b => b.addEventListener("click", closeSideMenu));
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

/* Restore an in-progress verification screen from localStorage. */
function restoreOtpScreen() {
  const username = localStorage.getItem("ahad_signup_username") || "";
  const email = localStorage.getItem("ahad_signup_email") || "your email";
  signupUsername = username;
  clearOtpBoxes("otpBoxesSignup");
  document.getElementById("otpEmailNote").textContent =
    "Welcome back, " + username + "! Enter your 6-digit code to finish verifying. (Sent to " + email + ".)";
  showScreen("screen-otp");
  startResendTimer(10);
  logEvent("info", "Verification resumed", "Restored pending verification for " + username);
  toast("Pick up where you left off — enter your code.", "info");
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
  if (!ta || typeof CodeMirror === "undefined") return;
  if (_jobCm) return;
  try {
    _jobCm = CodeMirror.fromTextArea(ta, {
      lineNumbers: true,
      theme: "default",
      mode: "python",
      lineWrapping: false,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      autoCloseBrackets: true,
      matchBrackets: true,
      styleActiveLine: true,
      extraKeys: {
        "Ctrl-S": function(cm) { startJob(); },
        "Cmd-S":  function(cm) { startJob(); },
        "Ctrl-Enter": function(cm) { startJob(); },
        "Cmd-Enter":  function(cm) { startJob(); },
        "Tab": function(cm) {
          if (cm.somethingSelected()) cm.indentSelection("add");
          else cm.replaceSelection("  ", "end");
        },
        "Shift-Tab": function(cm) {
          if (cm.somethingSelected()) cm.indentSelection("subtract");
          else cm.execCommand("indentLess");
        },
        "Ctrl-/": function(cm) { cm.toggleComment && cm.toggleComment(); },
        "Cmd-/":  function(cm) { cm.toggleComment && cm.toggleComment(); },
      }
    });
    _jobCm.on("change", (cm) => {
      ta.value = cm.getValue();
      _updateStats();
      _jobDirty = true;
      _reflectJobStatus(_selectedJobId); // swap Run/Details based on dirty state
    });
    _jobCmSetMode("python");
  } catch (e) { console.error("initJobCodeMirror:", e); }
}

function _jobCmSetMode(lang) {
  if (!_jobCm || typeof CodeMirror === "undefined") return;
  const m = _jobCmModeForLang(lang);
  _jobCm.setOption("mode", m);
  const el = document.getElementById("cmMode");
  if (el) el.textContent = lang || "python";
}

function _jobCmSetValue(code) {
  const ta = document.getElementById("jobCode");
  if (!ta) return;
  const v = code || "";
  ta.value = v;
  if (_jobCm) _jobCm.setValue(v);
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
    ws.style.display = "none";
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
  if (!hasPrior) _setJobsStatus("loading"); else _jobsStatus = "loading";

  try {
    const data = await api("/api/jobs", "GET", null, true);
    const jobs = (data && data.jobs) || [];
    const sig = jobs.map(j => [j.id, j.status, j.restarts, j.web ? 1 : 0, j.web_public === false ? 0 : 1].join(":")).join("|");
    _lastJobsTs = Date.now();
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

function _renderLogs(text) {
  const body = document.getElementById("jobLogBody");
  const dot = document.getElementById("jobLogTitle");
  if (!body) return;
  if (!text || !text.trim()) {
    body.innerHTML = '<span class="rs-log-empty">// Logs will appear here when you run the job.</span>';
    if (dot) { dot.className = "rs-log-dot"; dot.title = "idle"; }
    _reflectJobStatus(_selectedJobId);
    return;
  }
  const lines = text.split(/\r?\n/);
  const tail = lines.slice(-600);
  body.innerHTML = tail.map(_colorizeLine).join("\n");
  if (_logFollow) body.scrollTop = body.scrollHeight;
  if (dot) { dot.className = "rs-log-dot running"; dot.title = "streaming"; }
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

function _updateStats() {
  const el = document.getElementById("codeStats");
  const v = _jobCmGetValue();
  const lines = v ? v.split("\n").length : 0;
  const chars = v ? v.length : 0;
  if (el) el.textContent = lines + " lines · " + chars + " chars";
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
  if (btnRun) {
    btnRun.style.display = detailsPrimary ? "none" : "";
    // Visual "dirty" marker when code has been edited since last Run
    btnRun.classList.toggle("dirty", !!_jobDirty && !!isSelected);
    const lbl = btnRun.querySelector(".rs-btn-label");
    if (lbl && !btnRun.classList.contains("loading")) {
      lbl.textContent = _jobDirty ? "Save & run" : "Run";
    }
  }
  if (btnDet)  btnDet.style.display  = isSelected ? "" : "none";
  if (btnStop) btnStop.style.display = isLive ? "" : "none";
  if (btnRest) btnRest.style.display = isLive ? "" : "none";

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
    document.body.classList.remove("rs-side-open");
    const tab = document.getElementById("tab-jobs");
    if (tab) tab.classList.remove("side-open");
    return;
  }
  _selectedJobId = id;
  // 👉 Paint sidebar selection + swap to workspace IMMEDIATELY (don't wait for
  // fetch/SSE to round-trip — that's what makes tab switches feel laggy).
  // Data fills in behind the paint with a subtle fade.
  document.querySelectorAll("#jobsList .job-item").forEach(el => {
    el.classList.toggle("active", el.dataset.jid === _selectedJobId);
  });
  const btn = document.getElementById("btnStartJob");
  if (btn) btn.dataset.editingId = _selectedJobId;
  // Kick off data + log stream but DON'T await them. Instant visual response.
  fetchJobDetail(id);
  restartLogStream(id);
  requestAnimationFrame(() => { try { _jobCmRefresh(); } catch(e){} });
  // Update URL once job detail loads (we need the name)
  setTimeout(() => { const j = (window._lastJobs||[]).find(x => String(x.id) === _selectedJobId); if (j) _updateJobUrl(j); }, 120);
  document.body.classList.remove("rs-side-open");
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

async function fetchJobDetail(id) {
  try {
    const token = localStorage.getItem("ahad_token") || "";
    const r = await fetch("/api/jobs/" + id, {
      headers: token ? {"Authorization": "Bearer " + token} : {}
    });
    if (!r.ok) { _showEmpty(false); return; }
    const job = await r.json();
    window._lastJobs = window._lastJobs || [];
    const idx = window._lastJobs.findIndex(x => String(x.id) === String(id));
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
    if (curCode !== (job.code || "")) _jobCmSetValue(job.code || "");
    _jobDirty = false;
    _updateStats();
    _showWorkspace(job, true);   // animate: this is a job→job switch (§4)
    _reflectJobStatus(job);
    _setHint("ok", "");
    // If the detail drawer is open, re-render it with the new job's data so
    // clicking a different job in the sidebar swaps the drawer content too.
    if (_jdOpen) { renderJobDetails(); }
  } catch (e) { _showEmpty(false); }
}

function stopLogStream() {
  if (_logSSE) {
    try { _logSSE.close(); } catch (e) {}
    _logSSE = null;
  }
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
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        _renderLogs(d.logs || "");
        window._lastJobs = window._lastJobs || [];
        const job = window._lastJobs.find(x => String(x.id) === String(id));
        if (job) { job.status = d.status; _reflectJobStatus(job); }
        // Mirror logs + refresh details panel if open
        if (_jdOpen && String(_selectedJobId) === String(id)) renderJobDetails();
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
    };
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
  else if (Date.now() < _suppressAutoSelect) {
    // New was just clicked — do NOT auto-select; keep blank editor.
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
    if (cur) { _showWorkspace(cur); _updateJobUrl(cur); }
  }
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
  // Escape closes drawer / download menu
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      const wrap = document.getElementById("jdDlWrap");
      if (wrap && wrap.classList.contains("open")) { wrap.classList.remove("open"); return; }
      if (document.body.classList.contains("rs-detail-open")) closeJobDetails();
    }
  });
  if (deselectBtn) {
    deselectBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); deselectJob(); });
    deselectBtn.type = "button";
  }
  if (menuBtn && backdrop) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation(); e.preventDefault();
      document.body.classList.toggle("rs-side-open");
    });
    backdrop.addEventListener("click", () => {
      document.body.classList.remove("rs-side-open");
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
let _jdTimeline = [];
let _jdLogFollow = true;
function openJobDetails(id, opts) {
  if (id) selectJob(id);
  document.body.classList.add("rs-detail-open");
  _jdOpen = true;
  renderJobDetails();
  _playSwap(document.getElementById("jobDetailPanel"));
  // §5: the Details page has its own URL so it can be linked/refreshed.
  if (!(opts && opts.noUrl)) {
    const job = (window._lastJobs || []).find(x => String(x.id) === String(_selectedJobId));
    if (job) _updateJobUrl(job, {details: true, push: true});
  }
  _startHealthCheck();
  // Lock background scroll on mobile (prevents double-scroll)
  document.body.classList.add("rs-drawer-open");
  // Reset drawer scroll to top so cards start at URL/Logs
  const db = document.querySelector("#tab-jobs .rs-detail-body");
  if (db) db.scrollTop = 0;
  _jdLogFollow = true;
}
function closeJobDetails(opts) {
  document.body.classList.remove("rs-detail-open");
  document.body.classList.remove("rs-drawer-open");
  _jdOpen = false;
  if (_jdHealthTimer) { clearInterval(_jdHealthTimer); _jdHealthTimer = null; }
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
function renderJobDetails() {
  const job = (window._lastJobs||[]).find(x => String(x.id) === String(_selectedJobId));
  if (!job) { closeJobDetails(); return; }
  _jdSet("jdName", job.name || "untitled");
  const l = document.getElementById("jdLang"); if (l) l.textContent = _langIcon(job.language);
  const badge = document.getElementById("jdBadge");
  const stKey = (job.status||"").toLowerCase();
  if (badge) {
    badge.className = "rs-badge " + (stKey==="running"?"running":stKey==="crashed"||stKey==="install_failed"?"crashed":stKey==="starting"||stKey==="installing"?"starting":"");
    badge.textContent = _fmtStatus(job.status).label;
  }
  _jdSet("jdUptime", "up " + _fmtUptime(job.uptime_s||0));
  _jdSet("jdRestarts", (job.restarts||0) + " restart" + (job.restarts===1?"":"s"));
  // Mirror logs to drawer (auto-follow like main pane)
  const src = document.getElementById("jobLogBody");
  const dst = document.getElementById("jdLogBody");
  if (src && dst) {
    const wasBottom = dst.scrollTop + dst.clientHeight >= dst.scrollHeight - 24;
    dst.innerHTML = src.innerHTML;
    if (wasBottom || _jdLogFollow !== false) dst.scrollTop = dst.scrollHeight;
  }
  // URL card
  const card = document.getElementById("jdUrlCard");
  if (card) {
    const isRunning = stKey === "running";
    const url = job.web_url || job.url;
    if (isRunning && url) {
      card.style.display = "";
      const a = document.getElementById("jdUrl"); if (a) { a.href = url; a.textContent = url; }
      const o = document.getElementById("jdUrlOpen"); if (o) o.href = url;
    } else {
      card.style.display = "none";
    }
  }
  // Resources (best-effort; runner returns what it has)
  _jdSet("jdPid", job.pid || job.runner_job_id || "—");
  _jdSet("jdPort", job.port || "—");
  _jdSet("jdCpu", job.cpu_pct != null ? (job.cpu_pct.toFixed?.(1) ?? job.cpu_pct) + "%" : "—");
  _jdSet("jdMem", job.mem_mb != null ? (Math.round(job.mem_mb)) + " MB" : "—");
  // Timeline
  const tl = document.getElementById("jdTimeline");
  if (tl) {
    if (!job._tl) job._tl = [];
    // Append events on status changes
    const last = job._tl[job._tl.length-1];
    const evLabel = _fmtStatus(job.status).label;
    if (!last || last.ev !== evLabel) {
      job._tl.push({t: new Date(), ev: evLabel, cls: stKey==="running"?"ok":stKey==="crashed"||stKey==="install_failed"?"err":stKey==="starting"||stKey==="installing"?"warn":""});
      if (job._tl.length > 30) job._tl.shift();
    }
    if (!job._tl.length) {
      tl.innerHTML = '<li class="rs-empty-sm">Events will appear here.</li>';
    } else {
      tl.innerHTML = job._tl.slice().reverse().map(e => {
        const t = e.t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        return '<li><span class="rs-ts">'+t+'</span><span class="rs-te '+e.cls+'">'+e.ev+'</span></li>';
      }).join("");
    }
  }
}
function _startHealthCheck() {
  if (_jdHealthTimer) clearInterval(_jdHealthTimer);
  const tick = async () => {
    if (!_jdOpen) return;
    const job = (window._lastJobs||[]).find(x => String(x.id) === String(_selectedJobId));
    const h = document.getElementById("jdHealth");
    const sub = document.getElementById("jdHealthSub");
    const url = job && (job.web_url || job.url);
    if (!h || !sub || !url) return;
    h.className = "rs-health";
    h.querySelector(".rs-h-tx").textContent = "checking…";
    const t0 = performance.now();
    try {
      const r = await fetch(url, {method:"GET", mode:"no-cors", cache:"no-store"});
      const dt = Math.round(performance.now()-t0);
      h.className = "rs-health ok";
      h.querySelector(".rs-h-tx").textContent = "live ("+dt+"ms)";
      sub.textContent = "Last checked: " + new Date().toLocaleTimeString();
    } catch(e) {
      h.className = "rs-health bad";
      h.querySelector(".rs-h-tx").textContent = "unreachable";
      sub.textContent = "Last checked: " + new Date().toLocaleTimeString();
    }
  };
  tick();
  _jdHealthTimer = setInterval(tick, 15000);
}
function _initDetailWiring() {
  if (document.getElementById("btnJobDetails") && document.getElementById("btnJobDetails")._w) return;
  const det = document.getElementById("btnJobDetails");
  if (det) { det._w=1; det.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openJobDetails(); }); }
  const bk = document.getElementById("jobDetailBack");
  if (bk) bk.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); closeJobDetails(); });
  const stop = document.getElementById("jdStop");
  if (stop) stop.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (_selectedJobId) stopJobById(_selectedJobId); });
  const rst = document.getElementById("jdRestart");
  if (rst) rst.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (_selectedJobId) restartJobById(_selectedJobId); });
  const del = document.getElementById("jdDelete");
  if (del) del.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    if (!_selectedJobId) return;
    if (!confirm("Delete this job? This cannot be undone.")) return;
    deleteJobById(_selectedJobId, del); closeJobDetails();
  });
  const edit = document.getElementById("jdEditCode");
  if (edit) edit.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); closeJobDetails(); _jobCmFocus(); });
  const cp = document.getElementById("jdCopy");
  if (cp) cp.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const b = document.getElementById("jdLogBody"); const t = b?b.textContent:"";
    if (!navigator.clipboard) { toast("Clipboard not available","error"); return; }
    if (!t) { toast("Nothing to copy","error"); return; }
    navigator.clipboard.writeText(t).then(()=>{
      cp.classList.add("is-ok");
      toast("Logs copied ✓","success");
      setTimeout(()=>cp.classList.remove("is-ok"),1200);
    }).catch(()=>toast("Copy failed","error"));
  });
  const cl = document.getElementById("jdClear");
  if (cl) cl.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const b = document.getElementById("jdLogBody"); if (b) b.innerHTML = '<span class="rs-log-empty">// Logs cleared.</span>';
    const b2 = document.getElementById("jobLogBody"); if (b2) b2.innerHTML = '<span class="rs-log-empty">// Logs cleared.</span>';
    toast("Logs cleared","info");
  });
  // Drawer logs auto-follow (mirror _logFollow for main pane)
  const jdBody = document.getElementById("jdLogBody");
  if (jdBody && !jdBody._w) {
    jdBody._w = 1;
    _jdLogFollow = true;
    jdBody.addEventListener("scroll", () => {
      _jdLogFollow = jdBody.scrollTop + jdBody.clientHeight >= jdBody.scrollHeight - 24;
    }, {passive:true});
  }
  // Download split-button (Download ▾ → Source / Logs / Database)
  const dlWrap = document.getElementById("jdDlWrap");
  const dlMenu = document.getElementById("jdDlMenu");
  const dlMain = document.getElementById("jdDl");
  const dlCaret = document.getElementById("jdDlCaret");
  const _closeDl = () => { if (dlWrap) dlWrap.classList.remove("open"); };
  if (dlCaret) dlCaret.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    if (!dlWrap) return;
    dlWrap.classList.toggle("open");
  });
  if (dlMain) dlMain.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    // Default: source code (most common action). Opens menu on first click if empty.
    _dlSource();
  });
  document.addEventListener("click", (e) => {
    if (dlWrap && !dlWrap.contains(e.target)) _closeDl();
  });
  // Close dropdown on scroll inside the drawer to avoid it floating over cards
  const _dbody = document.querySelector("#tab-jobs .rs-detail-body");
  if (_dbody) _dbody.addEventListener("scroll", _closeDl, {passive:true});
  if (dlMenu) dlMenu.querySelectorAll(".rs-dl-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      _closeDl();
      const t = item.dataset.type;
      if (t === "source") _dlSource();
      else if (t === "logs") _dlLogs();
      else if (t === "db") _dlDb();
    });
  });

  function _dlSource() {
    const job = (window._lastJobs||[]).find(x => String(x.id) === String(_selectedJobId));
    const name = (document.getElementById("jobName")||{}).value || (job&&job.name) || "job";
    const lang = (document.getElementById("jobLang")||{}).value || (job&&job.language) || "py";
    const ext = {python:"py",javascript:"js",js:"js",bash:"sh",shell:"sh",sh:"sh",
                 ruby:"rb",rb:"rb",php:"php",go:"go",rust:"rs",lua:"lua",
                 perl:"pl",java:"java",typescript:"ts"}[lang.toLowerCase()] || "txt";
    const code = _jobCmGetValue() || (job&&job.code) || "";
    const blob = new Blob([code], {type:"text/x-python;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    let fname = (name||"source").replace(/[^\w.\-]+/g,"_");
    if (fname.indexOf(".") === -1) fname += "." + ext;
    a.download = fname; document.body.appendChild(a); a.click();
    setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},200);
    toast("Downloaded "+fname,"success");
  }
  function _dlLogs() {
    const body = document.getElementById("jobLogBody");
    const name = (document.getElementById("jobName")||{}).value || "job";
    const text = body ? body.textContent : "";
    if (!text || /logs will appear/i.test(text)) { toast("Logs are empty","error"); return; }
    const blob = new Blob([text],{type:"text/plain;charset=utf-8"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
    a.download = (name||"job").replace(/[^\w.\-]+/g,"_") + "-" + new Date().toISOString().slice(0,10) + ".log";
    document.body.appendChild(a); a.click();
    setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},200);
    toast("Logs downloaded","success");
  }
  async function _dlDb() {
    if (!_selectedJobId) { toast("Select a job first","error"); return; }
    toast("Looking for database file…","info");
    try {
      const r = await api(`/api/jobs/${_selectedJobId}/files`, "GET", null, true);
      const files = r.files || [];
      if (!files.length) { toast("No database/data files found (job may not be running yet).","error"); return; }
      const db = files.find(f => /\.(db|sqlite|sqlite3)$/i.test(f.path));
      const json = files.find(f => /\.(json)$/i.test(f.path));
      const pick = db || json || files[0];
      const token = localStorage.getItem("ahad_token") || "";
      const hr = await fetch(`/api/jobs/${_selectedJobId}/files/`+encodeURI(pick.path), {headers: token?{"Authorization":"Bearer "+token}:{}});
      if (!hr.ok) throw new Error("Download failed ("+hr.status+")");
      const blob = await hr.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = pick.path.split("/").pop() || "database.db";
      document.body.appendChild(a); a.click();
      setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},300);
      toast("Downloaded "+a.download,"success");
    } catch (err) { toast(err.message || "Download failed","error"); }
  }
  const uc = document.getElementById("jdUrlCopy");
  if (uc) uc.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const a = document.getElementById("jdUrl"); if (!a || !a.href) return;
    const u = a.href;
    if (navigator.clipboard) navigator.clipboard.writeText(u).then(()=>toast("Link copied","success"));
  });
  const add = document.getElementById("jdEnvAdd");
  if (add) add.addEventListener("click", e => {
    e.preventDefault(); e.stopPropagation();
    const list = document.getElementById("jdEnvList");
    const row = document.createElement("div"); row.className = "rs-env-row";
    row.innerHTML = '<input class="rs-env-k" placeholder="KEY" spellcheck="false"><input class="rs-env-v" placeholder="value" spellcheck="false"><button class="rs-icon-btn rs-tb" title="Remove"><svg viewBox="0 0 24" class="rs-ic-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
    list.appendChild(row);
    if (list.querySelector(".rs-empty-sm")) list.querySelector(".rs-empty-sm").remove();
    row.querySelector("button").addEventListener("click", ()=>row.remove());
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

let _adminSectHtml = null;   // pristine copy so the panel can come BACK on
                             // this device when an actual admin signs in next
function applyAdminVisibility(profile) {
  const isAdm = !!(profile && profile.is_admin);
  const btn = document.getElementById("tabBtnAdmin");
  if (btn) btn.classList.toggle("hidden", !isAdm);
  let sect = document.getElementById("tab-admin");

  if (isAdm) {
    if (!sect && _adminSectHtml) {
      const host = document.querySelector(".dash-main");
      if (host) host.insertAdjacentHTML("beforeend", _adminSectHtml);
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

async function loadAdminPanel(force) {
  const stats = document.getElementById("admStats");
  if (!stats) return;
  if (force) delete stats.dataset.loaded;
  if (stats.dataset.loaded !== "1") {
    stats.innerHTML = '<div class="adm-stat"><b>…</b><span>loading</span></div>';
  }
  try {
    const [ov, usersR, jobsR, reportsR, auditR] = await Promise.all([
      api("/admin/overview", "GET", null, true),
      api("/admin/users", "GET", null, true),
      api("/admin/jobs", "GET", null, true),
      api("/admin/abuse-reports", "GET", null, true),
      api("/admin/audit-log", "GET", null, true),
    ]);
    renderAdminStats(ov || {});
    renderAdminSpark(ov || {});
    renderAdminJobs((jobsR && jobsR.jobs) || []);
    renderAdminUsers((usersR && usersR.users) || []);
    renderAdminReports((reportsR && reportsR.reports) || []);
    renderAdminAudit((auditR && auditR.audit) || []);
    stats.dataset.loaded = "1";
  } catch (e) {
    // 404 for non-admins — stay quiet and ambiguous, just like the server.
    stats.innerHTML = '<div class="adm-empty">Nothing here.</div>';
  }
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
    chip("capacity used", `${ov.jobs_deployed ?? 0}/${ov.capacity_max ?? 0}`);
  const cap = document.getElementById("admCap");
  if (cap) cap.textContent =
    `capacity: ${ov.jobs_deployed ?? 0} of ${ov.capacity_max ?? 0} slots used (max ${ov.jobs_max_per_user ?? 3}/user)` +
    (ov.runner_capacity != null ? ` · runner: ${ov.runner_running ?? 0}/${ov.runner_capacity} busy` : "");
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

function renderAdminJobs(jobs) {
  const el = document.getElementById("admJobs");
  if (!el) return;
  if (!jobs.length) { el.innerHTML = '<tr><td class="adm-empty">No RunSpace apps yet.</td></tr>'; return; }
  el.innerHTML = '<tr><th>App</th><th>Owner</th><th>Lang</th><th>Status</th><th>Uptime</th><th>Created</th></tr>' +
    jobs.map(j => {
      const st = (j.live_status || (j.runner_job_id ? "offline" : "stopped")).toLowerCase();
      const live = st === "running";
      return `<tr><td><b>${escapeHtml(j.name)}</b></td>` +
      `<td>${escapeHtml(j.owner)}${j.owner_suspended ? ' <span class="adm-pill warn">suspended</span>' : ""}</td>` +
      `<td>${escapeHtml(j.language)}</td>` +
      `<td><span class="adm-pill${live ? " ok" : ""}">${escapeHtml(st)}</span></td>` +
      `<td>${j.uptime_s ? _fmtUptime(j.uptime_s) : "—"}</td>` +
      `<td>${escapeHtml((j.created_at || "").slice(0, 10))}</td></tr>`;
    }).join("");
}

function renderAdminUsers(users) {
  const el = document.getElementById("admUsers");
  if (!el) return;
  if (!users.length) { el.innerHTML = '<tr><td class="adm-empty">No users yet.</td></tr>'; return; }
  const meId = _lastProfile && _lastProfile.id;
  el.innerHTML = '<tr><th>User</th><th>Joined</th><th>Apps</th><th>Status</th><th></th></tr>' +
    users.map(u => {
      const isMe = meId && u.id === meId;
      const state = u.is_suspended
        ? '<span class="adm-pill warn">suspended</span>'
        : (u.is_verified ? '<span class="adm-pill ok">active</span>' : '<span class="adm-pill">unverified</span>');
      const act = isMe
        ? '<span class="adm-hint">you</span>'
        : `<button class="adm-act${u.is_suspended ? " ok" : ""}" onclick="askSuspend(${u.id}, ${u.is_suspended ? 0 : 1}, this)">${u.is_suspended ? "Reactivate" : "Suspend"}</button>`;
      return `<tr><td><b>${escapeHtml(u.username)}</b><small>${escapeHtml(u.email)}</small></td>` +
        `<td>${escapeHtml((u.created_at || "").slice(0, 10))}</td>` +
        `<td>${u.job_count}</td><td>${state}</td><td>${act}</td></tr>`;
    }).join("");
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
      show("emailAuthSignin", !tgOnly);
      show("emailAuthSignup", !tgOnly);
    } else {
      // No bot configured: hide Telegram, reveal e-mail so users can still log in.
      show("telegramLogin", false);
      show("telegramSignup", false);
      show("telegramUnavailable", tgOnly);
      show("emailAuthSignin", true);
      show("emailAuthSignup", true);
    }
  }
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(mount, 60);
  else document.addEventListener("DOMContentLoaded", function () { setTimeout(mount, 60); });
})();


/* ============================================================
   CAPTCHA PROVIDER (Cloudflare Turnstile / hCaptcha)
   Which provider — if any — is active comes from /api/public-config.
   With no provider configured the arithmetic question in the markup
   stays visible and is validated server-side instead.
   ============================================================ */
let _captchaProvider = "none";
let _captchaWidgetId = null;

function _captchaToken() {
  if (_captchaProvider === "turnstile" && window.turnstile) {
    try { return window.turnstile.getResponse(_captchaWidgetId) || ""; } catch (e) { return ""; }
  }
  if (_captchaProvider === "hcaptcha" && window.hcaptcha) {
    try { return window.hcaptcha.getResponse(_captchaWidgetId) || ""; } catch (e) { return ""; }
  }
  return "";
}

function _captchaReset() {
  try {
    if (_captchaProvider === "turnstile" && window.turnstile) window.turnstile.reset(_captchaWidgetId);
    if (_captchaProvider === "hcaptcha" && window.hcaptcha) window.hcaptcha.reset(_captchaWidgetId);
  } catch (e) {}
}

(function initCaptcha() {
  async function mount() {
    let cfg = {};
    try {
      const r = await fetch("/api/public-config");
      if (r.ok) cfg = await r.json();
    } catch (e) { return; }
    _captchaProvider = cfg.captcha_provider || "none";
    const key = cfg.captcha_site_key || "";
    if (_captchaProvider === "none" || !key) return;   // keep the math fallback

    const box = document.querySelector(".captcha-box");
    if (!box) return;
    box.innerHTML = '<div id="captchaWidget"></div>';   // replace the math input

    const src = _captchaProvider === "turnstile"
      ? "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
      : "https://js.hcaptcha.com/1/api.js?render=explicit";
    const s = document.createElement("script");
    s.src = src; s.async = true; s.defer = true;
    s.onload = function () {
      const api = _captchaProvider === "turnstile" ? window.turnstile : window.hcaptcha;
      if (!api) return;
      try { _captchaWidgetId = api.render("#captchaWidget", { sitekey: key }); } catch (e) {}
    };
    document.head.appendChild(s);
  }
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(mount, 80);
  else document.addEventListener("DOMContentLoaded", function () { setTimeout(mount, 80); });
})();

// Warm the fingerprint cache at boot so the first job-create request already
// carries X-Fingerprint (the device limit is useless if the header is absent).
(function warmFingerprint() {
  const go = function () { ensureFingerprint(); };
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(go, 300);
  else document.addEventListener("DOMContentLoaded", function () { setTimeout(go, 300); });
})();
