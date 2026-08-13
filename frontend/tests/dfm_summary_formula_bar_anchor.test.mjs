import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const anchorSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_formula_bar_anchor.js", import.meta.url),
  "utf8",
);

const runtimeStub = `const summaryRuntime = {
  SUMMARY_FORMULA_BAR_FRAME_INSET_PX: 14,
  SUMMARY_FORMULA_BAR_MIN_WIDTH_PX: 260,
  SUMMARY_FORMULA_BAR_ANCHOR_GAP_PX: 4,
  scheduleSummaryFormulaBarValidationTooltipPosition: () => {},
  isSummaryFormulaEditSessionActive: () => false,
  isSummaryFormulaBarInputEditing: () => false,
  isSummaryFormulaCommitPending: () => false,
  isUserEntryConfig: (config) => !!config,
  summaryRowMap: new Map([["r1", { averageType: "user_entry" }]]),
  updateSummaryFormulaBarForCell: () => {},
  refreshSummaryFormulaBar: () => {},
  hideSummaryFormulaBar: () => {},
  summaryFormulaBarHoverCell: null,
  summaryFormulaBarHoverKey: "",
  summaryFormulaBarWidthCache: null,
};
const registerSummaryFunctions = (functions) => Object.assign(summaryRuntime, functions);
export { summaryRuntime };`;

const sharedLayoutUrl = new URL(
  "../ui/shared/components/formula_bar/formula_bar_layout.js",
  import.meta.url,
).href;
const sharedLayoutSpecifier = new RegExp(
  '"/ui/shared/components/formula_bar/formula_bar_layout\\.js\\?v=[^"]*"',
  "u",
);
const patched = anchorSource
  .replace(sharedLayoutSpecifier, JSON.stringify(sharedLayoutUrl))
  .replace(
    /import \{[\s\S]*?\} from "\/ui\/method_pages\/dfm\/ratios_summary\/summary_runtime\.js\?v=[^"]*";/u,
    runtimeStub,
  )
  .concat(
    "\nexport { getSummaryFormulaBarAnchorCells, positionSummaryFormulaBar,"
    + " invalidateFormulaBarWidthCache as invalidateSummaryFormulaBarWidthCache,"
    + " repositionSummaryFormulaBar,"
    + " summaryFormulaBarTargetKey, toggleSummaryFormulaBarForCell,"
    + " updateSummaryFormulaBarHoverTarget, wireSummaryFormulaBarPointer };\n",
  );

globalThis.CSS = { escape: (value) => String(value) };
globalThis.document = { getElementById: () => null };

const anchor = await import(
  `data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`
);
const runtime = anchor.summaryRuntime;

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

// A 3x2 linked dynamic array anchored at row "r1", development column 2.
function buildRangeCells() {
  return [
    rect(300, 200, 60, 20), rect(360, 200, 60, 20), rect(420, 200, 60, 20),
    rect(300, 220, 60, 20), rect(360, 220, 60, 20), rect(420, 220, 60, 20),
  ].map((cellRect) => ({
    dataset: {
      excelRangeAnchorRowId: "r1",
      excelRangeAnchorCol: "2",
      excelRangeFormula: "='C:\\Folder\\[Book.xlsx]Sheet 1'!$A$1:$C$2",
    },
    getBoundingClientRect: () => cellRect,
  }));
}

function buildHost(overrides = {}) {
  return {
    getBoundingClientRect: () => rect(100, 150, 800, 400),
    clientWidth: 800,
    scrollLeft: 0,
    scrollTop: 40,
    scrollWidth: 2000,
    ...overrides,
  };
}

function buildTable(host, rangeCells) {
  return {
    closest: () => host,
    contains: () => true,
    querySelectorAll: () => rangeCells,
  };
}

