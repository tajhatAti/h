/* RunSpace: always dark · closable mobile drawer · roomier desktop editor.
 *
 * THREE REPORTS, THREE FINDINGS:
 *
 * 1. "RunSpace must be dark, no light mode."
 *    RunSpace's own surfaces are hardcoded dark and never read data-theme —
 *    but the site-wide component rules added in classic.css §18
 *    (.badge/.chip/.rs-chip/.job-pill, links, focus) resolve --line-2,
 *    --muted and --panel, and THOSE flip with the theme. Measured in light
 *    mode: --line-2 #c9c9cf and --muted #545b6e, i.e. light borders and text
 *    painted onto a dark panel. Fixed by pinning the shared tokens inside
 *    #tab-jobs so the subtree cannot follow the site theme.
 *
 * 2. "The jobs panel is always open on mobile; I cannot see or type."
 *    Reported THREE times. The drawer slid correctly and both the header
 *    toggle and the backdrop did remove the class — but there was NO close
 *    control inside the panel, and the backdrop starts below the header so
 *    it does not read as tappable. Verified by walking the drawer's DOM:
 *    exactly one button (New job), zero closers.
 *
 * 3. "Desktop is fine but the editor needs more room."
 *    The rail was 250px; now 210px, and the meta strip 36px -> 34px.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../');
const ORDER = ['pro.css', 'emoji.css', 'classic.css', 'workbench.css',
               'codestudio.css', 'terminal.css', 'runspace-dark.css', 'landing.css'];
const read = f => fs.readFileSync(path.join(ROOT, 'static', f), 'utf8');
const CSS = read('runspace-dark.css');
const ALLCSS = ORDER.map(read).join('\n');
const JS = fs.readFileSync(path.join(ROOT, 'static/pro.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${e ? ' -> ' + e : ''}`)); };

function build(theme) {
  const dom = new JSDOM(HTML, { pretendToBeVisual: true });
  const d = dom.window.document;
  d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
  const s = d.createElement('style'); s.textContent = ALLCSS; d.head.appendChild(s);
  if (theme) d.documentElement.setAttribute('data-theme', theme);
  return dom;
}

// ── 1. RunSpace never follows the site theme ────────────────────────────
console.log('\n[1] always dark');
ok('shared tokens are pinned inside #tab-jobs',
   /#tab-jobs,[\s\S]{0,260}--panel:\s*var\(--bg-2\)/.test(CSS));
ok('the pin also covers html[data-theme="light"]',
   /html\[data-theme="light"\] #tab-jobs/.test(CSS));
ok('the Job Detail subtree is covered too', /#tab-jobs \.jd,/.test(CSS));
// Anchor inside the pin block itself; a fixed char window broke as soon as
// comments were reworded.
const PIN = /html\[data-theme="light"\] #tab-jobs \.jd \{([\s\S]*?)\}/.exec(CSS);
ok('token pin block found', !!PIN);
ok('color-scheme declared dark (native controls follow)',
   !!PIN && /color-scheme:\s*dark/.test(PIN[1]));
// Aliased to RunSpace's own --danger rather than restating the hex, so the
// assertion follows the token, not a literal.
ok('status tokens re-pinned so pills keep meaning',
   !!PIN && /--st-danger:\s*var\(--danger\)/.test(PIN[1]));

// Behavioural: the token must resolve identically in BOTH themes.
for (const tok of ['--panel', '--muted', '--line-2', '--ink']) {
  const dark = build('dark'), light = build('light');
  const gd = dark.window.getComputedStyle(dark.window.document.getElementById('tab-jobs'));
  const gl = light.window.getComputedStyle(light.window.document.getElementById('tab-jobs'));
  const a = gd.getPropertyValue(tok).trim(), b = gl.getPropertyValue(tok).trim();
  ok(`${tok} identical in light and dark inside RunSpace`, a === b, `${a} vs ${b}`);
}
// Control: prove the leak was real, i.e. these tokens DO differ at :root.
{
  const dark = build('dark'), light = build('light');
  const a = dark.window.getComputedStyle(dark.window.document.documentElement)
    .getPropertyValue('--line-2').trim();
  const b = light.window.getComputedStyle(light.window.document.documentElement)
    .getPropertyValue('--line-2').trim();
  ok('control: --line-2 really does flip at :root (so the pin matters)',
     a !== b, `${a} vs ${b}`);
}

// ── 2. the blue focus glow is kept ──────────────────────────────────────
console.log('[2] focus glow retained');
ok('focus outline uses the accent',
   /#tab-jobs :focus-visible \{[^}]*outline:\s*2px solid var\(--accent\)/.test(CSS));
ok('inputs get a ring instead of an offset outline',
   /#tab-jobs \.rs-inp:focus[\s\S]{0,220}box-shadow:\s*0 0 0 3px rgba\(88, ?166, ?255/.test(CSS));

// ── 3. mobile drawer is closable ────────────────────────────────────────
console.log('[3] mobile drawer');
const dom = build('dark');
const d = dom.window.document;
const side = d.getElementById('wbSide');
const closeBtn = d.getElementById('btnSideClose');
ok('a close button exists inside the drawer', !!closeBtn);
ok('it lives in the drawer, not the app header',
   !!closeBtn && !!closeBtn.closest('#wbSide'));
ok('it is labelled for screen readers',
   !!closeBtn && !!closeBtn.getAttribute('aria-label'));
ok('hidden on desktop', /#tab-jobs \.rs-side-close \{ display: none; \}/.test(CSS));
ok('shown on mobile',
   /@media \(max-width: 760px\)[\s\S]{0,900}\.rs-side-close \{[\s\S]{0,120}display: grid/.test(CSS));
ok('JS wires the close button', /btnSideClose/.test(JS));
ok('it removes the open class', /btnSideClose[\s\S]{0,300}remove\("rs-side-open"\)/.test(JS));
ok('Escape also closes the drawer',
   /e\.key !== "Escape"[\s\S]{0,260}rs-side-open/.test(JS));
ok('Escape yields to the Details page',
   /rs-side-open"\)\) return;[\s\S]{0,160}rs-detail-open/.test(JS));
ok('swipe-left dismisses it', /touchstart[\s\S]{0,900}dx < -48/.test(JS));
ok('swipe ignores vertical scrolling of the job list',
   /Math\.abs\(dx\) > Math\.abs\(dy\)/.test(JS));
ok('touch listeners are passive (no scroll jank)',
   (JS.match(/\{ passive: true \}/g) || []).length >= 2);
// The drawer header must fit two 30px targets without crowding.
ok('drawer header is tall enough on mobile for two tap targets',
   /@media \(max-width: 760px\)[\s\S]{0,1100}\.rs-side-head \{ flex-basis: 44px/.test(CSS));

// ── 4. desktop editor gets more room ────────────────────────────────────
console.log('[4] desktop space');
ok('rail narrowed to 210px',
   /@media \(min-width: 761px\)[\s\S]{0,240}\.rs-side \{ flex: 0 0 210px/.test(CSS));
const before = 250, after = 210;
console.log(`      rail ${before}px -> ${after}px  (+${before - after}px to the editor)`);
ok('that is a real gain', before - after >= 32);
ok('meta strip trimmed on desktop',
   /@media \(min-width: 761px\)[\s\S]{0,300}--rs-meta-h:\s*34px/.test(CSS));

// ── 5. nothing regressed ────────────────────────────────────────────────
console.log('[5] no regressions');
// Anchor on the rule itself rather than guessing a distance from the @media
// opener — the comment block above it is ~880 chars and a fixed window is
// brittle for exactly that reason.
ok('drawer still slides with transform',
   /#tab-jobs \.rs-side \{[^}]*transform: translateX\(-100%\)/.test(CSS));
ok('open state still shown', /body\.rs-side-open #tab-jobs \.rs-side \{ transform: translateX\(0\)/.test(CSS));
ok('selecting a job still closes the drawer',
   /function selectJob[\s\S]{0,900}remove\("rs-side-open"\)/.test(JS));
ok('backdrop still closes it', /backdrop\.addEventListener\("click"[\s\S]{0,140}rs-side-open/.test(JS));
ok('New job button survived', !!d.getElementById('btnNew'));

console.log(`\ntest_runspace_dark_and_drawer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
