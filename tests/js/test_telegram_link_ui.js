/* Settings → Connect Telegram, the site half of the bot's identity gate.
 *
 * The bot now refuses any chat that is not bound to an account. That gate is
 * only usable if the site can actually hand out a code, so this pins the flow
 * a person walks: open Settings, get a code, see what to send, and have the
 * card flip once the BOT redeems it.
 *
 * The rule that matters most: the code is requested by an authenticated web
 * session. Nothing here may let the chat ask for its own code.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../');
const JS = fs.readFileSync(path.join(ROOT, 'static/pro.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'static/classic.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PROFILE = fs.readFileSync(path.join(ROOT, 'routes/profile.py'), 'utf8');
const PINGBOT = fs.readFileSync(path.join(ROOT, 'services/pingbot.py'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${e ? ' -> ' + e : ''}`)); };

const dom = new JSDOM(HTML, { pretendToBeVisual: true });
const d = dom.window.document;
d.querySelectorAll('link[rel=stylesheet]').forEach(l => l.remove());
const st = d.createElement('style'); st.textContent = CSS; d.head.appendChild(st);
global.window = dom.window; global.document = d;

function extract(name) {
  let start = JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('not found: ' + name);
  if (JS.slice(start - 6, start) === 'async ') start -= 6;
  let i = JS.indexOf('{', JS.indexOf('(', start)), depth = 0;
  for (let k = i; k < JS.length; k++) {
    if (JS[k] === '{') depth++;
    else if (JS[k] === '}') { depth--; if (!depth) return JS.slice(start, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const src = [
  'const calls = []; const toasts = []; let STATE = {linked:false};',
  'const CODE = {code:"482913", expires_in_min:10, bot_username:"CodeNestBot",' +
  ' instructions:"Send /link 482913"};',
  'function api(p, m){ calls.push([m||"GET", p]);' +
  '  if (p === "/profile/telegram") return Promise.resolve(STATE);' +
  '  if (p === "/profile/telegram/code") return Promise.resolve(CODE);' +
  '  if (p === "/profile/telegram/unlink") { STATE = {linked:false}; return Promise.resolve({}); }' +
  '  return Promise.reject(new Error("404")); }',
  'function toast(t){ toasts.push(t); }',
  'function setLoading(){}',
  'const opened = [], closed = [];',
  'function openModal(id){opened.push(id);const m=document.getElementById(id);if(m)m.classList.remove("hidden");}',
  'function closeModal(id){closed.push(id);const m=document.getElementById(id);if(m)m.classList.add("hidden");}',
  'let _tgPollTimer = null;',
  extract('refreshTelegramCard'),
  extract('manageTelegram'),
  extract('_tgPoll'),
  'return {refreshTelegramCard, manageTelegram, calls, toasts, opened, closed,' +
  ' setState:v=>{STATE=v;}, getState:()=>STATE};',
].join('\n');
const app = new dom.window.Function(src)();

(async () => {

// ── 1. the card ─────────────────────────────────────────────────────────
console.log('\n[1] Settings shows the connection state');
ok('the card exists in Settings', !!d.getElementById('tgChip'));
ok('with a button', !!d.getElementById('btnTelegram'));
ok('and the modal ships with the page', !!d.getElementById('tgModal'));

await app.refreshTelegramCard();
ok('an unlinked account says so',
   d.getElementById('tgChip').textContent === 'Not connected',
   d.getElementById('tgChip').textContent);
ok('the button invites you to connect',
   d.getElementById('btnTelegram').textContent === 'Connect Telegram');
// Someone messaging a bot that ignores them has no way to know why. Saying it
// here is the only place that costs nothing.
ok('and the card explains the bot will ignore you until you link',
   /ignore you until you link/.test(d.getElementById('tgMeta').textContent),
   d.getElementById('tgMeta').textContent);

app.setState({ linked: true, telegram_id: 111222333 });
await app.refreshTelegramCard();
ok('a linked account flips the chip',
   d.getElementById('tgChip').textContent === 'Connected');
ok('the chip is marked on, not just reworded',
   d.getElementById('tgChip').className.includes('on'));
ok('the chat id is shown, so you can tell WHICH Telegram is bound',
   /111222333/.test(d.getElementById('tgMeta').textContent),
   d.getElementById('tgMeta').textContent);
ok('and the button becomes Manage',
   d.getElementById('btnTelegram').textContent === 'Manage Telegram');

// ── 2. getting a code ───────────────────────────────────────────────────
console.log('[2] the code comes from the site, on request');
app.setState({ linked: false });
await app.manageTelegram();
const body = d.getElementById('tgModalBody');
ok('the modal opened', app.opened.includes('tgModal'));
ok('no code is shown before you ask',
   d.querySelector('.tg-code').textContent === '······',
   d.querySelector('.tg-code').textContent);
// Opening Settings must not mint a code — codes replace each other, so an
// idle visit would silently kill a code the user is mid-way through typing.
ok('merely opening the modal does not issue one',
   !app.calls.some(([m, p]) => p === '/profile/telegram/code'),
   JSON.stringify(app.calls));

const getBtn = [...body.querySelectorAll('button')].find(b => /Get my code/.test(b.textContent));
ok('there is a button to ask for one', !!getBtn);
await getBtn.onclick();
ok('the code is requested with POST, not GET',
   app.calls.some(([m, p]) => p === '/profile/telegram/code' && m === 'POST'),
   JSON.stringify(app.calls));
ok('the code is displayed', d.querySelector('.tg-code').textContent === '482913');
ok('the exact command to send is spelled out',
   /\/link 482913/.test(body.textContent), body.textContent.slice(0, 200));
ok('the bot handle is named', /@CodeNestBot/.test(body.textContent));
ok('and so is the expiry, so a stale code is not a mystery',
   /10 min/.test(body.textContent));
ok('the button offers a fresh one', /Get a new code/.test(getBtn.textContent));

// The bot username comes from an env var; it must not be parsed as markup.
ok('the instruction line is built with textContent',
   /step\.textContent =/.test(extract('manageTelegram')));
ok('the code element is too',
   /codeBox\.textContent = r\.code/.test(extract('manageTelegram')));

// ── 3. the card flips when the BOT redeems it ───────────────────────────
console.log('[3] the wait is handled, and bounded');
app.setState({ linked: true, telegram_id: 111222333 });
await new Promise(r => setTimeout(r, 5200));
ok('the modal closes once the bot links',
   app.closed.includes('tgModal'), app.closed.join(','));
ok('and the user is told', app.toasts.some(t => /connected/i.test(t)),
   app.toasts.join('|'));
const pollSrc = extract('_tgPoll');
ok('the poll is 5s, not sub-second', /5000/.test(pollSrc));
ok('it stops itself rather than running forever',
   /ticks > 60/.test(pollSrc), pollSrc.slice(0, 200));
ok('and clears any previous timer, so two opens do not double-poll',
   /if \(_tgPollTimer\) clearInterval\(_tgPollTimer\)/.test(pollSrc));

// ── 4. disconnecting ────────────────────────────────────────────────────
console.log('[4] disconnecting');
await app.manageTelegram();
const body2 = d.getElementById('tgModalBody');
ok('the linked view is different from the connect view',
   /Disconnect/.test(body2.textContent), body2.textContent.slice(0, 120));
ok('it says what disconnecting actually does',
   /stops the bot from deploying/.test(body2.textContent));
const offBtn = [...body2.querySelectorAll('button')].find(b => /Disconnect/.test(b.textContent));
ok('the disconnect button is styled as destructive',
   offBtn.className.includes('btn-danger'));
await offBtn.onclick();
ok('unlink is called', app.calls.some(([m, p]) => p === '/profile/telegram/unlink'));
ok('and the card goes back to not connected',
   d.getElementById('tgChip').textContent === 'Not connected');

// ── 5. the server contract this UI depends on ───────────────────────────
console.log('[5] the routes behind it');
ok('status route exists', /@router\.get\("\/profile\/telegram"\)/.test(PROFILE));
ok('code route exists', /@router\.post\("\/profile\/telegram\/code"\)/.test(PROFILE));
ok('unlink route exists', /@router\.post\("\/profile\/telegram\/unlink"\)/.test(PROFILE));
const CODEROUTE = /def telegram_link_code[\s\S]*?\n@router/.exec(PROFILE)[0];
ok('issuing a code needs a session',
   /get_current_user_and_session\(authorization\)/.test(CODEROUTE));
ok('and is rate limited, since codes replace each other',
   /rate_limit_custom\(/.test(CODEROUTE));
ok('the code is issued for the SESSION user, not an id from the request',
   /issue_code\(user\["id"\]\)/.test(CODEROUTE));

// The whole point: the bot cannot mint its own code.
ok('the bot never calls issue_code', !/issue_code/.test(PINGBOT));
ok('the bot only ever REDEEMS', /redeem_code/.test(PINGBOT));

console.log(`\ntest_telegram_link_ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
