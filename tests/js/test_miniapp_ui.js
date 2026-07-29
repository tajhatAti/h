/* CodeNest inside Telegram — the SAME app, adapted, not a second build.
 *
 * The trap this guards against: telegram-web-app.js defines
 * window.Telegram.WebApp on ANY page that loads it, including a plain browser
 * tab, where initData is an empty string. Treating mere presence as "inside
 * Telegram" would hide the login screen from ordinary visitors and leave them
 * on a blank page. Detection has to be initData, not the SDK object.
 *
 * Also checked: theme values are validated before being written into CSS
 * custom properties (they arrive from the client and land in a stylesheet),
 * an existing session is reused rather than re-authenticated, and a failed
 * verification falls back to the normal login rather than trapping the user.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../');
const SRC = fs.readFileSync(path.join(ROOT, 'static/miniapp.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'static/classic.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRO = fs.readFileSync(path.join(ROOT, 'static/pro.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${e ? ' -> ' + e : ''}`)); };

/* Boot a page with a fake Telegram SDK and run the real miniapp.js in it. */
function boot({ initData, themeParams, colorScheme, fetchImpl, token }) {
  // runScripts: w.eval() runs in Node's scope, where `window` is undefined —
  // the module would throw before doing anything. Injecting a <script> makes
  // it execute inside the page, which is where it actually lives.
  const dom = new JSDOM('<!doctype html><html><body><button id="btnLogout">Out</button></body></html>',
                        { pretendToBeVisual: true, runScripts: 'dangerously',
                          url: 'https://ahadorg.onrender.com/' });
  const w = dom.window;
  const events = {};
  const calls = [];
  w.Telegram = initData === undefined ? undefined : {
    WebApp: {
      initData,
      themeParams: themeParams || {},
      colorScheme: colorScheme || 'dark',
      viewportStableHeight: 640,
      ready: () => calls.push('ready'),
      expand: () => calls.push('expand'),
      setHeaderColor: (c) => calls.push('header:' + c),
      onEvent: (name, fn) => { events[name] = fn; },
    },
  };
  w.API = '';
  w.localStorage.clear();
  if (token) w.localStorage.setItem('ahad_token', token);
  w.fetch = fetchImpl || (() => Promise.reject(new Error('no fetch')));
  const tag = w.document.createElement('script');
  tag.textContent = SRC;
  w.document.body.appendChild(tag);
  return { dom, w, events, calls, d: w.document };
}

const GOOD_INIT = 'user=%7B%22id%22%3A555%7D&auth_date=1700000000&hash=abc';

// ── 1. detection ────────────────────────────────────────────────────────
console.log('\n[1] being inside Telegram is decided by initData, not by the SDK');
const noSdk = boot({ initData: undefined });
ok('no SDK at all → not in Telegram', noSdk.w.__inTelegram === false);
ok('and the html class is not set',
   !noSdk.d.documentElement.classList.contains('in-telegram'));

// This is the case that breaks real users: the SDK loads in a normal tab.
const browserTab = boot({ initData: '' });
ok('SDK present but initData empty → NOT in Telegram',
   browserTab.w.__inTelegram === false);
ok('no auto-login is even defined there',
   typeof browserTab.w.__tgAutoLogin !== 'function');
ok('the page is not restyled for a browser visitor',
   !browserTab.d.documentElement.classList.contains('in-telegram'));
ok('but ready() is still called so the SDK is not left hanging',
   browserTab.calls.includes('ready'));

const inTg = boot({ initData: GOOD_INIT });
ok('real initData → in Telegram', inTg.w.__inTelegram === true);
ok('the html class is set so CSS can adapt',
   inTg.d.documentElement.classList.contains('in-telegram'));

// ── 2. viewport ─────────────────────────────────────────────────────────
console.log('[2] the webview is opened at full height');
ok('ready() is called', inTg.calls.includes('ready'));
ok('expand() is called, or it opens as a small sheet',
   inTg.calls.includes('expand'));
ok('the stable height is exposed to CSS',
   inTg.d.documentElement.style.getPropertyValue('--tg-vh') === '640px',
   inTg.d.documentElement.style.getPropertyValue('--tg-vh'));
ok('and it tracks viewportChanged, since the keyboard resizes it',
   typeof inTg.events.viewportChanged === 'function');
inTg.w.Telegram.WebApp.viewportStableHeight = 400;
inTg.events.viewportChanged();
ok('a resize updates the variable',
   inTg.d.documentElement.style.getPropertyValue('--tg-vh') === '400px');

// ── 3. theme ────────────────────────────────────────────────────────────
console.log('[3] the app takes the user\'s own Telegram theme');
const themed = boot({
  initData: GOOD_INIT,
  colorScheme: 'light',
  themeParams: { bg_color: '#ffffff', text_color: '#111111',
                 button_color: '#0088cc', hint_color: '#999999' },
});
const st = themed.d.documentElement.style;
ok('background is applied', st.getPropertyValue('--bg') === '#ffffff');
ok('text colour is applied', st.getPropertyValue('--ink') === '#111111');
ok('the accent follows Telegram\'s button colour',
   st.getPropertyValue('--acc') === '#0088cc');
ok('the light/dark scheme is honoured',
   themed.d.documentElement.getAttribute('data-theme') === 'light');
ok('and a theme change is re-applied, not read once',
   typeof themed.events.themeChanged === 'function');

