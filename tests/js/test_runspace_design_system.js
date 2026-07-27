/* RUNSPACE DESIGN SYSTEM.
 *
 * "It doesn't feel minimal like GitHub" was a measurable problem, not taste.
 * runspace-dark.css used 12 font sizes (9.5/10/10.5/11/11.5/12/12.5/13/13.5/
 * 14/15/16), 7 radii and 25 colours. Values that are ALMOST the same never
 * line up, so the eye finds no pattern and it reads as messy. GitHub looks
 * calm despite dense data because everything derives from one small scale.
 *
 * This test locks that scale in so the drift cannot creep back.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const css = fs.readFileSync(path.join(ROOT, "static", "runspace-dark.css"), "utf8");

// Everything after the token block is the code that must USE the tokens.
const tokenEnd = css.indexOf("*/", css.indexOf("DESIGN TOKENS")) + 2;
const tokens = css.slice(0, css.indexOf("}", css.indexOf("--dur")) + 1);
const body = css.slice(css.indexOf("}", tokenEnd));

const results = [];
const check = (n, c, x) => {
  results.push([n, !!c]);
  console.log((c ? "\u2713 " : "\u2717 FAIL ") + n.padEnd(56) + (c ? "" : " \u2014 " + (x || "")));
};

// ---- the scale exists ---------------------------------------------------
for (const t of ["--bg", "--bg-2", "--bg-3", "--line", "--fg", "--fg-2", "--fg-3",
                 "--accent", "--ok", "--warn", "--danger",
                 "--t-xs", "--t-sm", "--t-md", "--t-lg",
                 "--r-sm", "--r-md", "--r-pill"]) {
  check(`token defined: ${t}`, new RegExp("\\" + t + ":\\s*[^;]+;").test(tokens));
}
check("tokens are literal, not self-referential",
  !/--(bg|fg|ok|warn|danger|accent)(-\d)?:\s*var\(/.test(tokens));

// ---- nothing bypasses the scale ----------------------------------------
const rawFonts = [...new Set((body.match(/font-size:\s*[0-9.]+px/g) || []))];
check("no hardcoded font sizes remain", rawFonts.length === 0, rawFonts.join(", "));

const rawRadii = [...new Set((body.match(/border-radius:\s*[0-9.]+px/g) || []))];
check("no hardcoded radii remain", rawRadii.length === 0, rawRadii.join(", "));

const rawHex = [...new Set((body.match(/#[0-9a-fA-F]{6}\b/g) || []).map(h => h.toLowerCase()))];
check("no hardcoded hex colours remain", rawHex.length === 0, rawHex.join(", "));

// ---- one accent, the rest are status only -------------------------------
const accentDefs = (tokens.match(/--(accent|ok|warn|danger):/g) || []).length;
check("exactly one brand accent + 3 status colours", accentDefs === 4, String(accentDefs));

// ---- restraint ----------------------------------------------------------
const gradients = (body.match(/linear-gradient|radial-gradient/g) || []).length;
check("at most one decorative gradient (loading skeleton)", gradients <= 1, String(gradients));
// Strip comments first — the rule explains WHY there is no gradient, and the
// word inside that comment must not count as a match.
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
check("progress bar is a flat fill, not a gradient+glow",
  !/\.rs-progress-fill \{[^}]*gradient/.test(noComments) &&
  !/\.rs-progress-fill \{[^}]*box-shadow/.test(noComments));

// ---- spacing on a 4px grid ---------------------------------------------
const offGrid = [...new Set((body.match(/\b(?:padding|margin):[^;!]*/g) || [])
  .flatMap(d => d.split(":")[1].trim().split(/\s+/))
  .filter(v => /^[0-9]+px$/.test(v))
  // 1px is a hairline rule, not spacing.
  .filter(v => v !== "1px" && parseInt(v, 10) % 4 !== 0))];
check("spacing sits on the 4px grid", offGrid.length === 0, offGrid.join(", "));

const p = results.filter(r => r[1]).length, f = results.length - p;
console.log(`\n================ ${p} pass, ${f} fail ================`);
process.exit(f ? 1 : 0);
