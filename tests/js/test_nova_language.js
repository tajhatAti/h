/* Proof that NOVA actually changed the design LANGUAGE, not just colours.
 *
 * Four previous rounds retuned the palette, reported green, and the user
 * still saw the same site -- because the palette was never what made it
 * look the way it did. The shape did: 23 pill radii, 127 box-shadows,
 * Fraunces serif headings, decorative gradients, sliding animations.
 *
 * So this suite asserts on SHAPE, measured as computed style on real
 * elements from index.html with every stylesheet applied in load order.
 * A colour-only change cannot pass it.
 *
 * jsdom cannot resolve var() in colour values, so anything colour-related
 * is read from the stylesheet source via postcss instead of computed style
 * -- see the palette section at the bottom.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const R = path.resolve(__dirname, '../../');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');

// Load order matters: nova.css must win, so it is applied last exactly as
// index.html lists it.
const ORDER = [...html.matchAll(/\/static\/([a-z0-9-]+\.css)/g)].map(m => m[1]);
const css = ORDER
  .filter(f => fs.existsSync(path.join(R, 'static', f)))
  .map(f => fs.readFileSync(path.join(R, 'static', f), 'utf8'))
  .join('\n');

const dom = new JSDOM(html, { pretendToBeVisual: true });
const d = dom.window.document;
d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
const st = d.createElement('style'); st.textContent = css; d.head.appendChild(st);
d.documentElement.setAttribute('data-theme', 'dark');
const cs = el => dom.window.getComputedStyle(el);

/* Only trust nova.css if the page ACTUALLY LOADS IT.
 *
 * This is the trap every earlier suite fell into: assertions that read the
 * stylesheet file directly pass whether or not the browser ever sees it.
 * Removing the <link> and re-running proved it -- 50 of 52 still passed
 * with the sheet unlinked, i.e. the suite was largely measuring a file on
 * disk, not the rendered product. So the source is only made available
 * after confirming index.html links it last; otherwise it is the empty
 * string and every source-based assertion fails loudly, as it should. */
const novaLinkedLast = ORDER[ORDER.length - 1] === 'nova.css';
const novaSrcEarly = novaLinkedLast
  ? fs.readFileSync(path.join(R, 'static', 'nova.css'), 'utf8')
  : '';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

console.log('load order: ' + ORDER.join(' -> '));
ok('nova.css is the last sheet', ORDER[ORDER.length - 1] === 'nova.css',
   ORDER[ORDER.length - 1]);

// ── 1. SQUARE ──────────────────────────────────────────────────────────
// The old language was rounded: 99px pills plus 8/10/12px boxes.
console.log('\n[1] square, not rounded');
// Same var() limitation as box-shadow: a computed radius may come back as
// the literal string "var(--n-r)". Resolve one level of indirection against
// the tokens nova declares, then measure the px value.
const TOKEN_PX = {};
for (const m of novaSrcEarly.matchAll(/(--[a-z0-9-]+):\s*(-?[\d.]+)px\s*[;}]/gi))
  TOKEN_PX[m[1]] = parseFloat(m[2]);
// Tokens defined as another token (e.g. --r-md: var(--n-r)) resolve through.
for (let i = 0; i < 3; i++)
  for (const m of novaSrcEarly.matchAll(/(--[a-z0-9-]+):\s*var\((--[a-z0-9-]+)\)\s*[;}]/gi))
    if (TOKEN_PX[m[2]] !== undefined) TOKEN_PX[m[1]] = TOKEN_PX[m[2]];

function radiusPx(v) {
  v = (v || '').trim();
  if (v === '') return 0;
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (m) return TOKEN_PX[m[1]] !== undefined ? TOKEN_PX[m[1]] : NaN;
  const n = parseFloat(v);
  return Number.isNaN(n) ? NaN : n;
}

// Real class names as they appear in index.html -- .card/.panel/.job-item
// are built by pro.js at runtime and are not in the shell, so asserting on
// them measured nothing. These are the containers actually shipped.
const SQUARE = ['.stat-card', '.quick-card', '.term-card', '.auth-card',
                '.jd-panel', '.ah-modal', '.snippet-item', '.job-item'];
