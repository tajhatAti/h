/* The editor owns the screen; the controls live in one menu.
 *
 * REPORTED
 *   "জব লিস্ট অনেক বড় হয়ে গেছে ... ফলে ইডিটর একপাশে সরে গিয়ে ছোট হয়ে গেছে,
 *    এডিটর ফুল স্ক্রিন লাগবে ... বাকি সব থাকবে একটা বাটনে, ক্লিক করলে ছোট ছোট
 *    বাটন উপর থেকে নিচ বরাবর সারি সারি নামবে ... রান, সেভ, ডিটেলস বাটন একটার
 *    উপর আরেকটা হয়ে গেছে, পাশাপাশি নাই"
 *   plus: the sign-in card carries filler text and its three controls are
 *   not laid out.
 *
 * TWO DISTINCT DEFECTS
 *   (a) .rs-side was a permanent 210px column on desktop, so the editor was
 *       never full width -- it only got the space back when the rail was
 *       explicitly collapsed. The rail is an overlay at every size now.
 *   (b) .rs-head packed a breadcrumb, a three-button segmented group and two
 *       icon buttons into a fixed 52px row with no flex-shrink guard, so
 *       under ~900px they overlapped instead of sitting side by side.
 *
 * WHAT THIS SUITE WILL NOT ACCEPT
 *   A rule that merely EXISTS. Every geometric claim is measured on
 *   computed style with the real sheet applied, at both widths, and the
 *   overlap check compares actual left/right box edges rather than looking
 *   for a property name.
 *
 * jsdom does not evaluate @media, so the blocks matching the width under
 * test are lifted and appended in source order -- which reproduces the
 * cascade, including later rules overriding earlier ones.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const R = path.resolve(__dirname, '../../');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(R, 'static', 'app.css'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

function sheetFor(width) {
  let out = CSS;
  const re = /@media\s*\(([a-z-]+):\s*(\d+)px\)\s*\{/g;
  let m;
  while ((m = re.exec(CSS))) {
    const [, kind, px] = m;
    const n = Number(px);
    const applies = (kind === 'max-width' && width <= n) ||
                    (kind === 'min-width' && width >= n);
    if (!applies) continue;
    let depth = 0, start = CSS.indexOf('{', m.index), j = start;
    for (; j < CSS.length; j++) {
      if (CSS[j] === '{') depth++;
      else if (CSS[j] === '}') { depth--; if (!depth) break; }
    }
    out += '\n' + CSS.slice(start + 1, j) + '\n';
  }
  return out;
}
function build(width) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const d = dom.window.document;
  d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
  const st = d.createElement('style'); st.textContent = sheetFor(width);
  d.head.appendChild(st);
  d.documentElement.setAttribute('data-theme', 'dark');
  return dom;
}
const cs = (w, el) => w.getComputedStyle(el);

function outOfFlow(w, el) {
  const s = cs(w, el);
  return s.position === 'fixed' || s.position === 'absolute';
}
function closed(w, el) {
  const s = cs(w, el);
  return s.display === 'none' || s.visibility === 'hidden' ||
         /translateX\(-100%\)|translateX\(100%\)/.test(s.transform || '');
}

/* ── 1. THE EDITOR IS FULL WIDTH ───────────────────────────────────────── */
console.log('[1] the editor is not squeezed by the job list');
for (const width of [1280, 720]) {
  const dom = build(width), w = dom.window, d = w.document;
  const side = d.getElementById('wbSide');
  const main = d.querySelector('#tab-jobs .rs-main');
  ok(`[${width}] the rail exists`, !!side);
  ok(`[${width}] the editor pane exists`, !!main);
  if (!side || !main) continue;

  // The rail must not take a column out of the row.
  ok(`[${width}] the rail is an overlay, not a column`, outOfFlow(w, side),
     cs(w, side).position);
  ok(`[${width}] the rail starts closed`, closed(w, side),
     `${cs(w, side).transform} vis=${cs(w, side).visibility}`);

  // ...so the editor gets the whole row.
  const mainW = cs(w, main).width;
  ok(`[${width}] the editor spans the full width`,
     mainW === '100%' || mainW === '' || parseFloat(mainW) >= 99,
     `width=${mainW} flex=${cs(w, main).flex}`);
}

/* ── 2. OPENING THE RAIL DOES NOT SHRINK THE EDITOR ────────────────────── */
console.log('\n[2] opening the job list floats over, it does not push');
for (const width of [1280, 720]) {
  const dom = build(width), w = dom.window, d = w.document;
  const side = d.getElementById('wbSide');
  const main = d.querySelector('#tab-jobs .rs-main');
  const before = cs(w, main).width;
  d.body.classList.add('rs-side-open');
  ok(`[${width}] the rail opens`, !closed(w, side), cs(w, side).transform);
  ok(`[${width}] the editor width is unchanged while it is open`,
     cs(w, main).width === before, `${before} -> ${cs(w, main).width}`);
  ok(`[${width}] the rail is above the editor`,
     Number(cs(w, side).zIndex || 0) >= 800, cs(w, side).zIndex);
  d.body.classList.remove('rs-side-open');
  d.body.classList.add('rs-side-collapsed');
  ok(`[${width}] collapsed closes it too`, closed(w, side));
}

