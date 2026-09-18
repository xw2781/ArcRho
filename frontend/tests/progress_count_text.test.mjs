import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// `ui_automation.js` reads `window` while it loads and imports siblings through
// versioned specifiers Node cannot resolve, so it is loaded as a rewritten data
// module with its imports replaced by test stubs.
async function loadModule(relativePath, replacements) {
  let source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const [pattern, replacement] of replacements) {
    assert.match(source, pattern, `expected ${relativePath} to still import ${pattern}`);
    source = source.replace(pattern, replacement);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

globalThis.window = { location: { origin: "http://localhost" } };
const { composeProgressCountText } = await loadModule("../ui/shell/ui_automation.js", [
  [/import \{ shell \} from "\.\/shell_context\.js\?v=[^"]+";/u, "const shell = {};"],
  [
    /import \{\s*captureActiveDfmContextForMacro,\s*reviewAndApplyCapturedMacroResult,\s*\} from "\.\.\/macro\/macro_window\.js\?v=[^"]+";/u,
    "const captureActiveDfmContextForMacro = () => null; const reviewAndApplyCapturedMacroResult = () => null;",
  ],
  [
    /import \{ createReviewTableDialog \} from "\.\.\/shared\/components\/review_table\/review_table\.js\?v=[^"]+";/u,
    "const createReviewTableDialog = () => null;",
  ],
]);
delete globalThis.window;

test("a known progress total keeps the shared percentage after the caller's own value text", () => {
  assert.equal(composeProgressCountText(200, 50, "50.0 MB / 200.0 MB"), "50.0 MB / 200.0 MB (25.0%)");
});

test("a caller that supplies no value text still gets the item count and percentage", () => {
  assert.equal(composeProgressCountText(8, 2), "2 / 8 (25.0%)");
  assert.equal(composeProgressCountText(8, 2, ""), "2 / 8 (25.0%)");
});

test("an unknown progress total shows the caller's text alone with no percentage", () => {
  assert.equal(composeProgressCountText(0, 12345, "11.8 MB"), "11.8 MB");
  assert.equal(composeProgressCountText(0, 3), "");
});
