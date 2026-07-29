/* CodeNest inside Telegram — the SAME app, not a second one.
 *
 * This file adds three things and touches nothing else:
 *   1. auto-login from Telegram's signed initData (no login screen, no tap)
 *   2. theme variables taken from the user's actual Telegram theme
 *   3. ready()/expand() so the webview opens at full height
 *
 * The RunSpace editor, job list, Details page and everything else are reused
 * exactly as they are. If this script decides it is NOT inside Telegram it
 * does nothing at all and the normal website flow runs untouched.
 */
(function () {
  "use strict";

  const TG = window.Telegram && window.Telegram.WebApp;

  /* Presence of the SDK object is not enough: telegram-web-app.js defines
   * window.Telegram.WebApp on ANY page that loads it, including a plain
   * browser tab, where initData is an empty string. Treating that as "inside
   * Telegram" would hide the login screen from a normal visitor and leave
   * them staring at nothing. */
  const inTelegram = !!(TG && typeof TG.initData === "string" && TG.initData.length > 0);
  window.__inTelegram = inTelegram;

  if (!inTelegram) {
    if (TG) {
      // The SDK loaded but there is no session — a browser preview of the
      // Mini App URL. Say nothing, let the website behave normally.
      try { TG.ready(); } catch (e) {}
    }
    return;
  }

  document.documentElement.classList.add("in-telegram");

  /* ---- 2. theme ------------------------------------------------------
   * Telegram hands over the colours of the user's OWN client theme. Mapping
   * them onto the existing CSS custom properties is what makes the app look
   * like part of Telegram instead of a website in a frame — and it is why
   * this is a theming change, not a redesign: the same variables the site
   * already uses just take different values. */
  function applyTheme() {
    const p = (TG.themeParams || {});
    const root = document.documentElement;
    const map = {
      bg_color: ["--bg", "--panel-0"],
      secondary_bg_color: ["--panel", "--panel-2"],
      text_color: ["--ink"],
      hint_color: ["--muted", "--ink-2"],
      link_color: ["--acc"],
      button_color: ["--acc"],
      destructive_text_color: ["--red"],
    };
    let applied = 0;
    Object.keys(map).forEach(function (key) {
      const val = p[key];
      if (!val || !/^#[0-9a-f]{3,8}$/i.test(val)) return;   // never inject raw
      map[key].forEach(function (cssVar) {
        root.style.setProperty(cssVar, val);
        applied += 1;
      });
    });
    // colorScheme is authoritative even when themeParams is sparse, and the
    // site already has a full dark palette keyed off this attribute.
    if (TG.colorScheme) root.setAttribute("data-theme", TG.colorScheme);
    return applied;
  }

  applyTheme();
  try { TG.onEvent("themeChanged", applyTheme); } catch (e) {}

  /* ---- 3. viewport --------------------------------------------------- */
  try { TG.ready(); } catch (e) {}
  try { TG.expand(); } catch (e) {}          // full height, not the small sheet
  try {
    if (TG.setHeaderColor && TG.themeParams && TG.themeParams.bg_color) {
      TG.setHeaderColor(TG.themeParams.bg_color);
    }
  } catch (e) {}

  /* Telegram's viewport is not the window: the keyboard and the drag-to-close
   * gesture change it. Editors sized with 100vh overflow their container. */
  function syncViewport() {
    const h = TG.viewportStableHeight || TG.viewportHeight;
    if (h) document.documentElement.style.setProperty("--tg-vh", h + "px");
  }
  syncViewport();
  try { TG.onEvent("viewportChanged", syncViewport); } catch (e) {}

  /* ---- 1. auto-login -------------------------------------------------
   * The functional core. Without it the Mini App is just the website in a
   * frame, and the user still has to sign in — which is the one thing a Mini
   * App is supposed to remove. */
  window.__tgAutoLogin = async function () {
    // An existing session wins: re-authenticating would spawn a second
    // session row on every open and log the device out elsewhere for nothing.
    if (localStorage.getItem("ahad_token")) return { ok: true, reused: true };
    let fp = "";
    try {
      fp = typeof ensureFingerprint === "function" ? await ensureFingerprint() : "";
    } catch (e) {}
    const res = await fetch(API + "/auth/telegram/miniapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: TG.initData, fingerprint: fp }),
    });
    if (!res.ok) {
      // Verification failed — a stale initData, or the bot token on the
      // server not matching the bot that opened this. Fall through to the
      // normal login screen rather than trapping the user on a blank page.
      let detail = "";
      try { detail = (await res.json()).detail || ""; } catch (e) {}
      return { ok: false, status: res.status, detail: detail };
    }
    const data = await res.json();
    localStorage.setItem("ahad_token", data.token);
    if (data.username) localStorage.setItem("ahad_user", data.username);
    if (typeof authToken !== "undefined") { try { authToken = data.token; } catch (e) {} }
    window.authToken = data.token;
    return { ok: true, created: !!data.created, username: data.username };
  };

  /* Inside Telegram the account IS the Telegram account. A sign-out button
   * would drop the session and then the very next open would silently sign
   * the same person back in — a control that visibly does nothing. Hidden by
   * CSS rather than removed, so nothing that queries for it breaks. */
  document.documentElement.classList.add("tg-hide-signout");
})();
