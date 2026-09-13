import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The ratio chart window lists every average formula's value for the chart
// column on one shared axis and lets a click make that formula the selected
// one. The rows read a formula the way the summary table prints it.

const calcUrl = new URL("../ui/method_pages/dfm/dfm_ratio_calc.js", import.meta.url).href;
const { computeAverageForColumn, formatRatio } = await import(calcUrl);

const chartSource = (await readFile(
  new URL("../ui/method_pages/dfm/dfm_ratios_chart.js", import.meta.url),
  "utf8",
)).replaceAll("\r\n", "\n");

const summaryRowMap = new Map();
const selectedSummaryByCol = new Map();
const ratioStrikeSet = new Set();
const rows = [
  { id: "volume_all", label: "Volume - all", base: "volume", periods: "all" },
  { id: "simple_2", label: "Simple - last 2", base: "simple", periods: "2" },
  { id: "manual", label: "Judgement", averageType: "user_entry", values: [1.5, 1.25] },
];
const state = {
  model: {
    // Column 0 ratios: 2.0, 1.5, 1.2; column 1 ratios: 1.5 and 1.1.
    values: [[10, 20, 30], [20, 30, 33], [30, 36, null]],
    mask: [[1, 1, 1], [1, 1, 1], [1, 1, 0]],
    origin_labels: ["2021", "2022", "2023"],
  },
};
globalThis.__ratioChartStubs = {
  state,
  calcRatio: (a, b) => (a ? b / a : null),
  formatRatio,
  computeAverageForColumn,
  ratioStrikeSet,
  selectedSummaryByCol,
  ratioChartThresholdByCol: new Map(),
  ratioChartLowerThresholdByCol: new Map(),
  ratioChartLeftThresholdByCol: new Map(),
  summaryRowMap,
  buildSummaryRows: () => {
    summaryRowMap.clear();
    rows.forEach((row) => summaryRowMap.set(row.id, row));
    return rows;
  },
  getDfmDecimalPlaces: () => 4,
  buildExcludedSetForColumn: (_model, _col, _cfg, base) => base,
  isUserEntryConfig: (cfg) => cfg?.averageType === "user_entry",
  getUserEntryValueForCol: (cfg, col) => Number(cfg.values[col]),
};
const patched = chartSource.replace(
  /import \{([^}]*)\} from "\/ui\/[^"]*";/gu,
  (_match, names) => `const {${names}} = new Proxy(globalThis.__ratioChartStubs, { get: (t, k) => t[k] ?? (() => {}) });`,
);
const chart = await import(`data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`);

test("every average row is valued the way the summary table prints it", () => {
  selectedSummaryByCol.set(0, "simple_2");
  const listed = chart.buildRatioChartAverageRows(0);
  assert.deepEqual(listed.map((row) => [row.rowId, row.label, row.selected]), [
    ["volume_all", "Volume - all", false],
    ["simple_2", "Simple - last 2", true],
    ["manual", "Judgement", false],
  ]);
  assert.equal(listed[0].value.toFixed(4), (86 / 60).toFixed(4));
  assert.equal(listed[1].value.toFixed(4), "1.3500");
  assert.equal(listed[2].value, 1.5);

  // A struck ratio leaves the averages as it leaves the table.
  ratioStrikeSet.add("0,0");
  const struck = chart.buildRatioChartAverageRows(0);
  assert.equal(struck[0].value.toFixed(4), (66 / 50).toFixed(4));
  ratioStrikeSet.clear();

  // The first row stands in when no row was chosen for the column.
  selectedSummaryByCol.clear();
  assert.equal(chart.buildRatioChartAverageRows(1)[0].selected, true);
});

test("a column with nothing to average lists the formula without a value", () => {
  const empty = { model: { values: [[null]], mask: [[0]], origin_labels: ["2021"] } };
  globalThis.__ratioChartStubs.state.model = empty.model;
  try {
    const listed = chart.buildRatioChartAverageRows(0);
    assert.equal(listed[0].value, null);
    assert.equal(listed[1].value, null);
    assert.equal(listed[2].value, 1.5);
  } finally {
    globalThis.__ratioChartStubs.state.model = state.model;
  }
});