// A stand-in for the bar element: it reports `contentWidth` only while the
// caller has lifted the pixel clamps to measure natural content width.
function buildBar({
  contentWidth = 320,
  editContentWidth = null,
  height = 24,
  inputText = null,
} = {}) {
  const style = {};
  const input = {
    style: { display: inputText === null ? "none" : "" },
    dataset: { rowId: "r1", col: "2" },
    value: inputText ?? "",
    // The typed text overflows the input's preferred size by 60px.
    scrollWidth: inputText ? 237 : 0,
    clientWidth: inputText ? 177 : 0,
  };
  const state = { hidden: true, textContent: "" };
  const bar = {
    style,
    input,
    state,
    isConnected: true,
    classList: { contains: (name) => name === "isOpen" },
    offsetHeight: height,
    measurements: 0,
    querySelector: (selector) => {
      if (selector === "#dfmSummaryFormulaBarInput") return input;
      if (selector === "#dfmSummaryFormulaBarState") return state;
      return null;
    },
    getBoundingClientRect: () => {
      if (style.width !== "max-content") return rect(0, 0, Number.parseFloat(style.width) || 0, height);
      bar.measurements += 1;
      const editing = input.style.display !== "none";
      const natural = editing && editContentWidth !== null ? editContentWidth : contentWidth;
      return rect(0, 0, state.hidden ? natural : natural + 60, height);
    },
  };
  return bar;
}

function resetRuntimeHoverState() {
  runtime.summaryFormulaBarHoverCell = null;
  runtime.summaryFormulaBarHoverKey = "";
  runtime.summaryFormulaBarVisibleKey = "";
  runtime.summaryFormulaBarSuppressedKey = "";
  runtime.isSummaryFormulaEditSessionActive = () => false;
  runtime.isSummaryFormulaBarInputEditing = () => false;
  runtime.isSummaryFormulaCommitPending = () => false;
  globalThis.document = { getElementById: () => null };
}

// A User Entry cell, optionally part of a linked dynamic array.
function buildUserEntryCell(rowId = "r1", col = 0, rangeAnchor = null) {
  const dataset = { r: rowId, col: String(col) };
  if (rangeAnchor) {
    dataset.excelRangeAnchorRowId = rangeAnchor.rowId;
    dataset.excelRangeAnchorCol = String(rangeAnchor.col);
    dataset.excelRangeFormula = "='C:\\Folder\\[Book.xlsx]Sheet 1'!$A$1:$C$2";
  }
  return { dataset, getBoundingClientRect: () => rect(300, 200, 60, 20) };
}

test("the formula bar anchors to every cell of a linked dynamic array", () => {
  const rangeCells = buildRangeCells();
  const summaryTable = buildTable(buildHost(), rangeCells);
  assert.equal(anchor.getSummaryFormulaBarAnchorCells(summaryTable, rangeCells[4]).length, 6);

  const plainCell = { dataset: {}, getBoundingClientRect: () => rect(300, 200, 60, 20) };
  assert.deepEqual(
    anchor.getSummaryFormulaBarAnchorCells(summaryTable, plainCell),
    [plainCell],
    "a cell outside any range anchors the bar to itself",
  );
});

test("the formula bar floats above its anchor in the scroll host's coordinate space", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const rangeCells = buildRangeCells();
  const host = buildHost();
  const barEl = buildBar({ contentWidth: 320 });
  anchor.positionSummaryFormulaBar(barEl, buildTable(host, rangeCells), rangeCells[4]);

  // The bar takes the width its content wants, not the width of the array.
  assert.equal(barEl.style.width, "320px");
  assert.equal(barEl.style.maxWidth, "320px", "the measuring clamps are restored");
  // left = anchor left 300 - host left 100 + scrollLeft 0
  assert.equal(barEl.style.left, "200px");
  // top = anchor top 200 - host top 150 + scrollTop 40 - bar 24 - gap 4
  assert.equal(barEl.style.top, "62px");
});

test("the formula bar never grows past the visible ratio frame", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const rangeCells = buildRangeCells();
  const host = buildHost();
  const barEl = buildBar({ contentWidth: 2000 });
  anchor.positionSummaryFormulaBar(barEl, buildTable(host, rangeCells), rangeCells[0]);

  // frame = clientWidth 800 - inset 14, and the bar starts at the frame's left edge.
  assert.equal(barEl.style.width, "786px");
  assert.equal(barEl.style.left, "0px");
});

