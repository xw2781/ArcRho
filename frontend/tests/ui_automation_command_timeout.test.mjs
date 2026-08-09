import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The module reads `window` while it is being evaluated, so the stub has to be in
// place before the import, and its two shell imports have to be cut away.
globalThis.window = { location: { origin: "http://localhost" } };

const automationSource = await readFile(new URL("../ui/shell/ui_automation.js", import.meta.url), "utf8");
const testableSource = automationSource
  .replace(/import \{ shell \} from "\.\/shell_context\.js\?v=[^"]+";/u, "const shell = {};")
  .replace(
    /import \{\s*captureActiveDfmContextForMacro,\s*reviewAndApplyCapturedMacroResult,\s*\} from "\.\.\/macro\/macro_window\.js\?v=[^"]+";/u,
    "const captureActiveDfmContextForMacro = () => {}; const reviewAndApplyCapturedMacroResult = () => {};",
  );
const { automationCommandTimeoutMs } = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`
);
delete globalThis.window;

test("an in-page automation wait is sized to the submitter's own budget", () => {
  // A 30s caller must not be reported as failed at a fixed 10s while its command
  // is still running - that is what made a slow dataset-table reload look broken.
  assert.equal(automationCommandTimeoutMs({ timeout_sec: 30 }), 28500);
  assert.equal(automationCommandTimeoutMs({ timeout_sec: 120 }), 118500);
  assert.equal(automationCommandTimeoutMs({ timeoutSec: 30 }), 28500);
});

test("the in-page wait ends before the submitter's own deadline", () => {
  // Otherwise both sides expire together and the caller reports the vaguer
  // server-side timeout instead of the shell's specific one.
  for (const budgetSec of [5, 15, 30, 90]) {
    assert.ok(automationCommandTimeoutMs({ timeout_sec: budgetSec }) < budgetSec * 1000);
  }
});

test("a missing or unusable budget falls back to the previous fixed wait", () => {
  assert.equal(automationCommandTimeoutMs({}), 10000);
  assert.equal(automationCommandTimeoutMs(undefined), 10000);
  assert.equal(automationCommandTimeoutMs({ timeout_sec: 0 }), 10000);
  assert.equal(automationCommandTimeoutMs({ timeout_sec: -5 }), 10000);
  assert.equal(automationCommandTimeoutMs({ timeout_sec: "not a number" }), 10000);
});

test("a budget smaller than the reply margin still leaves a usable wait", () => {
  assert.equal(automationCommandTimeoutMs({ timeout_sec: 0.5 }), 1000);
  assert.equal(automationCommandTimeoutMs({ timeout_sec: 1 }), 1000);
});

test("neither in-page automation path keeps a hard-coded wait", () => {
  const waits = automationSource.match(/Timed out waiting for (?:Project Instance|Task Designer)\.[^)]*\)[^)]*\)/gu);
  assert.equal(waits?.length, 2);
  for (const wait of waits) {
    assert.match(wait, /automationCommandTimeoutMs\(command\)/u);
  }
  assert.doesNotMatch(automationSource, /Timed out waiting for Project Instance\." \}\), 10000\)/u);
  assert.doesNotMatch(automationSource, /Timed out waiting for Task Designer\." \}\), 10000\)/u);
});