test("the shared axis pads the values and places each one by its share of the span", () => {
  const axis = chart.getRatioChartAverageAxis([1.2, null, 1.4, Number.NaN]);
  assert.equal(axis.min.toFixed(4), "1.1840");
  assert.equal(axis.max.toFixed(4), "1.4160");
  assert.equal(axis.position(1.3).toFixed(4), "50.0000");

  const flat = chart.getRatioChartAverageAxis([1.25, 1.25]);
  assert.ok(flat.min < 1.25 && flat.max > 1.25);
  assert.equal(flat.position(1.25).toFixed(4), "50.0000");

  assert.equal(chart.getRatioChartAverageAxis([null]), null);
});

test("an axis end within reach of a ratio the values stop at lands exactly on it", () => {
  // 1.02 to 1.08 pads to 1.0152 at the low end, which is inside a quarter of
  // the span of 1, so the axis starts at 1 itself and the line sits hard left.
  const near = chart.getRatioChartAverageAxis([1.02, 1.05, 1.08]);
  assert.equal(near.min, 1);
  assert.equal(near.position(1), 0);

  // A value sitting exactly on 1 is not padded past it either.
  assert.equal(chart.getRatioChartAverageAxis([1, 1.04, 1.08]).min, 1);
  // Nor is the top end when the values stop at 1 from below.
  const below = chart.getRatioChartAverageAxis([0.96, 0.98, 1]);
  assert.equal(below.max, 1);
  assert.equal(below.position(1), 100);

  // 1.2 to 1.4 is nowhere near 1, so the span stays where the values put it.
  const far = chart.getRatioChartAverageAxis([1.2, 1.4]);
  assert.equal(far.min.toFixed(4), "1.1840");

  // Zero is the end only for values that stop near it; values above 1 stop at 1.
  assert.equal(chart.getRatioChartAverageAxis([0.05, 0.4]).min, 0);
  assert.ok(chart.getRatioChartAverageAxis([4, 12]).min > 1);
  assert.equal(chart.getRatioChartAverageAxis([1, 15]).min, 1);
});

test("the gridline interval is a round figure at the scale the span calls for", () => {
  assert.equal(chart.niceAxisStep(0.013), 0.02);
  assert.equal(chart.niceAxisStep(0.004), 0.005);
  assert.equal(chart.niceAxisStep(0.7), 1);
  assert.equal(chart.niceAxisStep(3), 5);
  assert.equal(chart.niceAxisStep(12), 20);
  assert.equal(chart.niceAxisStep(0), 0);
});

test("the gridlines count off from 1 when the span holds it", () => {
  const axis = chart.getRatioChartAverageAxis([1.02, 1.05, 1.08]);
  const { step, decimals, ticks } = chart.buildRatioChartAxisTicks(axis, 600);
  assert.equal(step, 0.02);
  assert.equal(decimals, 2);
  assert.deepEqual(ticks.map((tick) => tick.value), [1, 1.02, 1.04, 1.06, 1.08]);
  // Every line lands where its own figure sits on the axis.
  assert.equal(ticks[2].position.toFixed(4), axis.position(1.04).toFixed(4));
});

test("a span nowhere near 1 counts off from a round figure near its middle", () => {
  const axis = chart.getRatioChartAverageAxis([1.2, 1.4]);
  const { step, ticks } = chart.buildRatioChartAxisTicks(axis, 600);
  assert.equal(step, 0.05);
  assert.deepEqual(ticks.map((tick) => tick.value), [1.2, 1.25, 1.3, 1.35, 1.4]);
  assert.equal(ticks.every((tick) => tick.position >= 0 && tick.position <= 100), true);

  // A span of whole units is ruled in whole units, and labelled without decimals.
  const wide = chart.buildRatioChartAxisTicks(chart.getRatioChartAverageAxis([1, 15]), 600);
  assert.equal(wide.step, 2);
  assert.equal(wide.decimals, 0);
  assert.deepEqual(wide.ticks.map((tick) => tick.value), [1, 3, 5, 7, 9, 11, 13, 15]);
});