test("the formula bar slides left instead of running past the frame's right edge", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const rightEdgeCell = {
    dataset: {},
    getBoundingClientRect: () => rect(800, 200, 60, 20),
  };
  const host = buildHost();
  const summaryTable = { closest: () => host, contains: () => true, querySelectorAll: () => [] };
  const barEl = buildBar({ contentWidth: 320 });
  anchor.positionSummaryFormulaBar(barEl, summaryTable, rightEdgeCell);

  assert.equal(barEl.style.width, "320px");
  // frame right 886 - width 320 = 566, then into host content coordinates.
  assert.equal(barEl.style.left, "466px");
});

test("the formula bar counts text the input scrolls past its own width", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const rangeCells = buildRangeCells();
  const host = buildHost();
  const barEl = buildBar({ contentWidth: 320, inputText: "= 'C:\\Folder\\[Book.xlsx]Sheet 1'!$A$1" });
  anchor.positionSummaryFormulaBar(barEl, buildTable(host, rangeCells), rangeCells[0]);

  // 320 natural + (scrollWidth 237 - clientWidth 177)
  assert.equal(barEl.style.width, "380px");
});

test("a reposition reuses the measured width until the content or the viewport changes", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const rangeCells = buildRangeCells();
  const summaryTable = buildTable(buildHost(), rangeCells);
  const barEl = buildBar({ contentWidth: 320 });

  anchor.positionSummaryFormulaBar(barEl, summaryTable, rangeCells[0]);
  anchor.positionSummaryFormulaBar(barEl, summaryTable, rangeCells[0]);
  assert.equal(barEl.measurements, 1, "scrolling and repositioning do not re-measure text");

  anchor.invalidateSummaryFormulaBarWidthCache();
  anchor.positionSummaryFormulaBar(barEl, summaryTable, rangeCells[0]);
  assert.equal(barEl.measurements, 2, "a viewport resize re-measures");

  barEl.state.hidden = false;
  barEl.state.textContent = "Validating…";
  anchor.positionSummaryFormulaBar(barEl, summaryTable, rangeCells[0]);
  assert.equal(barEl.measurements, 3, "showing the validating chip re-measures");
  assert.equal(barEl.style.width, "380px", "the bar makes room for the chip");
});

test("swapping to the rendered display re-measures so the formula is not clipped", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const cell = { dataset: {}, getBoundingClientRect: () => rect(300, 200, 60, 20) };
  const summaryTable = {
    closest: () => buildHost(),
    contains: () => true,
    querySelectorAll: () => [],
    querySelector: () => cell,
  };
  globalThis.document = { getElementById: () => null, querySelector: () => summaryTable };
  // The rendered display draws each reference as a padded pill, so it is wider
  // than the same formula as plain text in the input.
  const barEl = buildBar({ contentWidth: 460, editContentWidth: 300, inputText: "= 'Simple - 3'" });

  anchor.positionSummaryFormulaBar(barEl, summaryTable, cell);
  assert.equal(barEl.style.width, "360px", "edit mode: 300 natural + 60 of input overflow");

  // What Escape and a committed Enter both do: hide the input, show the display.
  barEl.input.style.display = "none";
  anchor.repositionSummaryFormulaBar(barEl);
  assert.equal(barEl.style.width, "460px", "display mode gets the width its pills need");

  globalThis.document = { getElementById: () => null };
});

test("the formula bar drops below its anchor when there is no room above", () => {
  anchor.invalidateSummaryFormulaBarWidthCache();
  const rangeCells = buildRangeCells();
  const host = buildHost({ getBoundingClientRect: () => rect(100, 195, 800, 400), scrollTop: 0 });
  const barEl = buildBar({ contentWidth: 320 });
  anchor.positionSummaryFormulaBar(barEl, buildTable(host, rangeCells), rangeCells[0]);

  // above = 200 - 195 - 24 - 4 = -23, so the bar uses the array's bottom edge instead.
  assert.equal(barEl.style.top, "49px");
});