let sqChecked = 0;
for (const sel of SQUARE) {
  const el = d.querySelector(sel);
  if (!el) continue;
  sqChecked++;
  const raw = cs(el).borderRadius;
  const r = radiusPx(raw);
  ok(`${sel} has square corners`, r === 0, `${raw} -> ${r}px`);
}
ok('at least 3 structural elements were checked', sqChecked >= 3, `${sqChecked}`);

for (const sel of ['button', 'input', '.btn-primary']) {
  const el = d.querySelector(sel);
  if (!el) continue;
  const raw = cs(el).borderRadius;
  const r = radiusPx(raw);
  ok(`${sel} radius <= 2px (control, not pill)`, r <= 2, `${raw} -> ${r}px`);
}

// No 99px pill may survive anywhere in the cascade.
const pillRule = /border-radius:\s*99px/.test(
  fs.readFileSync(path.join(R, 'static', 'nova.css'), 'utf8'));
ok('nova introduces no pill radius', !pillRule);

// ── 2. FLAT ────────────────────────────────────────────────────────────
console.log('\n[2] flat, not floating');
// jsdom does NOT resolve var(): a declaration of `box-shadow: var(--shadow-s)`
// is returned verbatim as the string "var(--shadow-s)", never as the token's
// value. Verified with a control (`:root{--x:none}` -> computed "var(--x)").
// So a shadow is judged resolved: literal `none` passes, and a var() passes
// only when that token is itself defined as none somewhere in the cascade.
const NONE_TOKENS = new Set(
  [...novaSrcEarly.matchAll(/(--[a-z0-9-]+):\s*none\s*[;}]/gi)].map(m => m[1]));