test("a narrower window is ruled more coarsely so every line keeps its label", () => {
  const axis = chart.getRatioChartAverageAxis([1.02, 1.05, 1.08]);
  const wide = chart.buildRatioChartAxisTicks(axis, 900);
  const narrow = chart.buildRatioChartAxisTicks(axis, 200);
  assert.ok(wide.ticks.length > narrow.ticks.length);
  assert.ok(narrow.step > wide.step);
  // Whatever the width, no two labels are asked to share the same 72px.
  for (const { ticks } of [wide, narrow]) {
    assert.ok(ticks.length >= 2);
  }
  assert.deepEqual(chart.buildRatioChartAxisTicks(null, 600), { step: 0, decimals: 0, ticks: [] });
});

test("a click on a formula row goes through the summary cell selection", () => {
  assert.match(chartSource, /selectSummaryCell\(summaryTable, rowId, col\)/u);
  assert.match(chartSource, /dfmRatioChartAveragesList"\)\?\.addEventListener\("click"/u);
});

// The plot and the formula panel share the height under the header: the panel
// takes a share of it rather than a fixed strip, so it follows a window resize,
// and the splitter between them hands height from one to the other.
const dfmCss = (await readFile(
  new URL("../ui/method_pages/dfm/dfm.css", import.meta.url),
  "utf8",
)).replaceAll("\r\n", "\n");
const dfmHtml = (await readFile(
  new URL("../ui/method_pages/dfm/dfm.html", import.meta.url),
  "utf8",
)).replaceAll("\r\n", "\n");

function cssRule(className) {
  const match = dfmCss.match(new RegExp(`(^|\\n)\\s*\\.${className}\\s*\\{([^}]*)\\}`, "u"));
  return match ? match[2] : "";
}

function cssPixels(block, property) {
  const match = block.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`, "u"));
  return match ? Number(match[1]) : null;
}

test("the formula list fills the panel instead of a fixed strip", () => {
  const list = cssRule("dfmRatioChartAveragesList");
  assert.match(list, /flex:\s*1 1 auto/u);
  assert.match(list, /min-height:\s*0/u);
  assert.match(list, /overflow-y:\s*auto/u);
  // A capped list could not grow past its cap however tall the window became.
  assert.doesNotMatch(list, /max-height/u);

  const panel = cssRule("dfmRatioChartAverages");
  assert.match(panel, /flex:\s*0 0 var\(--dfm-ratio-averages-share, 40%\)/u);
  assert.match(panel, /display:\s*flex/u);
  assert.match(panel, /flex-direction:\s*column/u);
});

test("the panel leaves the plot the height it asks for, until the rows need it", () => {
  const panel = cssRule("dfmRatioChartAverages");
  const plot = cssRule("dfmRatioChartCanvasWrap");
  // Both panes measure border to border, so the arithmetic holds the real
  // space on screen rather than two content boxes plus their frames.
  assert.match(panel, /box-sizing:\s*border-box/u);
  assert.match(plot, /box-sizing:\s*border-box/u);

  // The cap keeps the plot's asked-for height and the gap between the panes
  // free, and names both rather than restating either as a number.
  assert.match(
    panel,
    /max-height:\s*calc\(100% - var\(--dfm-ratio-plot-min[^)]*\) - var\(--dfm-ratio-splitter-height[^)]*\)\)/u,
  );
  assert.match(panel, /min-height:\s*var\(--dfm-ratio-averages-min/u);

  // The plot takes whatever is left, down to nothing, so a window too short
  // for both minimums squeezes the plot instead of spilling out of the card.
  assert.match(plot, /min-height:\s*0;/u);
  const card = cssRule("dfmRatioChartModal .dfmModalCard");
  assert.match(card, /--dfm-ratio-plot-min:\s*140px/u);
  // The gap between the panes is the handle, so one value sizes both.
  assert.match(card, /--dfm-ratio-splitter-height:\s*\d+px/u);
  assert.match(cssRule("dfmRatioChartSplitter"), /height:\s*var\(--dfm-ratio-splitter-height/u);
});

test("the panel keeps ten formula rows on screen and fits the longest name", () => {
  assert.match(chartSource, /const RATIO_CHART_MIN_VISIBLE_ROWS = 10;/u);
  const settle = chartSource.slice(
    chartSource.indexOf("function settleRatioChartAveragesLayout"),
    chartSource.indexOf("function selectAverageRowFromChart"),
  );
  // A row's height, the panel around the list, and the longest name are all
  // read off the page, so no row height, panel frame, or name width is
  // restated here.
  assert.match(settle, /row\.getBoundingClientRect\(\)\.height/u);
  assert.match(settle, /panel\.getBoundingClientRect\(\)\.height - list\.clientHeight/u);
  assert.match(chartSource, /measureWidestAverageLabel\(list\)/u);
  // A shorter list reserves only the rows it has.
  assert.match(settle, /Math\.min\(rowCount, RATIO_CHART_MIN_VISIBLE_ROWS\)/u);
  assert.match(settle, /setProperty\("--dfm-ratio-averages-min", floor\)/u);
  assert.match(settle, /setProperty\("--dfm-ratio-averages-label-width", labelWidth\)/u);
  // Either one changing resizes the plot above and the track across, so what
  // was just drawn against the old room is drawn again against the new.
  assert.match(settle, /scheduleRatioChartRender\(\)/u);
  assert.match(chartSource, /settleRatioChartAveragesLayout\(list, rows\.length\)/u);

  // The name is measured, never the box around it: a box wider than its text
  // reports its own width, which would hold the column where it already was
  // and grow it by the air on every render.
  const measure = chartSource.slice(
    chartSource.indexOf("function measureWidestAverageLabel"),
    chartSource.indexOf("function settleRatioChartAveragesLayout"),
  );
  assert.match(measure, /range\.selectNodeContents\(label\)/u);
  assert.match(measure, /range\.getBoundingClientRect\(\)\.width/u);
  assert.doesNotMatch(measure, /scrollWidth|offsetWidth|clientWidth/u);

  // Bold text is wider, so every name is measured at the selected row's weight
  // and the column cannot step out as the selection reaches the longest name.
  assert.match(measure, /list\.classList\.add\("measuring"\)/u);
  assert.match(measure, /list\.classList\.remove\("measuring"\)/u);
  // One declaration serves both, so the measured weight cannot drift from the
  // drawn one.
  assert.match(
    dfmCss,
    /\.dfmRatioChartAverageRow\.selected \.dfmRatioChartAverageLabel,\n\.dfmRatioChartAveragesList\.measuring \.dfmRatioChartAverageLabel \{\n\s*font-weight: 700;/u,
  );

  // The stylesheet owns the cap that keeps a long name off the track.
  const columns = cssRule("dfmRatioChartAverageRow,\\s*\\n\\.dfmRatioChartAveragesAxis");
  assert.match(columns, /min\(var\(--dfm-ratio-averages-label-width, 160px\), 45%\)/u);
});

test("the splitter sits between the two panes and captures its pointer", () => {
  assert.match(
    dfmHtml,
    /dfmRatioChartCanvasWrap[\s\S]*dfmRatioChartSplitter[\s\S]*dfmRatioChartAverages"/u,
  );
  assert.match(dfmHtml, /id="dfmRatioChartSplitter"[^>]*role="separator"/u);
  assert.match(cssRule("dfmRatioChartSplitter"), /cursor:\s*row-resize/u);

  // A drag tracked on the document loses the gesture the moment the pointer
  // outruns hit testing, so the handle captures the pointer itself.
  const splitterWiring = chartSource.slice(chartSource.indexOf("const parts = getRatioChartSplitParts(card)"));
  assert.match(splitterWiring, /splitter\.setPointerCapture\(e\.pointerId\)/u);
  for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    assert.match(splitterWiring, new RegExp(`splitter\\.addEventListener\\("${type}"`, "u"));
  }
  assert.doesNotMatch(splitterWiring, /document\.addEventListener\("pointermove"/u);
});

test("the splitter reads its bounds back from the stylesheet and stores a share", () => {
  const setter = chartSource.slice(
    chartSource.indexOf("function setRatioChartAveragesHeight"),
    chartSource.indexOf("// The first drag or resize"),
  );
  assert.match(setter, /getComputedStyle\(averages\)\.minHeight/u);
  assert.match(setter, /getPropertyValue\("--dfm-ratio-plot-min"\)/u);
  assert.match(setter, /ratioChartAveragesShare = bounded \/ span/u);
  assert.match(setter, /scheduleRatioChartRender\(\)/u);
});