test("hovering a linked dynamic array retargets the formula bar and releases it on exit", () => {
  resetRuntimeHoverState();
  const rangeCells = buildRangeCells();
  const summaryTable = buildTable(buildHost(), rangeCells);
  const plainCell = { dataset: {}, getBoundingClientRect: () => rect(300, 260, 60, 20) };
  const calls = [];
  runtime.updateSummaryFormulaBarForCell = (cell) => calls.push(`target:${rangeCells.indexOf(cell)}`);
  runtime.refreshSummaryFormulaBar = () => calls.push("release");

  anchor.updateSummaryFormulaBarHoverTarget(summaryTable, rangeCells[4]);
  anchor.updateSummaryFormulaBarHoverTarget(summaryTable, rangeCells[5]);
  anchor.updateSummaryFormulaBarHoverTarget(summaryTable, plainCell);

  assert.deepEqual(calls, ["target:4", "release"], "moving within one array does not re-render");
  assert.equal(runtime.summaryFormulaBarHoverCell, null);
});

test("hover never retargets the formula bar mid-edit", () => {
  resetRuntimeHoverState();
  const rangeCells = buildRangeCells();
  const summaryTable = buildTable(buildHost(), rangeCells);
  const calls = [];
  runtime.updateSummaryFormulaBarForCell = () => calls.push("target");
  runtime.refreshSummaryFormulaBar = () => calls.push("release");
  globalThis.document = { getElementById: () => ({}) };

  runtime.isSummaryFormulaBarInputEditing = () => true;
  anchor.updateSummaryFormulaBarHoverTarget(summaryTable, rangeCells[0]);
  runtime.isSummaryFormulaBarInputEditing = () => false;
  runtime.isSummaryFormulaCommitPending = () => true;
  anchor.updateSummaryFormulaBarHoverTarget(summaryTable, rangeCells[0]);
  runtime.isSummaryFormulaCommitPending = () => false;
  runtime.isSummaryFormulaEditSessionActive = () => true;
  anchor.updateSummaryFormulaBarHoverTarget(summaryTable, rangeCells[0]);

  assert.deepEqual(calls, []);
  resetRuntimeHoverState();
});

test("pointer tracking listens on the scroll host so the bar itself stays hoverable", () => {
  resetRuntimeHoverState();
  const rangeCells = buildRangeCells();
  const host = buildHost();
  const summaryTable = buildTable(host, rangeCells);
  const listeners = new Map();
  anchor.wireSummaryFormulaBarPointer(summaryTable, (target, type, handler, capture) => {
    assert.equal(target, host, "pointer tracking is wired on the scroll host, not the table");
    if (type === "mousedown") {
      assert.equal(capture, true, "the toggle runs before either mode selects the cell");
    }
    listeners.set(type, handler);
  });
  assert.deepEqual([...listeners.keys()].sort(), ["mousedown", "mouseleave", "mousemove"]);

  const calls = [];
  runtime.updateSummaryFormulaBarForCell = () => calls.push("target");
  runtime.refreshSummaryFormulaBar = () => calls.push("release");

  listeners.get("mousemove")({
    target: { closest: (selector) => (selector === "td.summaryCell" ? rangeCells[0] : null) },
  });
  // Pointing at the bar keeps the array target: the bar overlays the cells it edits.
  listeners.get("mousemove")({
    target: { closest: (selector) => (selector === "#dfmSummaryFormulaBar" ? {} : null) },
  });
  listeners.get("mouseleave")();

  assert.deepEqual(calls, ["target", "release"]);
  resetRuntimeHoverState();
});

test("a linked dynamic array is one toggle target, whichever of its cells is clicked", () => {
  const first = buildUserEntryCell("r1", 2, { rowId: "r1", col: 2 });
  const last = buildUserEntryCell("r2", 4, { rowId: "r1", col: 2 });
  assert.equal(anchor.summaryFormulaBarTargetKey(first), "range:r1,2");
  assert.equal(anchor.summaryFormulaBarTargetKey(last), anchor.summaryFormulaBarTargetKey(first));
  assert.equal(anchor.summaryFormulaBarTargetKey(buildUserEntryCell("r1", 3)), "cell:r1,3");
  assert.equal(anchor.summaryFormulaBarTargetKey(null), "");
});

