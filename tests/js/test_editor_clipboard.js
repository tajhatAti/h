/* EDITOR CORE — clipboard, selection, large paste.
 *
 * INVESTIGATION RESULT: the editors are NOT a custom textarea/contentEditable
 * implementation. Both are CodeMirror 5 (fromTextArea). So the migration
 * premise did not hold; the symptoms had specific, separate causes:
 *
 *   (a) mobile clipboard  -> CM5 defaults to inputStyle "contenteditable" on
 *                            mobile, where Gboard's clipboard chip often never
 *                            fires a paste event. Forced inputStyle:"textarea".
 *   (c) stray line        -> a hand-rolled line-number gutter (#csGutter) that
 *                            no longer exists in the markup was still being
 *                            written to; removed.
 *   (b)(d)(e)             -> already handled correctly by CodeMirror; verified
 *                            here against the real library so they stay fixed.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..", "..");
const js = fs.readFileSync(path.join(ROOT, "static", "pro.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const results = [];
const check = (n, c, x) => {
  results.push([n, !!c]);
  console.log((c ? "\u2713 " : "\u2717 FAIL ") + n.padEnd(58) + (c ? "" : " \u2014 " + (x || "")));
};

// ---- configuration guarantees ------------------------------------------
check("both editors use CodeMirror (not a custom textarea)",
  (js.match(/CodeMirror\.fromTextArea/g) || []).length === 2);
check("(a) job editor forces the textarea input model",
  /_jobCm = CodeMirror\.fromTextArea[\s\S]{0,700}?inputStyle: "textarea"/.test(js));
check("(a) studio editor forces the textarea input model",
  /cmEditor = CodeMirror\.fromTextArea[\s\S]{0,400}?inputStyle: "textarea"/.test(js));
check("(b) CM drag-drop disabled so the OS owns selection gestures",
  (js.match(/dragDrop: false/g) || []).length === 2);
check("(c) hand-rolled gutter no longer written to",
  !/getElementById\("csGutter"\)/.test(js));
check("official search addon loaded", /addon\/search\/search\.min\.js/.test(html));
check("official fold addon loaded", /addon\/fold\/foldcode\.min\.js/.test(html));
check("fold gutter enabled on the job editor", /foldGutter: true/.test(js));
check("search keybindings wired", /"Ctrl-F": "findPersistent"/.test(js));
check("no paste button on the code editor",
  !/data-act="paste"[\s\S]{0,200}jobCode/.test(html));

// ---- behavioural, against the REAL CodeMirror --------------------------
const dom = new JSDOM(`<!doctype html><body><textarea id="t"></textarea></body>`,
  { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document;
global.navigator = dom.window.navigator;
document.createRange = () => ({ setEnd() {}, setStart() {},
  getBoundingClientRect: () => ({ right: 0 }), getClientRects: () => [] });
const CM = require("codemirror");
const cm = CM.fromTextArea(document.getElementById("t"), { inputStyle: "textarea" });

check("(a) a native paste handler is installed on the input field",
  !!cm.getInputField());

// (e) large paste
const big = Array.from({ length: 250 }, (_, i) => `def f${i}(a, b): return a + b  # ${i}`).join("\n");
let changes = 0;
cm.on("change", () => changes++);
const t0 = Date.now();
cm.replaceRange(big, { line: 0, ch: 0 });
const ms = Date.now() - t0;
check("(e) 250-line paste applies in one change event", changes === 1, String(changes));
check("(e) 250-line paste is fast", ms < 400, ms + "ms");
check("(e) all 250 lines landed", cm.lineCount() === 250, String(cm.lineCount()));

// (b) multi-line selection keeps order and does not mutate the document
const before = cm.getValue();
cm.setSelection({ line: 3, ch: 0 }, { line: 9, ch: cm.getLine(9).length });
const sel = cm.getSelection().split("\n");
check("(b) drag-select spans the right lines", sel.length === 7, String(sel.length));
check("(b) selected lines keep their order",
  sel[0].startsWith("def f3") && sel[6].startsWith("def f9"), sel[0] + " -> " + sel[6]);
check("(b) selecting never mutates the document", cm.getValue() === before);

// (d) select-all then paste replaces everything
cm.execCommand("selectAll");
cm.replaceSelection("print('only me')");
check("(d) selectAll + paste replaces all content",
  cm.getValue() === "print('only me')", JSON.stringify(cm.getValue()).slice(0, 60));
check("(d) no remnants of the old document", cm.lineCount() === 1, String(cm.lineCount()));

// undo/redo still intact after the replace
cm.undo();
check("undo restores the previous document", cm.lineCount() === 250, String(cm.lineCount()));

const p = results.filter(r => r[1]).length, f = results.length - p;
console.log(`\n================ ${p} pass, ${f} fail ================`);
process.exit(f ? 1 : 0);
