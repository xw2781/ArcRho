import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dragSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_formula_bar_drag.js", import.meta.url),
  "utf8",
);
const barSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_formula_bar.js", import.meta.url),
  "utf8",
);
const anchorSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_formula_bar_anchor.js", import.meta.url),
  "utf8",
);
const excelSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_excel.js", import.meta.url),
  "utf8",
);
const entriesSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_entries.js", import.meta.url),
  "utf8",
);
const dfmCss = await readFile(new URL("../ui/method_pages/dfm/dfm.css", import.meta.url), "utf8");

const runtimeStub = `const summaryRuntime = {
  summaryFormulaBarVisibleKey: "",
  summaryFormulaBarDragPlacement: null,
  summaryFormulaBarDragSession: null,
  summaryFormulaBarContentKey: () => "content",
  scheduleSummaryFormulaBarValidationTooltipPosition: () => {},
};
const registerSummaryFunctions = (functions) => Object.assign(summaryRuntime, functions);
export { summaryRuntime };`;

const sharedLayoutUrl = new URL(
  "../ui/shared/components/formula_bar/formula_bar_layout.js",
  import.meta.url,
).href;
// The runtime import comes first in the module, so it is replaced first: both
// patterns start at an `import {`, and the layout one would otherwise swallow it.
const patched = dragSource
  .replace(
    /import \{[\s\S]*?\} from "\/ui\/method_pages\/dfm\/ratios_summary\/summary_runtime\.js\?v=[^"]*";/u,
    runtimeStub,
  )
  .replace(
    /import \{[\s\S]*?\} from "\/ui\/shared\/components\/formula_bar\/formula_bar_layout\.js\?v=[^"]*";/u,
    `import { clampFormulaBarWithinFrame, getFormulaBarContentWidth } from ${JSON.stringify(sharedLayoutUrl)};`,
  )
  .concat(
    "\nexport { applySummaryFormulaBarDragPlacement, clearSummaryFormulaBarDragPlacement,"
    + " syncSummaryFormulaBarDragPlacementTarget, wireSummaryFormulaBarDragHandle };\n",
  );

const PAGE_RECT = { left: 0, top: 40, right: 900, bottom: 540, width: 900, height: 500 };
globalThis.window = { innerWidth: 900, innerHeight: 600 };
globalThis.document = { documentElement: { clientWidth: 900, clientHeight: 600 }, getElementById: () => null };

const drag = await import(`data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`);
const runtime = drag.summaryRuntime;

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * A stand-in for the bar. `origin` is where `left: 0; top: 0` lands once the bar
 * is fixed: the viewport's corner normally, and the popped-out Ratios window's
 * corner when that window is the containing block.
 */
function buildBar({ contentWidth = 320, height = 24, origin = { x: 0, y: 0 }, left = 200, top = 100 } = {}) {
  const classes = new Set(["arFormulaBar", "dfmSummaryFormulaBar", "isOpen"]);
  const style = { left: `${left - origin.x}px`, top: `${top - origin.y}px`, width: `${contentWidth}px` };
  const bar = {
    style,
    offsetHeight: height,
    offsetWidth: contentWidth,
    measurements: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    querySelector: () => null,
    closest: (selector) => (selector === "#dfmRatiosPage" ? { getBoundingClientRect: () => PAGE_RECT } : null),
    getBoundingClientRect: () => {
      if (style.width === "max-content") {
        bar.measurements += 1;
        return rect(0, 0, contentWidth, height);
      }
      return rect(
        origin.x + (Number.parseFloat(style.left) || 0),
        origin.y + (Number.parseFloat(style.top) || 0),
        Number.parseFloat(style.width) || contentWidth,
        height,
      );
    },
  };
  return bar;
}

function buildHandle() {
  const listeners = new Map();
  return {
    dataset: {},
    listeners,
    captured: null,
    addEventListener: (type, handler) => listeners.set(type, handler),
    setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture() { this.captured = null; },
  };
}

function pointerEvent(clientX, clientY, extra = {}) {
  let prevented = false;
  return {
    pointerId: 1,
    button: 0,
    pointerType: "mouse",
    clientX,
    clientY,
    preventDefault: () => { prevented = true; },
    get defaultPrevented() { return prevented; },
    ...extra,
  };
}

function resetDragState() {
  runtime.summaryFormulaBarDragPlacement = null;
  runtime.summaryFormulaBarDragSession = null;
  runtime.summaryFormulaBarVisibleKey = "cell:r1,2";
}

