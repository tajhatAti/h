/* LANDING PAGE REDESIGN.
 *
 * The hero showed a fabricated "glass card" dashboard — invented UI with fake
 * rows (App / Status / Public URL) that no real screen ever renders. Invented
 * UI is what made the product read as a toy rather than a hosting service.
 * It is replaced by a real deploy transcript: install, start, poll, reply.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static", "landing.css"), "utf8");
const classic = fs.readFileSync(path.join(ROOT, "static", "classic.css"), "utf8");
const d = new JSDOM(html).window.document;

const results = [];
const check = (n, c, x) => {
  results.push([n, !!c]);
  console.log((c ? "\u2713 " : "\u2717 FAIL ") + n.padEnd(56) + (c ? "" : " \u2014 " + (x || "")));
};

// ---- the toy mockup is gone --------------------------------------------
check("fake glass-card mockup removed", !d.querySelector(".glass-card"));
check("no invented status rows remain", !/gc-row|gc-chip|gc-bar/.test(html));
check("classic.css no longer themes the landing page",
  !/^\s*\.(hero|glass-card|feat|sec-card)\b/m.test(classic));

// ---- replaced with something real --------------------------------------
const term = d.querySelector(".term-card");
check("hero shows a real deploy transcript", !!term);
check("transcript is described for screen readers",
  term && term.getAttribute("aria-label"));
const body = term ? term.textContent : "";
for (const token of ["codenest deploy", "installing", "bot started", "polling"]) {
  check(`transcript shows a real step: ${token}`, body.includes(token));
}
check("transcript shows honest uptime, not a fake metric", /uptime/.test(body));

// ---- structure ----------------------------------------------------------
check("how-it-works section exists", !!d.getElementById("how"));
check("three numbered steps", d.querySelectorAll(".step").length === 3);
check("features section exists", !!d.getElementById("features"));
check("six feature cards", d.querySelectorAll(".feat").length === 6);
check("closing call to action", !!d.querySelector(".cta-band"));

// ---- every nav target resolves -----------------------------------------
const targets = [...html.matchAll(/scrollToId\('([a-z-]+)'\)/g)].map(m => m[1]);
const dead = [...new Set(targets)].filter(t => !d.getElementById(t));
check("no nav link points at a removed section", dead.length === 0, dead.join(", "));

// ---- restraint ----------------------------------------------------------
check("no decorative gradients", !/linear-gradient|radial-gradient/.test(css));
check("gradient text effect neutralised", /\.grad \{[^}]*background: none/.test(css));
const shadows = (css.match(/box-shadow/g) || []).length;
check("no glow shadows", shadows === 0, String(shadows));
check("scale is token-driven", /--ln-accent:/.test(css) && /--ln-t-md:/.test(css));
const rawHex = [...new Set((css.slice(css.indexOf("/* ---------- shell"))
  .match(/#[0-9a-fA-F]{6}\b/g) || []).map(s => s.toLowerCase()))];
check("body styles use tokens, not raw hex", rawHex.length <= 1, rawHex.join(", "));

// ---- the app still boots ------------------------------------------------
for (const id of ["screen-landing", "screen-signup", "screen-signin",
                  "screen-dashboard", "tab-jobs"]) {
  check(`app screen intact: ${id}`, !!d.getElementById(id));
}
check("landing.css is loaded last so it wins",
  html.indexOf("landing.css") > html.indexOf("runspace-dark.css"));

const p = results.filter(r => r[1]).length, f = results.length - p;
console.log(`\n================ ${p} pass, ${f} fail ================`);
process.exit(f ? 1 : 0);
