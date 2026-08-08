/* NOVA design language — B (bento) + C (raised nav buttons) + D (mobile).
 *
 * HISTORY THIS SUITE ENCODES
 * --------------------------
 * The previous NOVA revision was square, flat, shadowless and motionless.
 * The user rejected it in those exact terms -- "কোথায় box round, deep
 * button animation nai" -- and picked mockup B with C's sidebar buttons.
 * So the assertions below are the INVERSE of the ones this file used to
 * make. That is deliberate: round, deep, animated is now the contract, and
 * a regression back to flat/square must fail here.
 *
 * WHY IT READS SOURCE AND COMPUTED STYLE DIFFERENTLY
 * --------------------------------------------------
 * jsdom does not resolve var() -- verified with a control: given
 * `:root{--x:none}`, getComputedStyle returns the literal string "var(--x)",
 * not "none". So numeric properties are resolved one level against the
 * tokens nova declares. And jsdom ignores @media entirely, so the mobile
 * rules are checked by lifting the media block out of the source.
 *
 * WHY THE LINK IS CHECKED FIRST
 * -----------------------------
 * An earlier version of this suite scored 50/52 with nova.css UNLINKED,
 * because most assertions read the file from disk rather than the rendered
 * page. Source is therefore withheld unless index.html actually loads the
 * sheet last, which turns that silent pass into 24 loud failures.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const R = path.resolve(__dirname, '../../');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');

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

const novaLinkedLast = ORDER[ORDER.length - 1] === 'nova.css';
const SRC = novaLinkedLast
  ? fs.readFileSync(path.join(R, 'static', 'nova.css'), 'utf8')
  : '';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

// Resolve `var(--tok)` one level against px tokens declared in nova.css.
const PX = {};
for (const m of SRC.matchAll(/(--[a-z0-9-]+):\s*(-?[\d.]+)px\s*[;}]/gi))
  PX[m[1]] = parseFloat(m[2]);
for (let i = 0; i < 3; i++)
  for (const m of SRC.matchAll(/(--[a-z0-9-]+):\s*var\((--[a-z0-9-]+)\)\s*[;}]/gi))
    if (PX[m[2]] !== undefined) PX[m[1]] = PX[m[2]];

function px(v) {
  v = (v || '').trim();
  if (!v) return 0;
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  if (m) return PX[m[1]] !== undefined ? PX[m[1]] : NaN;
  const n = parseFloat(v);
  return Number.isNaN(n) ? NaN : n;
}
// A shadow value counts as "present" if it is a real shadow, or a var()
// pointing at a token whose value is not none.
const SHADOW_TOKENS = {};
for (const m of SRC.matchAll(/(--e-\d|--shadow[a-z-]*|--rim):\s*([^;]+);/gi))
  SHADOW_TOKENS[m[1]] = m[2].trim();
function hasShadow(v) {
  v = (v || '').trim();
  if (!v || v === 'none') return false;
  const m = /^var\((--[a-z0-9-]+)\)/i.exec(v);
  if (m) { const t = SHADOW_TOKENS[m[1]]; return !!t && t !== 'none'; }
  return true;
}

console.log('load order: ' + ORDER.join(' -> '));
ok('nova.css is the last sheet', novaLinkedLast, ORDER[ORDER.length - 1]);

// ── 1. ROUND ───────────────────────────────────────────────────────────
// The complaint was "কোথায় box round". Bento cards must be visibly round.
console.log('\n[1] round — bento cards');
const CARDS = ['.stat-card', '.quick-card', '.feat-card', '.term-card',
               '.auth-card', '.jd-panel', '.snippet-item'];
let n = 0;
for (const sel of CARDS) {
  const el = d.querySelector(sel);
  if (!el) continue;
  n++;
  const r = px(cs(el).borderRadius);
  ok(`${sel} radius >= 12px`, r >= 12, `${cs(el).borderRadius} -> ${r}px`);
}
ok('at least 4 card types checked', n >= 4, `${n}`);
ok('bento radius token is >= 16px', (PX['--r-bento'] || 0) >= 16, `${PX['--r-bento']}px`);
ok('a pill radius exists for CTAs', (PX['--r-pill'] || 0) >= 100, `${PX['--r-pill']}px`);

// ── 2. DEEP ────────────────────────────────────────────────────────────
console.log('\n[2] deep — real elevation');
for (const sel of ['.stat-card', '.quick-card', '.feat-card']) {
  const el = d.querySelector(sel);
  if (!el) continue;
  ok(`${sel} casts a shadow`, hasShadow(cs(el).boxShadow), cs(el).boxShadow);
}
ok('shadows are layered, not a single blur',
   (SRC.match(/--e-2:[^;]*rgba[^;]*,[^;]*rgba/s) || []).length > 0);
ok('cards carry a lit top rim (inset highlight)',
   /inset 0 1px 0 rgba\(255,255,255/.test(SRC));
// The flat revision reset EVERY element with a universal selector. Chrome
// bars legitimately cast nothing, so the check must target the wildcard
// rule specifically, not any rule containing `box-shadow: none`.
ok('no universal shadow reset survives from the flat revision',
   !/(^|\n)\s*\*\s*,[^{]*\{[^}]*box-shadow:\s*none\s*!important/s.test(SRC) &&
   !/(^|\n)\s*\*\s*\{[^}]*box-shadow:\s*none\s*!important/s.test(SRC));

// ── 3. BUTTON ANIMATION ────────────────────────────────────────────────
// "deep button animation nai" — buttons must move on press and hover.
console.log('\n[3] button animation');
ok('buttons transition transform', /button[^{]*\{[^}]*transition:[^;]*transform/s.test(SRC));
ok('buttons travel down on :active',
   /:active[^{]*\{[^}]*transform:\s*translateY\(1px\)/s.test(SRC));
ok('primary CTA lifts on hover',
   /\.btn-primary:hover[^{]*\{[^}]*transform:\s*translateY\(-2px\)/s.test(SRC));
ok('primary CTA glows on hover',
   /\.btn-primary:hover[\s\S]{0,200}rgba\(255,255,255,\.\d+\)/.test(SRC));
ok('cards lift on hover',
   /\.stat-card:hover[\s\S]{0,240}transform:\s*translateY\(-3px\)/.test(SRC));

// ── 4. DESIGN C — raised nav buttons ───────────────────────────────────
console.log('\n[4] design C — raised, pressable nav');
ok('nav buttons are raised (shadow + rim)',
   /\.dash-tab,[\s\S]{0,300}box-shadow:\s*var\(--e-1\),\s*var\(--rim\)/.test(SRC));
ok('nav buttons depress into an inset shadow',
   /\.dash-tab:active[\s\S]{0,220}inset 0 2px 6px/.test(SRC));
ok('active tab is a light slab with dark ink',
   /\.dash-tab\.active[\s\S]{0,240}color:\s*var\(--n-acc-fg\)/.test(SRC));

// ── 5. MOTION ──────────────────────────────────────────────────────────
console.log('\n[5] motion');
ok('content rises in, not just fades',
   /@keyframes novaUp[\s\S]{0,140}translateY\(12px\)/.test(SRC));
ok('job rows stagger', /job-item:nth-child\(2\)\{animation-delay/.test(SRC));
ok('reduced-motion is honoured', /prefers-reduced-motion[\s\S]{0,400}animation-duration:\s*\.01ms/.test(SRC));

// ── 6. MOBILE (design D) ───────────────────────────────────────────────
// jsdom ignores @media, so lift the blocks out by brace counting.
console.log('\n[6] mobile — design D');
function mediaBlock(query) {
  const i = SRC.indexOf(query);
  if (i < 0) return '';
  let depth = 0, start = SRC.indexOf('{', i), j = start;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(start, j);
}
const M = mediaBlock('@media (max-width: 760px)');
ok('a phone breakpoint exists', M.length > 200, `${M.length} chars`);
ok('bento collapses to one column', /\.feat-cards,\s*\n?\s*\.quick-grid\s*\{[^}]*grid-template-columns:\s*1fr/s.test(M));
ok('stat tiles go 2-up', /\.stats-grid\s*\{[^}]*repeat\(2/s.test(M));
ok('touch targets are >= 44px', /min-height:\s*44px/.test(M));
ok('bottom bar clears the home indicator (safe-area)', /env\(safe-area-inset-bottom/.test(M));
ok('content is padded past the floating bar', /\.dash-main[^}]*padding-bottom:\s*calc\(/s.test(M));
ok('hover transforms are cancelled on touch', /:hover[^{]*\{[^}]*transform:\s*none/s.test(M));
ok('press feedback replaces hover', /:active[^{]*\{[^}]*transform:\s*scale\(\.98/s.test(M));
ok('no horizontal overflow', /overflow-x:\s*hidden/.test(M));
ok('a small-phone breakpoint exists', /@media \(max-width: 380px\)/.test(SRC));

// ── 7. PALETTE — grey/black kept, as the user required ─────────────────
console.log('\n[7] palette stays grey/black');
function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
  const l = (mx + mn) / 2;
  return { s: dl ? dl / (1 - Math.abs(2 * l - 1)) : 0, l };
}
const toks = [...SRC.matchAll(/(--(?:n|i)-[a-z0-9]+):\s*(#[0-9a-f]{6})/gi)];
ok('a full neutral ramp is declared', toks.length >= 9, `${toks.length}`);
for (const [, name, hex] of toks)
  ok(`${name} ${hex} is hueless`, hsl(hex).s <= 0.03, `sat=${hsl(hex).s.toFixed(3)}`);
for (const t of ['--st-ok', '--st-warn', '--st-danger'])
  ok(`${t} kept (status colour carries meaning)`, new RegExp(t + ':\\s*#').test(SRC));

// ── 8. CONTRAST ────────────────────────────────────────────────────────
console.log('\n[8] contrast');
function lum(hex) {
  const c = [1, 3, 5].map(i => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const tok = t => (new RegExp(t + ':\\s*(#[0-9a-f]{6})', 'i').exec(SRC) || [])[1];
for (const [label, a, b] of [
  ['primary ink on canvas', '--i-1', '--n-1'],
  ['secondary on canvas',   '--i-2', '--n-1'],
  ['tertiary on canvas',    '--i-3', '--n-1'],
  ['ink on bento card',     '--i-1', '--n-3'],
  ['CTA label on CTA',      '--n-acc-fg', '--n-acc'],
]) {
  const [x, y] = [tok(a), tok(b)];
  if (!x || !y) { ok(`${label} tokens exist`, false, `${a}=${x} ${b}=${y}`); continue; }
  const r = ratio(x, y);
  ok(`${label} passes AA`, r >= 4.5, `${r.toFixed(2)}:1`);
}

// ── 9. NOTHING REMOVED ─────────────────────────────────────────────────
console.log('\n[9] no feature removed');
ok('nova hides nothing', !/display:\s*none/.test(SRC));
ok('nova does not re-position anything', !/(^|\s)(position|float)\s*:/m.test(SRC));
for (const id of ['tab-jobs', 'wbSide', 'btnSideClose', 'bottomNav'])
  ok(`#${id} still in the shell`, !!d.getElementById(id));

console.log(`\ntest_nova_language: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