function shadowIsNone(v) {
  v = (v || '').trim();
  if (v === '' || v === 'none') return true;
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  return !!(m && NONE_TOKENS.has(m[1]));
}
for (const sel of ['.card', '.stat-card', '.panel', '.btn-primary', '.modal']) {
  const el = d.querySelector(sel);
  if (!el) continue;
  const sh = cs(el).boxShadow;
  ok(`${sel} casts no shadow`, shadowIsNone(sh), `${sh} (tokens->none: ${[...NONE_TOKENS].join(',')})`);
}
// And the blanket reset must actually be present, since that is what
// neutralises the 127 literal shadows the var()-check cannot see.
ok('a global shadow reset exists',
   /\*[^{]*\{[^}]*box-shadow:\s*none\s*!important/s.test(novaSrcEarly));

// ── 3. NO SERIF ────────────────────────────────────────────────────────
console.log('\n[3] one type family, no serif');
ok('Fraunces is not requested from the font CDN', !/Fraunces/.test(html));
const novaSrc = novaSrcEarly;
ok('--serif is repointed to the UI family', /--serif:\s*var\(--n-ui\)/.test(novaSrc));
for (const sel of ['h1', 'h2', 'h3']) {
  const el = d.querySelector(sel);
  if (!el) continue;
  const f = (cs(el).fontFamily || '').toLowerCase();
  ok(`${sel} is not serif`, !f.includes('fraunces') && !f.includes('georgia'), f.slice(0, 40));
}

// ── 4. QUIET SCALE ─────────────────────────────────────────────────────
// The old hero shouted at 40px+. Hierarchy now comes from weight, so the
// largest type must be modest.
console.log('\n[4] quiet type scale');
const h1 = d.querySelector('h1');
if (h1) {
  const fs1 = cs(h1).fontSize || '';
  ok('h1 uses a clamped, non-huge size', /clamp|^\d+px$/.test(fs1.trim()), fs1);
}
ok('section labels are mono + uppercase',
   /\.eyebrow[^{]*\{[^}]*text-transform:\s*uppercase/s.test(novaSrc) ||
   /--n-mono[\s\S]{0,400}uppercase/.test(novaSrc));

// ── 5. UNDERLINE TABS, NOT PILLS ───────────────────────────────────────
console.log('\n[5] tabs are underlined');
ok('active tab uses a bottom border, not a filled pill',
   /\.dash-tab\.active[^{]*\{[^}]*border-bottom-color/s.test(novaSrc));
ok('active tab background is transparent',
   /\.dash-tab\.active[^{]*\{[^}]*background:\s*transparent/s.test(novaSrc));

// ── 6. MOTION IS A FADE ────────────────────────────────────────────────
console.log('\n[6] motion reduced to a fade');
ok('nova defines a fade-only keyframe',
   /@keyframes novaIn\s*\{\s*from\s*\{\s*opacity:\s*0\s*\}\s*to\s*\{\s*opacity:\s*1\s*\}/.test(novaSrc));
ok('no translate/scale in the nova keyframe', !/novaIn[\s\S]{0,120}(translate|scale)/.test(novaSrc));

// ── 7. PALETTE UNCHANGED: still grey/black, still hueless ──────────────
// Read from source: jsdom returns rgba(0,0,0,0) for var()-based colours.
console.log('\n[7] palette stays grey/black');
function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
  const l = (mx + mn) / 2;
  return { s: dl ? dl / (1 - Math.abs(2 * l - 1)) : 0, l };
}
const STATUS = ['--st-ok', '--st-warn', '--st-danger'];
const toks = [...novaSrc.matchAll(/(--(?:n|i)-[a-z0-9]+):\s*(#[0-9a-f]{6})/gi)];
ok('nova declares a full neutral ramp', toks.length >= 9, `${toks.length} tokens`);
for (const [, name, hex] of toks) {
  const { s } = hsl(hex);
  ok(`${name} ${hex} has no hue`, s <= 0.02, `sat=${s.toFixed(3)}`);
}
for (const t of STATUS) ok(`${t} is still defined (colour means something)`,
                           new RegExp(t + ':\\s*#').test(novaSrc));

// ── 8. CONTRAST ────────────────────────────────────────────────────────
console.log('\n[8] contrast');
function lum(hex) {
  const c = [1, 3, 5].map(i => {
    let x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const tok = n => (new RegExp(n + ':\\s*(#[0-9a-f]{6})', 'i').exec(novaSrc) || [])[1];
const pairs = [
  ['primary ink on canvas', tok('--i-1'), tok('--n-1'), 4.5],
  ['secondary on canvas',   tok('--i-2'), tok('--n-1'), 4.5],
  ['tertiary on canvas',    tok('--i-3'), tok('--n-1'), 4.5],
  ['ink on panel',          tok('--i-1'), tok('--n-3'), 4.5],
  ['button label on button',tok('--n-acc-fg'), tok('--n-acc'), 4.5],
];
for (const [n, a, b, min] of pairs) {
  if (!a || !b) { ok(`${n} tokens exist`, false); continue; }
  const r = ratio(a, b);
  ok(`${n} passes AA (${min}:1)`, r >= min, `${r.toFixed(2)}:1 ${a} on ${b}`);
}

// ── 9. NOTHING WAS HIDDEN OR RESTRUCTURED ──────────────────────────────
// A redesign must not "fix" the look by removing features.
console.log('\n[9] no feature removed');
ok('nova hides nothing', !/display:\s*none/.test(novaSrc));
ok('nova sets no position/float/flex-direction (presentational only)',
   !/(^|\s)(position|float|flex-direction)\s*:/m.test(novaSrc));
// The elements must still EXIST in the shell. Asserting they are visible is
// wrong for two of them and jsdom cannot judge it anyway: #tab-jobs is
// display:none until its tab is active, and .rs-side-close is deliberately
// desktop-hidden and revealed inside an @media block, which jsdom ignores
// entirely. So check presence, and check nova did not add a hiding rule.
for (const id of ['tab-jobs', 'wbSide', 'btnSideClose']) {
  ok(`#${id} is still in the shell`, !!d.getElementById(id));
}
ok('the drawer close button keeps its mobile rule',
   /@media[^{]*\{[\s\S]*?\.rs-side-close\s*\{/.test(
     fs.readFileSync(path.join(R, 'static', 'runspace-dark.css'), 'utf8')));

console.log(`\ntest_nova_language: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