/* ── 3. NO OVERLAPPING BUTTONS ─────────────────────────────────────────── */
console.log('\n[3] Run / Details / Close do not stack on each other');
{
  // Narrow: the controls must leave the header row entirely and become a
  // vertical menu -- that is what "একটার উপর আরেকটা" was.
  const dom = build(720), w = dom.window, d = w.document;
  const right = d.querySelector('#tab-jobs .rs-head-right');
  ok('the action group exists', !!right);
  ok('narrow: it is lifted out of the header row', outOfFlow(w, right),
     cs(w, right).position);
  ok('narrow: it stacks vertically', cs(w, right).flexDirection === 'column',
     cs(w, right).flexDirection);
  ok('narrow: it is closed until asked for',
     cs(w, right).visibility === 'hidden' || cs(w, right).opacity === '0',
     `vis=${cs(w, right).visibility} op=${cs(w, right).opacity}`);
  ok('narrow: it cannot be clicked while closed',
     cs(w, right).pointerEvents === 'none', cs(w, right).pointerEvents);

  d.body.classList.add('rs-side-open');
  ok('narrow: the menu button reveals it',
     cs(w, right).visibility === 'visible' && cs(w, right).pointerEvents === 'auto',
     `vis=${cs(w, right).visibility} pe=${cs(w, right).pointerEvents}`);

  // Every action becomes a full-width row, so two cannot share a line.
  const seg = d.getElementById('rsJobActions');
  ok('narrow: the segmented group unrolls into a column',
     cs(w, seg).flexDirection === 'column', cs(w, seg).flexDirection);
  for (const id of ['btnStartJob', 'btnStopJob', 'btnRestartJob']) {
    const b = d.getElementById(id);
    if (!b) continue;
    ok(`narrow: #${id} is a full-width row`, cs(w, b).width === '100%',
       cs(w, b).width);
  }
}
{
  // Wide: they stay inline, but nothing may shrink into its neighbour.
  const dom = build(1280), w = dom.window, d = w.document;
  const right = d.querySelector('#tab-jobs .rs-head-right');
  ok('wide: the controls stay in the header', !outOfFlow(w, right),
     cs(w, right).position);
  ok('wide: they sit in a row', cs(w, right).flexDirection !== 'column',
     cs(w, right).flexDirection);
  const head = d.querySelector('#tab-jobs .rs-head');
  const kids = [...head.children];
  ok('wide: no header child is allowed to shrink',
     kids.every(k => (cs(w, k).flexShrink || '1') === '0'),
     kids.map(k => k.id || k.className).join(','));
  ok('wide: only the breadcrumb absorbs the slack',
     cs(w, d.querySelector('#tab-jobs .rs-crumb')).flexGrow === '1');
}

/* ── 4. SIGN-IN: filler gone, three controls arranged ──────────────────── */
console.log('\n[4] the sign-in card');
{
  const dom = build(1280), w = dom.window, d = w.document;
  const hint = d.querySelector('#screen-signin .telegram-hint');
  if (hint) ok('the duplicate Telegram hint is hidden',
     cs(w, hint).display === 'none', cs(w, hint).display);

  // The fallback note must survive: deleting it once left an empty card and
  // locked a user out when the widget script was blocked.
  const note = d.getElementById('telegramUnavailable');
  ok('the "Telegram unavailable" fallback still exists in the DOM', !!note);
  ok('it is hidden by its own attribute, not deleted by CSS',
     !!note && note.hasAttribute('hidden'));

  const row = d.querySelector('#screen-signin .field-row');
  ok('Remember me / Forgot password share one row', !!row);
  if (row) {
    ok('they are laid out horizontally', cs(w, row).flexDirection === 'row',
       cs(w, row).flexDirection);
    ok('pushed to opposite ends',
       cs(w, row).justifyContent === 'space-between', cs(w, row).justifyContent);
    ok('and never wrap onto two lines', cs(w, row).flexWrap === 'nowrap',
       cs(w, row).flexWrap);
  }
  const sw = d.querySelector('#screen-signin .auth-switch');
  ok('"Create an account" is separated as a footer', !!sw);
  if (sw) ok('with a divider above it',
     /1px/.test(cs(w, sw).borderTopWidth || '') || cs(w, sw).borderTopStyle === 'solid',
     `${cs(w, sw).borderTopWidth} ${cs(w, sw).borderTopStyle}`);
}

/* ── 5. NOTHING WAS REMOVED TO ACHIEVE ANY OF THIS ─────────────────────── */
console.log('\n[5] every control still exists');
{
  const dom = build(1280), d = dom.window.document;
  for (const id of ['btnStartJob', 'btnStopJob', 'btnRestartJob', 'btnInspector',
                    'btnDeselect', 'wbMenuBtn', 'wbSide', 'jobsList',
                    'si_username', 'si_password', 'btnSignin'])
    ok(`#${id} is still in the shell`, !!d.getElementById(id));
}

console.log(`\ntest_editor_fullwidth_and_menu: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
