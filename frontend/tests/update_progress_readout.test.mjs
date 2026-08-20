import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// `ui_automation.js` reads `window` while it loads, and both modules import
// siblings through versioned specifiers Node cannot resolve, so each is loaded
// as a rewritten data module with its imports replaced by test stubs.
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

const progressCalls = [];
globalThis.__updateProgressShell = {
  getHostApi: () => ({
    onUpdateDownloadProgress: (callback) => { globalThis.__updateProgressCallback = callback; },
  }),
};
globalThis.__updateProgressActions = {
  openAutomationProgress: (args) => progressCalls.push(["open", args]),
  updateAutomationProgress: (args) => progressCalls.push(["update", args]),
  closeAutomationProgress: (args) => progressCalls.push(["close", args]),
};
const { initUpdateProgressBridge } = await loadModule("../ui/shell/update_progress.js", [
  [/import \{ shell \} from "\.\/shell_context\.js\?v=[^"]+";/u, "const shell = globalThis.__updateProgressShell;"],
  [
    /import \{\s*closeAutomationProgress,\s*openAutomationProgress,\s*updateAutomationProgress,\s*\} from "\.\/ui_automation\.js\?v=[^"]+";/u,
    "const { closeAutomationProgress, openAutomationProgress, updateAutomationProgress } = globalThis.__updateProgressActions;",
  ],
]);
initUpdateProgressBridge();
const emitProgress = globalThis.__updateProgressCallback;

function callsFor(kind) {
  return progressCalls.filter(([type]) => type === kind).map(([, args]) => args);
}

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

test("the update download readout reports megabytes downloaded against the total", () => {
  progressCalls.length = 0;
  const totalBytes = 268435456;
  emitProgress({ phase: "start", version: "1.4.2", receivedBytes: 0, totalBytes });
  emitProgress({ phase: "progress", version: "1.4.2", receivedBytes: 67108864, totalBytes });

  const [opened] = callsFor("open");
  assert.equal(opened.countText, "0.0 MB / 256.0 MB");
  assert.equal(opened.total, totalBytes);

  const [updated] = callsFor("update");
  assert.equal(updated.countText, "64.0 MB / 256.0 MB");
  assert.equal(updated.completed, 67108864);
  assert.equal(updated.total, totalBytes);

  // The progress window renders what the two halves produce together.
  assert.equal(
    composeProgressCountText(updated.total, updated.completed, updated.countText),
    "64.0 MB / 256.0 MB (25.0%)"
  );
});

test("a download with no advertised length reports the megabytes received so far", () => {
  progressCalls.length = 0;
  emitProgress({ phase: "start", version: "1.4.2", receivedBytes: 0, totalBytes: 0 });
  emitProgress({ phase: "progress", version: "1.4.2", receivedBytes: 5242880, totalBytes: 0 });

  assert.equal(callsFor("open")[0].countText, "0.0 MB");
  assert.equal(callsFor("update")[0].countText, "5.0 MB");
});

test("verifying clears the size readout and the terminal phases close the window", () => {
  progressCalls.length = 0;
  emitProgress({ phase: "verifying", version: "1.4.2" });
  assert.equal(callsFor("update")[0].countText, "");
  assert.equal(callsFor("update")[0].total, 0);

  emitProgress({ phase: "done", version: "1.4.2" });
  emitProgress({ phase: "error", version: "1.4.2" });
  assert.equal(callsFor("close").length, 2);
});
