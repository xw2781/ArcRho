import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../ui/method_pages/dfm/dfm_ratio_drag_tracker.js", import.meta.url),
  "utf8",
);
const ratiosTabSource = await readFile(
  new URL("../ui/method_pages/dfm/dfm_ratios_tab.js", import.meta.url),
  "utf8",
);
const summaryInteractionsSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_interactions.js", import.meta.url),
  "utf8",
);
const trackerModule = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("a ratio cell is visited at most once during one drag gesture", () => {
  const tracker = trackerModule.createRatioDragVisitTracker();

  assert.equal(tracker.visit("1,2"), true);
  assert.equal(tracker.visit("1,3"), true);
  assert.equal(tracker.visit("1,2"), false);
  assert.equal(tracker.visit("1,3"), false);
});

test("a new ratio drag gesture can visit the same cells again", () => {
  const tracker = trackerModule.createRatioDragVisitTracker();

  assert.equal(tracker.visit("2,4"), true);
  tracker.reset();
  assert.equal(tracker.visit("2,4"), true);
});

test("the Ratios edit-mode drag uses the single-visit tracker", () => {
  assert.match(ratiosTabSource, /const dragVisits = createRatioDragVisitTracker\(\)/u);
  assert.match(ratiosTabSource, /if \(!dragVisits\.visit\(key\)\) return;\s+toggleStrike\(cell\)/u);
  assert.match(ratiosTabSource, /dragVisits\.reset\(\)/u);
});

test("the Ratios summary-table drag uses the single-visit tracker", () => {
  assert.match(summaryInteractionsSource, /const dragVisits = createRatioDragVisitTracker\(\)/u);
  assert.match(summaryInteractionsSource, /if \(!dragVisits\.visit\(key\)\) return;\s+setActiveCell\(cell, true\)/u);
  assert.match(summaryInteractionsSource, /dragVisits\.reset\(\)/u);
});