// themeParams come from the client and are written into a stylesheet. A value
// like "red;} body{display:none" must never reach setProperty.
const hostile = boot({
  initData: GOOD_INIT,
  themeParams: { bg_color: 'red;}body{display:none}', text_color: 'javascript:x',
                 button_color: '#00ff00' },
});
const hs = hostile.d.documentElement.style;
ok('a non-hex theme value is refused', hs.getPropertyValue('--bg') === '');
ok('so is a javascript: value', hs.getPropertyValue('--ink') === '');
ok('while a legitimate hex still applies',
   hs.getPropertyValue('--acc') === '#00ff00');
ok('the guard is a hex pattern, not a blocklist',
   /\/\^#\[0-9a-f\]\{3,8\}\$\/i/.test(SRC));

// ── 4. auto-login ───────────────────────────────────────────────────────
console.log('[4] auto-login: zero taps');
let posted = null;
const okFetch = (url, opts) => {
  posted = { url, body: JSON.parse(opts.body) };
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ token: 'tok123', username: 'tg_555', created: true }),
  });
};
(async () => {
  const a = boot({ initData: GOOD_INIT, fetchImpl: okFetch });
  const res = await a.w.__tgAutoLogin();
  ok('it posts to the Mini App route, not the widget one',
     posted.url.endsWith('/auth/telegram/miniapp'), posted.url);
  ok('sending the raw initData for the server to verify',
     posted.body.init_data === GOOD_INIT);
  ok('login succeeds', res.ok === true);
  ok('and the session is stored where the rest of the app reads it',
     a.w.localStorage.getItem('ahad_token') === 'tok123');
  ok('the username is cached too', a.w.localStorage.getItem('ahad_user') === 'tg_555');

  // Re-authenticating on every open would spawn a session row each time.
  posted = null;
  const b = boot({ initData: GOOD_INIT, fetchImpl: okFetch, token: 'existing' });
  const r2 = await b.w.__tgAutoLogin();
  ok('an existing session is reused, not re-authenticated', r2.reused === true);
  ok('no request is made at all', posted === null);
  ok('and the existing token is left alone',
     b.w.localStorage.getItem('ahad_token') === 'existing');

  // A rejected verification must not leave the user on a blank page.
  const badFetch = () => Promise.resolve({
    ok: false, status: 400,
    json: () => Promise.resolve({ detail: 'Could not verify Telegram sign-in.' }),
  });
  const cB = boot({ initData: GOOD_INIT, fetchImpl: badFetch });
  const r3 = await cB.w.__tgAutoLogin();
  ok('a rejected sign-in reports failure', r3.ok === false);
  ok('with the status, so the caller can decide', r3.status === 400);
  ok('and nothing is written to storage',
     cB.w.localStorage.getItem('ahad_token') === null);

  // ── 5. the boot path in pro.js ────────────────────────────────────────
  console.log('[5] the app signs in before choosing a screen');
  const bootSeg = PRO.slice(PRO.indexOf('window.__tgAutoLogin()'),
                            PRO.indexOf('window.__tgAutoLogin()') + 1200);
  ok('success goes straight to the dashboard',
     /showScreen\("screen-dashboard"\)/.test(bootSeg));
  ok('failure falls back to the normal login screen',
     /showScreen\("screen-landing"\)/.test(bootSeg));
  ok('a thrown error does too', bootSeg.split('screen-landing').length >= 3);
  ok('the splash is cleared either way', /finally/.test(bootSeg));
  ok('it runs BEFORE the synchronous screen decision',
     PRO.indexOf('window.__tgAutoLogin()') <
     PRO.indexOf('// ---- Boot: decide the screen SYNCHRONOUSLY'));
  ok('and only when there is no session yet', /&& !authToken\)/.test(
     PRO.slice(PRO.indexOf('window.__inTelegram'), PRO.indexOf('window.__tgAutoLogin()'))));

  // ── 6. visual adaptation ──────────────────────────────────────────────
  console.log('[6] redundant browser chrome is hidden, nothing is rebuilt');
  ok('sign-out is hidden inside the Mini App',
     /html\.tg-hide-signout #btnLogout\s*\{[^}]*display:\s*none/.test(CSS));
  ok('the class really is applied',
     inTg.d.documentElement.classList.contains('tg-hide-signout'));
  ok('the marketing navbar is hidden, since Telegram draws its own header',
     /html\.in-telegram nav\.nav\s*\{[^}]*display:\s*none/.test(CSS));
  // The rule has to match the real markup. An earlier version targeted
  // `.landing-nav`, a class that does not exist here, so it matched nothing.
  ok('and that selector exists in the page', /<nav class="nav">/.test(HTML));
  ok('full height uses the Telegram viewport, not 100vh',
     /html\.in-telegram body\s*\{[^}]*var\(--tg-vh/.test(CSS));

  console.log('[7] it is the same app, not a parallel one');
  ok('miniapp.js builds no UI', !/innerHTML|createElement\(/.test(SRC));
  ok('it defines no routes or screens of its own', !/screen-/.test(SRC));
  ok('and creates no second job path',
     !/\/api\/jobs|\/internal\//.test(SRC));
  ok('the SDK is loaded from Telegram\'s own origin',
     /https:\/\/telegram\.org\/js\/telegram-web-app\.js/.test(HTML));

  console.log(`\ntest_miniapp_ui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
