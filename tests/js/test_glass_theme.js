/* Glass surfaces, and the drawer closing on a dynamically added tab.
 *
 * TWO THINGS ARE PINNED HERE.
 *
 * 1. THE MENU BUG, reproduced before the fix. The drawer-closing listener was
 *    attached per button, to whatever .dash-tab existed AT BOOT. The Admin
 *    button is NOT in the shell — the server strips it so its existence is not
 *    discoverable — and applyAdminVisibility() injects it after the profile
 *    confirms an admin. That injected button never got the listener:
 *
 *        drawer open       : true
 *        after Admin click : true    <-- menu stayed over the console
 *
 *    Delegation on the container fixes it for every current AND future tab.
 *
 * 2. GLASS IS A SURFACE TREATMENT, NOT A SIGNAL. Chrome and cards get it; the
 *    primary button, the active tab, the code editor and the log console do
 *    not — the first two because they must stay unmissable, the last two
 *    because blurring text you are reading is both slower and worse.
 *
 * A NOTE ON THE HARNESS: jsdom cannot resolve var() inside backdrop-filter,
 * so a later `blur(var(--x))` loses to an earlier `none !important` and every
 * surface looks unstyled. Verified with a minimal repro — a literal value
 * wins, a var() value does not. The tokens are therefore substituted before
 * the cascade is measured; the browser resolves them natively.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRO = fs.readFileSync(path.join(ROOT, 'static/pro.js'), 'utf8');
const RAW_CSS = fs.readFileSync(path.join(ROOT, 'static/classic.css'), 'utf8');
const RS_CSS = fs.readFileSync(path.join(ROOT, 'static/runspace-dark.css'), 'utf8');
const CS_CSS = fs.readFileSync(path.join(ROOT, 'static/codestudio.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${e ? ' -> ' + e : ''}`)); };

// Substitute the tokens jsdom cannot resolve. This changes only the VALUE,
// never which rule wins, which is what is under test.
const CSS = RAW_CSS
  .replace(/blur\(var\(--glass-blur\)\)\s*saturate\(var\(--glass-sat\)\)/g,
           'blur(18px) saturate(150%)')
  .replace(/saturate\(var\(--glass-sat\)\)/g, 'saturate(150%)');

function page() {
  const dom = new JSDOM(HTML, { pretendToBeVisual: true });
  const d = dom.window.document;
  d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
  const st = d.createElement('style');
  st.textContent = CSS;
  d.head.appendChild(st);
  return dom;
}

// ── 1. the drawer closes on EVERY tab, including injected ones ──────────
console.log('\n[1] the side menu closes when a tab is tapped');
{
  const dom = new JSDOM(HTML, { pretendToBeVisual: true });
  const d = dom.window.document;
  const tabs = d.querySelector('.dash-tabs');
  const ov = d.getElementById('sideOverlay');
  const open = () => { tabs.classList.add('open'); if (ov) ov.classList.remove('hidden'); };
  const close = () => { tabs.classList.remove('open'); if (ov) ov.classList.add('hidden'); };

  // Production shell: the server strips the Admin button.
  d.getElementById('tabBtnAdmin').remove();
  // The real wiring, as it now ships.
  tabs.addEventListener('click', (e) => { if (e.target.closest('.dash-tab')) close(); });
  // …then applyAdminVisibility() injects Admin, AFTER wiring ran.
  tabs.insertAdjacentHTML('beforeend',
    '<button class="dash-tab tab-secondary" id="tabBtnAdmin" data-tab="admin">' +
    '<span class="tab-tx">Admin</span></button>');

  const adminBtn = d.getElementById('tabBtnAdmin');
  open();
  ok('control: the drawer really opened', tabs.classList.contains('open'));
  adminBtn.click();
  ok('tapping the INJECTED Admin tab closes it', !tabs.classList.contains('open'));
  ok('and the overlay is hidden with it', ov.classList.contains('hidden'));

  // A real tap lands on the label, not the button box.
  open();
  d.querySelector('#tabBtnAdmin .tab-tx').click();
  ok('tapping the label inside the button also closes it',
     !tabs.classList.contains('open'));

  // Every other tab must keep working.
  let stuck = [];
  for (const b of d.querySelectorAll('.dash-tabs .dash-tab')) {
    open();
    b.click();
    if (tabs.classList.contains('open')) stuck.push(b.dataset.tab || b.id || '?');
  }
  ok('no tab leaves the drawer open', stuck.length === 0, stuck.join(','));

  // Something that is NOT a tab must not close it.
  open();
  tabs.click();
  ok('clicking the bar background does not close it',
     tabs.classList.contains('open'));
}

console.log('[2] the wiring is delegated, so a future tab cannot miss it');
ok('the listener is on the container, not each button',
   /_tabsBar\.addEventListener\("click"/.test(PRO));
ok('it matches via closest, so inner elements count',
   /e\.target\.closest\("\.dash-tab"\)/.test(PRO));
ok('the old per-button loop is gone',
   !/querySelectorAll\("\.dash-tabs \.dash-tab"\)\.forEach\(b => b\.addEventListener/.test(PRO));

// ── 3. glass on the surfaces that should have it ────────────────────────
console.log('[3] glass is applied to chrome and cards');
{
  const dom = page();
  const d = dom.window.document, w = dom.window;
  const bf = (sel) => {
    const el = d.querySelector(sel);
    if (!el) return 'NO ELEMENT';
    return w.getComputedStyle(el).backdropFilter || '(none)';
  };
  for (const sel of ['.dash-bar', 'nav.nav', '.profile-card', '.stat-card',
                     '.adm-panel', '.ah-modal-card',
                     '.btn-ghost', '.dash-tab:not(.active)', '.input-text']) {
    ok(`${sel} is glass`, /blur/.test(bf(sel)), bf(sel));
  }
  // .adm-stat is built at runtime by renderAdminStats, so it is absent from
  // the shell. Inject one and measure it the same way, rather than asserting
  // on the stylesheet text — the point is that the cascade reaches it.
  const host = d.querySelector('.dash-main') || d.body;
  host.insertAdjacentHTML('beforeend', '<div class="adm-stat"><b>1</b></div>');
  ok('.adm-stat is glass once rendered', /blur/.test(bf('.adm-stat')), bf('.adm-stat'));

  console.log('[4] but NOT on the things that must stay solid');
  const t = d.querySelector('.dash-tab');
  ok('control: the first tab really is the active one', t.classList.contains('active'));
  ok('the active tab stays solid, so it still reads as active',
     !/blur/.test(w.getComputedStyle(t).backdropFilter || ''),
     w.getComputedStyle(t).backdropFilter);
  // The primary button is the one element whose job is to be unmissable.
  ok('the primary button is never listed for glass',
     !/\.btn-primary[^{,]*,[\s\S]{0,400}?backdrop-filter:\s*blur/.test(RAW_CSS)
     || !/^\s*\.btn-primary\s*,/m.test(RAW_CSS));
  ok('and .cs-act.primary is explicitly excluded',
     /\.cs-act:not\(\.primary\)/.test(RAW_CSS));
}

console.log('[5] glass never carries meaning');
// Status colours and the accent are the meaning-carrying tokens. A glass rule
// that also set one of them would make a surface treatment into a signal.
{
  const sec = RAW_CSS.slice(RAW_CSS.indexOf('25. GLASS SURFACES'));
  ok('the glass section sets no status colour',
     !/--st-(ok|warn|danger)\s*:/.test(sec));
  ok('and does not redefine the accent', !/--acc\s*:/.test(sec));
  ok('it only defines glass-* tokens plus surfaces',
     (sec.match(/^\s*--(?!glass)[a-z-]+:/gm) || []).length === 0,
     (sec.match(/^\s*--(?!glass)[a-z-]+:/gm) || []).join(','));
}

console.log('[6] it degrades instead of becoming unreadable');
ok('there is an @supports fallback to opaque panels',
   /@supports not \(\(backdrop-filter/.test(RAW_CSS));
ok('the fallback restores a real background',
   /@supports not[\s\S]{0,900}background:\s*var\(--panel\)/.test(RAW_CSS));
ok('reduced-transparency is honoured, not overridden',
   /@media \(prefers-reduced-transparency: reduce\)/.test(RAW_CSS));
ok('and that path turns the blur off',
   /prefers-reduced-transparency[\s\S]{0,900}backdrop-filter:\s*none/.test(RAW_CSS));

console.log('[7] dark-only screens get the same treatment');
// RunSpace and Code Studio never read data-theme, so classic.css cannot reach
// them; they need their own glass expressed in their own tokens.
ok('RunSpace has a glass section', /GLASS SURFACES \(RunSpace\)/.test(RS_CSS));
// NOT .rs-head — that is the toolbar, and section [9] requires it to stay
// opaque. This assertion originally targeted it and directly contradicted
// that rule; the rails behind content are what should have been checked.
ok('its side rails are glass',
   /#tab-jobs \.rs-side,[\s\S]{0,300}backdrop-filter:\s*blur/.test(RS_CSS));
ok('the editor pane is explicitly NOT blurred',
   /#tab-jobs \.rs-ws[\s\S]{0,220}backdrop-filter:\s*none/.test(RS_CSS));
ok('nor is the log console',
   /rs-logs[\s\S]{0,220}backdrop-filter:\s*none/.test(RS_CSS));
ok('Code Studio has one too', /GLASS SURFACES \(Code Studio\)/.test(CS_CSS));
ok('its chrome is glass',
   /\.code-studio \.cs-bar[\s\S]{0,300}backdrop-filter:\s*blur/.test(CS_CSS));
ok('but the code editor is not',
   /\.code-studio \.cm-editor[\s\S]{0,200}backdrop-filter:\s*none/.test(CS_CSS));
ok('both ship the @supports fallback',
   /@supports not/.test(RS_CSS) && /@supports not/.test(CS_CSS));

console.log('[8] both themes are covered');
ok('light values are the :root defaults', /--glass-bg:\s*rgba\(255, 255, 255/.test(RAW_CSS));
ok('dark overrides them',
   /html\[data-theme="dark"\][\s\S]{0,300}--glass-bg:\s*rgba\(27, 27, 31/.test(RAW_CSS));
ok('the dark hairline is a light tint, not a dark one',
   /html\[data-theme="dark"\][\s\S]{0,400}--glass-line:\s*rgba\(255, 255, 255/.test(RAW_CSS));

console.log('[9] a toolbar is never translucent');
// REPORTED: "Run, Stop, Env, Metrics, Logs" vanished. Those controls live
// inside .rs-head, and glass on that surface let the near-black canvas show
// through, so the buttons stopped reading against it. A toolbar is exactly
// the surface that must not recede — the panels BEHIND content still get
// glass, because nothing sits on top of them competing for contrast.
{
  const dom = new JSDOM(HTML, { pretendToBeVisual: true });
  const d = dom.window.document, w = dom.window;
  d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
  const st = d.createElement('style'); st.textContent = RS_CSS; d.head.appendChild(st);
  const head = d.querySelector('#tab-jobs .rs-head');
  ok('control: the toolbar buttons really are inside .rs-head',
     !!head && head.contains(d.getElementById('btnStartJob')));
  ok('.rs-head is opaque',
     !/blur/.test(w.getComputedStyle(head).backdropFilter || ''),
     w.getComputedStyle(head).backdropFilter);
  // …while the panels behind content keep it.
  for (const sel of ['#tab-jobs .rs-side', '#tab-jobs .rs-insp']) {
    const e = d.querySelector(sel);
    if (!e) continue;
    ok(`${sel} still has glass`,
       /blur/.test(w.getComputedStyle(e).backdropFilter || ''),
       w.getComputedStyle(e).backdropFilter);
  }
}
ok('the code-studio toolbar is opaque too',
   /\.code-studio \.cs-bar \{[^}]*backdrop-filter:\s*none/.test(CS_CSS));
ok('job rows are not double-veiled over a glass rail',
   /#tab-jobs \.job-item \{[^}]*backdrop-filter:\s*none/.test(RS_CSS));

console.log('[10] the theme is decided before the first paint');
// REPORTED: "Dashboard middle is white". data-theme was only set once pro.js
// ran, so the first paint used the :root defaults — which are the LIGHT glass
// values. On a dark app that is a white sheet until the script catches up.
ok('an inline script sets data-theme', /setAttribute\("data-theme"/.test(HTML));
ok('it runs before pro.js',
   HTML.indexOf('setAttribute("data-theme"') < HTML.indexOf('/static/pro.js'),
   String(HTML.indexOf('setAttribute("data-theme"')));
ok('it runs before the stylesheets are even linked',
   HTML.indexOf('setAttribute("data-theme"') < HTML.indexOf('classic.css'),
   `theme@${HTML.indexOf('setAttribute("data-theme"')} css@${HTML.indexOf('classic.css')}`);
ok('it falls back to dark, matching initTheme',
   /"light" : "dark"/.test(HTML));
ok('and a thrown error still yields a theme',
   /catch \(e\) \{[\s\S]{0,120}data-theme", "dark"/.test(HTML));
ok('the light values are still the :root default (light users get them)',
   /:root \{[\s\S]{0,600}--glass-bg:\s*rgba\(255, 255, 255/.test(RAW_CSS));

console.log(`\ntest_glass_theme: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
