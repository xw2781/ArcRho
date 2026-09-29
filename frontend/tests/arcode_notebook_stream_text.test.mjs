import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../ui/arcode/notebook-editor/stream-text.js", import.meta.url), "utf8");
const create = () => vm.runInNewContext(`${source}\ncreateNotebookStreamText()`);

test("tqdm updates redraw one line instead of concatenating progress bars", () => {
  const stream = create();
  assert.equal(stream.append("Processing:   0%|          | 0/25"), "Processing:   0%|          | 0/25");
  assert.equal(stream.append("\rProcessing:   4%|▍         | 1/25"), "Processing:   4%|▍         | 1/25");
  assert.equal(stream.append("\rProcessing: 100%|██████████| 25/25\n"), "Processing: 100%|██████████| 25/25\n");
});

test("carriage returns and Windows newlines can cross network chunks", () => {
  const stream = create();
  stream.append("Before\r");
  stream.append("\n0%\r");
  stream.append("50%");
  assert.equal(stream.append("\r100%\r\nAfter\n"), "Before\n100%\nAfter\n");
});

test("cursor overwrites preserve suffixes, padding clears old progress, and backspace moves left", () => {
  const stream = create();
  assert.equal(stream.append("abcdef\rXY"), "XYcdef");
  assert.equal(stream.append("\rDone  \nabc\bZ"), "Done  \nabZ");
});

test("saved output and arbitrarily split live output produce the same text", () => {
  const text = "Log\n\r0% 🚀\r50% 🚀\r100% 🚀\nComplete\n";
  const expected = create().append(text);
  const live = create();
  let actual;
  for (const character of text) actual = live.append(character);
  assert.equal(actual, expected);
  assert.equal(expected, "Log\n100% 🚀\nComplete\n");
});

test("normal output and separate stdout/stderr cursors remain independent", () => {
  const stdout = create();
  const stderr = create();
  assert.equal(stdout.append("first\nsecond\n"), "first\nsecond\n");
  stderr.append("0%");
  assert.equal(stderr.append("\r100%\n"), "100%\n");
  assert.equal(stdout.append("third"), "first\nsecond\nthird");
});

test("imported output uses the same renderer and renders markup as text", () => {
  const execution = readFileSync(new URL("../ui/arcode/notebook-editor/execution.js", import.meta.url), "utf8");
  const fn = execution.slice(execution.indexOf("function appendImportedOutputLine("), execution.indexOf("const IMPORTED_HTML_ALLOWED_TAGS"));
  const nodes = [];
  const context = vm.createContext({ document: { createElement: () => ({}) }, container: { appendChild: (node) => nodes.push(node) } });
  vm.runInContext(`${source}\n${fn}\nappendImportedOutputLine(container, 'out-error', '0%\\r100%\\n<script>text</script>');`, context);
  assert.equal(nodes[0].textContent, "100%\n<script>text</script>");
  assert.equal(nodes[0].innerHTML, undefined);
});