// Stands in for the show/hide the real bar performs, so a test can drive the
// toggle the way a run of presses would.
function trackFormulaBarVisibility() {
  const shown = [];
  const hidden = [];
  runtime.updateSummaryFormulaBarForCell = (target) => {
    shown.push(target);
    if (runtime.summaryFormulaBarSuppressedKey === anchor.summaryFormulaBarTargetKey(target)) return;
    runtime.summaryFormulaBarVisibleKey = anchor.summaryFormulaBarTargetKey(target);
  };
  runtime.hideSummaryFormulaBar = () => {
    hidden.push(runtime.summaryFormulaBarVisibleKey);
    runtime.summaryFormulaBarVisibleKey = "";
  };
  return { shown, hidden };
}

test("pressing a User Entry cell toggles its formula bar off and back on", () => {
  resetRuntimeHoverState();
  const summaryTable = { contains: () => true };
  const cell = buildUserEntryCell("r1", 3);
  const { shown, hidden } = trackFormulaBarVisibility();

  // First press: nothing is showing yet, because selection happens afterwards.
  anchor.toggleSummaryFormulaBarForCell(summaryTable, cell);
  assert.deepEqual(shown, [cell]);
  assert.deepEqual(hidden, []);

  // Pressing the cell the bar is already showing hides it.
  anchor.toggleSummaryFormulaBarForCell(summaryTable, cell);
  assert.deepEqual(hidden, ["cell:r1,3"]);
  assert.equal(runtime.summaryFormulaBarSuppressedKey, "cell:r1,3");

  // Pressing it again brings it back.
  anchor.toggleSummaryFormulaBarForCell(summaryTable, cell);
  assert.equal(shown.length, 2);
  assert.equal(runtime.summaryFormulaBarSuppressedKey, "");
  resetRuntimeHoverState();
});

test("Edit mode re-selecting the cell mid-toggle cannot resurrect the bar", () => {
  resetRuntimeHoverState();
  const summaryTable = { contains: () => true };
  const cell = buildUserEntryCell("r1", 3);
  const { hidden } = trackFormulaBarVisibility();

  anchor.toggleSummaryFormulaBarForCell(summaryTable, cell);
  anchor.toggleSummaryFormulaBarForCell(summaryTable, cell);
  assert.deepEqual(hidden, ["cell:r1,3"]);

  // Both modes select the pressed cell from their own handlers after the toggle,
  // which re-runs the bar update for the very cell just toggled off.
  runtime.updateSummaryFormulaBarForCell(cell);
  assert.equal(runtime.summaryFormulaBarVisibleKey, "", "the suppressed target stays hidden");
  resetRuntimeHoverState();
});

test("pressing a different cell shows the bar rather than toggling it off", () => {
  resetRuntimeHoverState();
  const summaryTable = { contains: () => true };
  const shown = [];
  let hides = 0;
  runtime.updateSummaryFormulaBarForCell = (target) => shown.push(target);
  runtime.hideSummaryFormulaBar = () => { hides += 1; };
  runtime.summaryFormulaBarSuppressedKey = "cell:r1,3";
  runtime.summaryFormulaBarVisibleKey = "";

  const other = buildUserEntryCell("r1", 5);
  anchor.toggleSummaryFormulaBarForCell(summaryTable, other);
  assert.deepEqual(shown, [other]);
  assert.equal(hides, 0);
  assert.equal(runtime.summaryFormulaBarSuppressedKey, "", "moving on clears the toggled-off target");
  resetRuntimeHoverState();
});

test("pressing never toggles a non-User-Entry cell or interrupts an edit", () => {
  resetRuntimeHoverState();
  const summaryTable = { contains: () => true };
  let calls = 0;
  runtime.updateSummaryFormulaBarForCell = () => { calls += 1; };
  runtime.hideSummaryFormulaBar = () => { calls += 1; };

  anchor.toggleSummaryFormulaBarForCell(summaryTable, buildUserEntryCell("ratio", 3));
  assert.equal(calls, 0, "a row that is not a User Entry has no formula bar to toggle");

  runtime.isSummaryFormulaEditSessionActive = () => true;
  anchor.toggleSummaryFormulaBarForCell(summaryTable, buildUserEntryCell("r1", 3));
  assert.equal(calls, 0, "an open edit session outranks the toggle");
  resetRuntimeHoverState();
});
