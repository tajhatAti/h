/* Regression guard: the whole site once had a warm/orange cast on every box
   and button. It was never a per-button rule — the classic.css palette itself
   was warm (--panel #fffdf7, --line-2 #c9bfa4 ... hue ~44°, sat ~0.3), and
   .btn-secondary/.btn-ghost/cards/inputs all resolve to those tokens.
   This test computes real colours through jsdom and fails if any core token
   or rendered control drifts back into the 10–60° hue band. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const R = path.resolve(__dirname, '../../');
const ORDER = ['pro.css','emoji.css','classic.css','workbench.css',
               'codestudio.css','terminal.css','runspace-dark.css','landing.css'];

function build(theme) {
  const css = ORDER.map(f => fs.readFileSync(path.join(R,'static',f),'utf8')).join('\n');
  const dom = new JSDOM(fs.readFileSync(path.join(R,'index.html'),'utf8'),
                        { pretendToBeVisual: true });
  const d = dom.window.document;
  d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
  const st = d.createElement('style'); st.textContent = css; d.head.appendChild(st);
  if (theme) d.documentElement.setAttribute('data-theme', theme);
  return dom;
}

function rgb(s) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || '');
  if (m) return [+m[1], +m[2], +m[3]];
  if (s && s.startsWith('#') && s.length >= 7)
    return [1,3,5].map(i => parseInt(s.slice(i, i+2), 16));
  return null;
}
function hsl(c) {
  const [r,g,b] = c.map(x => x/255);
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b), dl = mx - mn;
  if (!dl) return { h:0, s:0, l:(mx+mn)/2 };
  let h = mx===r ? ((g-b)/dl)%6 : mx===g ? (b-r)/dl+2 : (r-g)/dl+4;
  h *= 60; if (h < 0) h += 360;
  const l = (mx+mn)/2;
  return { h, s: dl/(1-Math.abs(2*l-1)), l };
}
/* "warm cast" = orange/amber/cream hue with enough saturation to be visible.
   Status amber (#d29922) is deliberate and lives on .warn/.installing dots,
   never on a token below, so it is not caught here. */
function isWarm(c) {
  if (!c) return false;
  const { h, s, l } = hsl(c);
  return h >= 10 && h <= 60 && s > 0.22 && l > 0.12;
}

const TOKENS = ['--panel','--paper','--paper-2','--line','--line-2',
                '--acc','--acc-ink','--btn','--btn-fg','--ink','--ink-2',
                '--muted','--code-bg','--band','--cream'];
const CONTROLS = ['.btn-primary','.btn-secondary','.btn-ghost','.cs-act',
                  'input','.stat-card','.quick-card','.dash-tab'];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

for (const theme of [null, 'dark']) {
  const label = theme || 'light';
  const dom = build(theme);
  const d = dom.window.document;
  const root = dom.window.getComputedStyle(d.documentElement);

  for (const t of TOKENS) {
    const v = root.getPropertyValue(t).trim();
    if (!v) continue;
    ok(`[${label}] token ${t}`, !isWarm(rgb(v)), v);
  }
  for (const sel of CONTROLS) {
    const el = d.querySelector(sel);
    if (!el) continue;
    const cs = dom.window.getComputedStyle(el);
    for (const prop of ['backgroundColor','borderTopColor','color']) {
      ok(`[${label}] ${sel}.${prop}`, !isWarm(rgb(cs[prop])), cs[prop]);
    }
  }
}

console.log(`\ntest_no_warm_cast: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