test("the fx badge carries no tooltip", () => {
  assert.doesNotMatch(barSource, /attachArcrhoTooltip\(fxIcon/u);
  assert.match(barSource, /wireSummaryFormulaBarDragHandle\?\.\(el, el\.querySelector\("\.arFormulaBarFxIcon"\)\)/u);
});

test("pressing the badge without moving leaves the bar anchored", () => {
  resetDragState();
  const bar = buildBar();
  const handle = buildHandle();
  drag.wireSummaryFormulaBarDragHandle(bar, handle);

  const down = pointerEvent(240, 110);
  handle.listeners.get("pointerdown")(down);
  assert.equal(down.defaultPrevented, true, "the press never moves focus off an open edit session");
  handle.listeners.get("pointermove")(pointerEvent(242, 112));
  handle.listeners.get("pointerup")(pointerEvent(242, 112));

  assert.equal(runtime.summaryFormulaBarDragPlacement, null);
  assert.equal(bar.classList.contains("isDragPlaced"), false);
  assert.equal(handle.captured, null, "the pointer capture is released");
});

test("dragging the badge places the bar where it is dropped and keeps it there", () => {
  resetDragState();
  const bar = buildBar();
  const handle = buildHandle();
  drag.wireSummaryFormulaBarDragHandle(bar, handle);

  handle.listeners.get("pointerdown")(pointerEvent(240, 110));
  handle.listeners.get("pointermove")(pointerEvent(540, 490));
  assert.equal(bar.classList.contains("isDragging"), true);
  handle.listeners.get("pointerup")(pointerEvent(540, 490));

  // The bar started at (200, 100) and the pointer moved by (300, 380).
  assert.deepEqual(
    { left: runtime.summaryFormulaBarDragPlacement.left, top: runtime.summaryFormulaBarDragPlacement.top },
    { left: 500, top: 480 },
  );
  assert.equal(runtime.summaryFormulaBarDragPlacement.targetKey, "cell:r1,2");
  assert.equal(bar.style.left, "500px");
  assert.equal(bar.style.top, "480px");
  assert.equal(bar.classList.contains("isDragPlaced"), true, "the bar leaves the grid's scroll frame");
  assert.equal(bar.classList.contains("isDragging"), false, "only the gesture itself is 'dragging'");
  // Re-anchoring is now the placement's job, which is what tells the anchor
  // module to leave the bar alone.
  assert.equal(drag.applySummaryFormulaBarDragPlacement(bar), true);
  assert.equal(bar.style.left, "500px");
  assert.equal(bar.style.width, "320px", "the bar still sizes itself to what it shows");
});

test("a drop is kept inside the visible DFM page", () => {
  resetDragState();
  const bar = buildBar();
  const handle = buildHandle();
  drag.wireSummaryFormulaBarDragHandle(bar, handle);

  handle.listeners.get("pointerdown")(pointerEvent(240, 110));
  handle.listeners.get("pointermove")(pointerEvent(2400, 2100));
  handle.listeners.get("pointerup")(pointerEvent(2400, 2100));

  // page right 900 - width 320, and page bottom 540 - bar height 24.
  assert.equal(bar.style.left, "580px");
  assert.equal(bar.style.top, "516px");
});

test("a popped-out Ratios window is the dragged bar's coordinate space", () => {
  resetDragState();
  const bar = buildBar({ origin: { x: 60, y: 30 } });
  const handle = buildHandle();
  drag.wireSummaryFormulaBarDragHandle(bar, handle);

  handle.listeners.get("pointerdown")(pointerEvent(240, 110));
  handle.listeners.get("pointermove")(pointerEvent(540, 490));

  // The drop stays at the same point on screen, written against that window.
  assert.equal(bar.getBoundingClientRect().left, 500);
  assert.equal(bar.style.left, "440px");
  assert.equal(bar.style.top, "450px");
});

test("the placement belongs to one target and ends when the bar moves to another", () => {
  resetDragState();
  const bar = buildBar();
  const handle = buildHandle();
  drag.wireSummaryFormulaBarDragHandle(bar, handle);
  handle.listeners.get("pointerdown")(pointerEvent(240, 110));
  handle.listeners.get("pointermove")(pointerEvent(540, 490));
  handle.listeners.get("pointerup")(pointerEvent(540, 490));

  assert.equal(
    drag.syncSummaryFormulaBarDragPlacementTarget(bar, "cell:r1,2"),
    false,
    "staying on the same cell keeps the bar where the user put it",
  );
  assert.equal(drag.syncSummaryFormulaBarDragPlacementTarget(bar, "cell:r1,3"), true);
  assert.equal(runtime.summaryFormulaBarDragPlacement, null);
  assert.equal(bar.classList.contains("isDragPlaced"), false);
  assert.equal(drag.applySummaryFormulaBarDragPlacement(bar), false, "the anchor decides again");
});

test("the anchored path, showing, and hiding all know about a hand-placed bar", () => {
  assert.match(anchorSource, /function positionSummaryFormulaBar[\s\S]*?applySummaryFormulaBarDragPlacement\?\.\(barEl\)/u);
  assert.match(anchorSource, /function repositionSummaryFormulaBar[\s\S]*?applySummaryFormulaBarDragPlacement\?\.\(bar\)/u);
  assert.match(entriesSource, /syncSummaryFormulaBarDragPlacementTarget\?\.\(el, targetKey\)/u);
  assert.match(excelSource, /function hideSummaryFormulaBar[\s\S]*?clearSummaryFormulaBarDragPlacement\?\.\(el\)/u);
});

test("a hand-placed bar is fixed to the page and stays under its own tooltip", () => {
  assert.match(dfmCss, /\.dfmSummaryFormulaBar\.isDragPlaced \{\s*position: fixed;\s*z-index: 1600;/u);
  assert.match(dfmCss, /\.dfmSummaryFormulaBar \.arFormulaBarFxIcon \{\s*cursor: grab;/u);
  assert.match(dfmCss, /\.dfmSummaryFormulaBar\.isDragging \.arFormulaBarFxIcon \{\s*cursor: grabbing;/u);
  // The validation tooltip and the dataset list must still draw over the bar.
  assert.match(dfmCss, /\.dfmSummaryFormulaBarError \{[\s\S]*?z-index: 1700;/u);
  assert.match(dfmCss, /\.dfmDatasetAutocomplete \{[\s\S]*?z-index: 1750;/u);
});
