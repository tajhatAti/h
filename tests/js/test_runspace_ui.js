/* RunSpace UI regressions:
 *   1. Typing in a NEW job's editor got wiped ~7s later — the jobs poll
 *      auto-selected an existing job because the guard was a 1500ms timer.
 *   2. index.html shipped a hardcoded ?v= stamp, so deploys served stale
 *      CSS/JS and fixes looked like they never shipped.
 *   3. Toolbar controls had drifted to different heights/fonts.
 *   4. The bottom nav overlapped RunSpace.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const js = fs.readFileSync(path.join(ROOT, "static", "pro.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static", "runspace-dark.css"), "utf8");
const appPy = fs.readFileSync(path.join(ROOT, "app.py"), "utf8");

const results = [];
const check = (n, c, x) => {
  results.push([n, !!c]);
  console.log((c ? "\u2713 " : "\u2717 FAIL ") + n.padEnd(58) + (c ? "" : " \u2014 " + (x || "")));
};

// ---- 1. new-job editor must not be stolen by polling -------------------
check("a persistent _composingNew flag exists", /let _composingNew = false;/.test(js));
check("'New' sets the flag", /_composingNew = true;/.test(js));
check("selecting an existing job clears it",
  /_selectedJobId = id;[\s\S]{0,120}?_composingNew = false;/.test(js));
check("a successful deploy clears it", /_jobDirty = false;\s*\n\s*_composingNew = false;/.test(js));
check("renderJobs refuses to auto-select while composing",
  /else if \(_composingNew \|\| Date\.now\(\) < _suppressAutoSelect\)/.test(js));
check("unsaved edits are never overwritten by a poll",
  /if \(cur && !_jobDirty\) \{ _showWorkspace\(cur\)/.test(js));

// ---- 2. cache busting ---------------------------------------------------
check("asset version derives from real file state", /def _asset_version\(\)/.test(appPy));
check("index.html is rewritten with the live stamp", /def _index_html\(\)/.test(appPy));
check("no hardcoded ?v= is served", !/FileResponse\(INDEX_FILE\)/.test(appPy));
check("HTML itself is sent no-cache", /Cache-Control": "no-cache, must-revalidate/.test(appPy));

// ---- 3. one consistent control size ------------------------------------
check("a single height token drives the toolbar", /--rs-ctl-h:\s*\d+px/.test(css));
const shared = css.match(/#tab-jobs \.rs-inp,\s*\n#tab-jobs \.rs-sel,\s*\n#tab-jobs \.rs-run-btn[\s\S]{0,400}?\}/);
check("inputs, select and buttons share one rule", !!shared);
check("shared rule sets height from the token",
  shared && /height:\s*var\(--rs-ctl-h\)/.test(shared[0]));
check("shared rule sets one radius", shared && /border-radius:\s*var\(--rs-ctl-r\)/.test(shared[0]));
check("shared rule sets one font-size", shared && /font-size:\s*var\(--rs-ctl-fs\)/.test(shared[0]));
check("language select no longer uses a different font",
  /#tab-jobs \.rs-sel \{[^}]*font-family:\s*inherit/.test(css));
check("GitHub field matches the other inputs",
  /#tab-jobs \.rs-gh \{[^}]*font-size:\s*var\(--rs-ctl-fs\)/.test(css));
check("icon buttons are square to the same token",
  /width:\s*var\(--rs-ctl-h\)\s*!important/.test(css));
check("bigger tap targets on mobile",
  /@media \(max-width: 760px\) \{\s*\n\s*#tab-jobs \{ --rs-ctl-h: 34px/.test(css));
check("toolbar wraps instead of overflowing", /#tab-jobs \.rs-ed-bar \{[^}]*flex-wrap:\s*wrap/.test(css));

// ---- 4. clean full-screen ----------------------------------------------
check("bottom nav hidden on RunSpace",
  /body\.rs-active \.bottom-nav \{ display: none !important; \}/.test(css));
check("bottom nav hidden on the Details page",
  /body\.rs-detail-open[\s\S]{0,240}?\.bottom-nav[\s\S]{0,240}?display:\s*none/.test(css));

const p = results.filter(r => r[1]).length, f = results.length - p;
console.log(`\n================ ${p} pass, ${f} fail ================`);
process.exit(f ? 1 : 0);
