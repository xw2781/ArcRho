import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const referenceSource = await readFile(
  new URL("../ui/shared/integrations/excel_reference.js", import.meta.url),
  "utf8",
);
const referenceUrl = `data:text/javascript;base64,${Buffer.from(referenceSource).toString("base64")}`;
let modelSource = await readFile(
  new URL("../ui/method_pages/dfm/dfm_external_links_model.js", import.meta.url),
  "utf8",
);
modelSource = modelSource.replace(
  '"/ui/shared/integrations/excel_reference.js?v=20260715a"',
  JSON.stringify(referenceUrl),
);
const linkModel = await import(
  `data:text/javascript;base64,${Buffer.from(modelSource).toString("base64")}`
);
const summarySource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_excel.js", import.meta.url),
  "utf8",
);
const summaryValidationSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_excel_validation.js", import.meta.url),
  "utf8",
);
const summaryEntriesSource = await readFile(
  new URL("../ui/method_pages/dfm/ratios_summary/summary_entries.js", import.meta.url),
  "utf8",
);
const dfmCssSource = await readFile(
  new URL("../ui/method_pages/dfm/dfm.css", import.meta.url),
  "utf8",
);

function sourceSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return text.slice(start, end);
}

function createExcelFreshnessHarness(rows, readExcelCellsBatch) {
  const cancelSource = sourceSlice(
    summaryValidationSource,
    "function cancelDfmExcelFreshnessCheck",
    "function canonicalExcelComparisonValue",
  );
  const canonicalSource = sourceSlice(
    summaryValidationSource,
    "function canonicalExcelComparisonValue",
    "function excelFreshnessSourceKey",
  );
  const sourceKeySource = sourceSlice(
    summaryValidationSource,
    "function excelFreshnessSourceKey",
    "export async function checkDfmExcelLinkFreshness",
  );
  const checkSource = sourceSlice(
    summaryValidationSource,
    "async function checkDfmExcelLinkFreshness",
    "registerSummaryFunctions(",
  );
  const factory = new Function("deps", `
    "use strict";
    const summaryRuntime = {
      _dfmExcelFreshnessGeneration: 0,
      _dfmExcelFreshnessAbortController: null,
    };
    const {
      summaryRowConfigs,
      readExcelCellsBatch,
      document,
    } = deps;
    const isUserEntryConfig = (cfg) => cfg?.averageType === "user_entry";
    const getCurrentRatioColumnCount = () => Math.max(
      0,
      ...summaryRowConfigs.map((cfg) => Array.isArray(cfg?.inputs) ? cfg.inputs.length : 0),
    );
    const containsExcelRef = (value) => String(value || "").includes("XL_");
    const parseStandaloneExcelRange = () => null;
    const buildExcelRangeSourceCells = () => [];
    const getDfmExternalLinkRangeTargets = () => [];
    const getUserEntryValueForCol = (cfg, col) => Number(cfg?.values?.[col]);
    const findExcelRefsInline = (value) => Array.from(
      String(value || "").matchAll(/XL_([A-Z])/g),
      (match) => ({
        match: match[0],
        bookPath: "C:\\\\Data\\\\Book.xlsx",
        sheet: "Sheet1",
        cell: match[1] + "1",
      }),
    );
    const evaluateSimpleMathExpression = (value) => Number(String(value || "").replace(/^=/, ""));
    const buildSummaryReferenceValues = () => new Map();
    const invalidTargets = { value: new Map() };
    const dfmExcelInvalidTargetKey = (rowId, col) => String(rowId) + "\u001f" + Number(col);
    const dfmTargetDestinationLabel = (rowId, col) => String(rowId) + " / " + String(col);
    const currentRatioHeaderLabels = () => [];
    const setDfmExcelInvalidTargets = (next) => { invalidTargets.value = next; };
    const clearDfmExcelLinkFailures = () => { invalidTargets.value = new Map(); };
    ${cancelSource}
    ${canonicalSource}
    ${sourceKeySource}
    ${checkSource}
    return { checkDfmExcelLinkFreshness, cancelDfmExcelFreshnessCheck, invalidTargets };
  `);
  return factory({
    summaryRowConfigs: rows,
    readExcelCellsBatch,
    document: { querySelector: () => null },
  });
}

const SOURCE_A = "'C:\\Data\\[Book.xlsx]Sheet 1'!A1";
const SOURCE_B = "'D:\\Inputs\\[Other.xlsm]Ratios'!B2";
const SOURCE_RANGE = "'C:\\Data\\[Book.xlsx]Sheet 1'!A1:B2";
const isUserEntry = (row) => row?.averageType === "user_entry";

function collect(rows, columnCount = 3) {
  return linkModel.collectDfmExternalLinkGroups({ rows, columnCount, isUserEntry });
}

test("groups repeated DFM consumers while retaining multi-reference cells", () => {
  const rows = [{
    id: "user-1",
    label: "User Entry",
    averageType: "user_entry",
    inputs: [`=${SOURCE_A} + ${SOURCE_B}`, `=${SOURCE_A}`],
    values: [3, 4],
  }];

  const groups = Array.from(collect(rows).values());
  assert.equal(groups.length, 2);
  const bookGroup = groups.find((group) => group.reference.bookPath.endsWith("Book.xlsx"));
  const otherGroup = groups.find((group) => group.reference.bookPath.endsWith("Other.xlsm"));
  assert.equal(bookGroup.consumers.size, 2);
  assert.deepEqual(
    Array.from(bookGroup.targets.values()).map(({ rowId, col }) => ({ rowId, col })),
    [{ rowId: "user-1", col: 0 }, { rowId: "user-1", col: 1 }],
  );
  assert.equal(otherGroup.consumers.size, 1);
  assert.deepEqual(
    Array.from(otherGroup.targets.values()).map(({ rowId, col }) => ({ rowId, col })),
    [{ rowId: "user-1", col: 0 }],
  );
});

test("expands standalone DFM ranges across User Entry rows and columns", () => {
  const rows = [
    {
      id: "user-1",
      averageType: "user_entry",
      inputs: [`=${SOURCE_RANGE}`, "2"],
      values: [1, 2],
    },
    {
      id: "user-2",
      averageType: "user_entry",
      inputs: ["3", "4"],
      values: [3, 4],
    },
  ];

  const [group] = collect(rows, 2).values();
  assert.deepEqual(
    Array.from(group.targets.values()).map(({ rowId, col }) => ({ rowId, col })),
    [
      { rowId: "user-1", col: 0 },
      { rowId: "user-1", col: 1 },
      { rowId: "user-2", col: 0 },
      { rowId: "user-2", col: 1 },
    ],
  );
  assert.equal(linkModel.getDfmExternalLinkHardCodeTargets({
    group,
    rows,
    columnCount: 2,
    isUserEntry,
  }).size, 4);
});

test("discovers legacy DFM formulas arrays", () => {
  const rows = [{
    id: "legacy",
    averageType: "user_entry",
    formulas: [`=${SOURCE_A}`],
    values: [7],
  }];

  const [group] = collect(rows).values();
  assert.ok(group);
  assert.equal(group.consumers.size, 1);
  assert.deepEqual(
    Array.from(group.targets.values()).map(({ rowId, col }) => ({ rowId, col })),
    [{ rowId: "legacy", col: 0 }],
  );
});

test("an invalidated DFM spill still exposes an anchor target that can be hard-coded", () => {
  const rows = [
    {
      id: "user-1",
      averageType: "user_entry",
      inputs: ["1", `=${SOURCE_RANGE}`],
      values: [1, 9],
    },
    { id: "simple", averageType: "simple", inputs: [], values: [] },
  ];

  const [group] = collect(rows, 1).values();
  const targets = linkModel.getDfmExternalLinkHardCodeTargets({
    group,
    rows,
    columnCount: 1,
    isUserEntry,
  });

  assert.deepEqual(
    Array.from(targets.values()).map(({ rowId, col }) => ({ rowId, col })),
    [{ rowId: "user-1", col: 1 }],
  );
});

test("a DFM spill does not skip across a non-User Entry row", () => {
  const rows = [
    {
      id: "user-1",
      averageType: "user_entry",
      inputs: ["='C:\\Data\\[Book.xlsx]Sheet 1'!A1:A3"],
      values: [1],
    },
    { id: "simple", averageType: "simple", inputs: [], values: [] },
    { id: "user-2", averageType: "user_entry", inputs: ["3"], values: [3] },
  ];

  const [group] = collect(rows, 1).values();

  assert.deepEqual(
    Array.from(group.targets.values()).map(({ rowId, col }) => ({ rowId, col })),
    [{ rowId: "user-1", col: 0 }],
  );
});

test("DFM break integrates target hard-coding with persistence, rerender, and dirty state", () => {
  assert.match(summarySource, /getDfmExternalLinkHardCodeTargets\(/u);
  assert.match(summarySource, /hardCodeTargets\.forEach[\s\S]*hardCodeDfmUserEntryTarget/u);
  assert.match(summarySource, /export function breakDfmExternalLinks\(ids\)/u);
  assert.match(summarySource, /persistUserEntryRowsFromState\(\);[\s\S]*_renderRatioTable\(\);[\s\S]*_onRatioStateMutated\(\);/u);
});

test("DFM Links records expose value previews and selected refresh scope", () => {
  assert.match(
    summarySource,
    /value:\s*start !== end \? `\$\{firstValue\}\.\.\.` : firstValue/u,
  );
  assert.match(summarySource, /requestedSourceIds[\s\S]*selectedConsumerKeys/u);
  assert.match(
    summarySource,
    /selectedConsumerKeys\.has\(`\$\{String\(cfg\.id\)\}\\u001f\$\{col\}`\)/u,
  );
});

test("a broken DFM reference reads red and survives a summary re-render", async () => {
  const summaryTableSource = await readFile(
    new URL("../ui/method_pages/dfm/dfm_ratios_summary_table.js", import.meta.url),
    "utf8",
  );
  // Declared after the linked-cell green, at the same specificity, so it wins.
  assert.match(
    dfmCssSource,
    /td\.summaryCell\.excelRangeAffected \{[\s\S]*?\}[\s\S]*?#ratioWrap td\.summaryCell\.excelLinkError \{\s*color: #b91c1c;/u,
  );
  // The record lives on the runtime, so a rebuilt cell is painted again.
  assert.match(
    summaryTableSource,
    /cell\.classList\.remove\("userEntryEditable", "excelLinked", "excelLinkError"\)/u,
  );
  assert.match(
    summaryTableSource,
    /summaryRuntime\._dfmExcelInvalidTargets\?\.get\(`\$\{rowType\}\\u001f\$\{col\}`\)[\s\S]*?cell\.classList\.add\("excelLinkError"\)/u,
  );
});

test("every failed DFM refresh reaches the alert, named or not", () => {
  // Named references are listed; cells that failed with no reference to name
  // ride along as a count, so no failure is left to the status bar alone.
  assert.match(
    summarySource,
    /if \(!options\.silentErrors\) \{[\s\S]*?showExcelLinkFailureAlert\(\{\s*failures: namedFailures,\s*unnamedCount: Math\.max\(0, failedCount - namedFailures\.length\),\s*valueNoun: "linked ratio cell",\s*\}\);/u,
  );
  assert.doesNotMatch(
    summarySource,
    /showSummaryFormulaBarValidationError\("One or more linked formula values could not be refreshed\."\)/u,
  );
  assert.match(
    summarySource,
    /refreshedTargetKeys\.forEach\(\(key\) => invalidTargets\.delete\(key\)\);\s*refreshFailures\.forEach\(\(\{ key, failure \}\) => invalidTargets\.set\(key, failure\)\);/u,
  );
});

test("DFM linked cells keep green text while array formulas receive a shared perimeter", () => {
  assert.match(
    dfmCssSource,
    /td\.summaryCell\.excelLinked,[\s\S]*td\.summaryCell\.excelRangeAffected[\s\S]*color:\s*#166534;[\s\S]*font-weight:\s*700;/u,
  );
  assert.doesNotMatch(dfmCssSource, /td\.summaryCell\.excelLinked::after/u);
  assert.match(
    summarySource,
    /const parsedArray = parseSummaryArrayFormula\(raw\);[\s\S]*?getSummaryArrayFormulaDestination\([\s\S]*?addArrayFormulaOutlineClasses/u,
  );
  assert.match(
    summarySource,
    /entry\.cell\.classList\.add\("excelRangeAffected"\);[\s\S]*?addArrayFormulaOutlineClasses\(entry\.cell/u,
  );
  assert.match(
    summarySource,
    /ratioDataSpacer[\s\S]*?addArrayFormulaOutlineClasses\(bridgeCell/u,
  );
});

test("DFM break and formula mutations invalidate in-flight Excel refreshes", () => {
  assert.match(
    summarySource,
    /export function breakDfmExternalLink[\s\S]*?invalidateDfmExcelRefresh\(\);/u,
  );
  assert.match(
    summarySource,
    /readExcelRangeValues\(link\.range,[\s\S]*?signal: refreshController\.signal[\s\S]*?dfmExternalInputStillMatches/u,
  );
  assert.match(
    summaryEntriesSource,
    /function setUserEntryCellEntry[\s\S]*?!summaryRuntime\._applyingDfmExcelRefresh[\s\S]*?invalidateDfmExcelRefresh\(\)/u,
  );
});

test("DFM formula reference values come from the canonical engine, not displayed text", () => {
  const builder = sourceSlice(
    summaryEntriesSource,
    "function buildSummaryReferenceValues",
    "function insertAtInputCursor",
  );
  assert.match(builder, /computeSummaryRowValueForColumn\(model, col, rowId, cache, visiting, labelToId, lastCol\)/u);
  assert.doesNotMatch(builder, /textContent/u);
});

test("DFM Excel freshness check deduplicates cells and reports stale and unverified values", async () => {
  const batchCalls = [];
  const rows = [{
    id: "user-1",
    averageType: "user_entry",
    inputs: ["=XL_A", "=XL_A", "=XL_B", "=XL_C"],
    values: [1.0000004, 1, 2, 3],
  }];
  const harness = createExcelFreshnessHarness(rows, async (items) => {
    batchCalls.push(items);
    return {
      ok: true,
      results: [
        { ok: true, value: 1.00000049 },
        { ok: true, value: 2.000001 },
        { ok: false, error: "saved cell unavailable" },
      ],
    };
  });

  const result = await harness.checkDfmExcelLinkFreshness();

  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].map((item) => item.cell), ["A1", "B1", "C1"]);
  // The cell the workbook refused is a broken reference, not an unverified
  // value: it is named, and its User Entry cell is recorded so it turns red.
  assert.deepEqual(result.invalidLinks, [{
    workbookPath: "C:\\Data\\Book.xlsx",
    worksheet: "Sheet1",
    sourceCell: "C1",
    destination: "user-1 / 3",
    error: "saved cell unavailable",
  }]);
  assert.deepEqual(
    Array.from(harness.invalidTargets.value.keys()),
    ["user-1\u001f3"],
  );
  assert.deepEqual(result, {
    ok: true,
    linkedCellCount: 4,
    staleCount: 1,
    unverifiedCount: 0,
    invalidCount: 1,
    invalidLinks: result.invalidLinks,
  });
});

test("DFM Excel freshness clears a broken reference once the workbook answers again", async () => {
  const rows = [{
    id: "user-1",
    averageType: "user_entry",
    inputs: ["=XL_A"],
    values: [2],
  }];
  const results = [
    [{ ok: false, error: "Sheet not found: Sheet1" }],
    [{ ok: true, value: 2 }],
  ];
  const harness = createExcelFreshnessHarness(rows, async () => ({ ok: true, results: results.shift() }));

  const broken = await harness.checkDfmExcelLinkFreshness();
  assert.equal(broken.invalidCount, 1);
  assert.equal(harness.invalidTargets.value.size, 1);

  const fixed = await harness.checkDfmExcelLinkFreshness();
  assert.equal(fixed.invalidCount, 0);
  assert.equal(harness.invalidTargets.value.size, 0);
});

test("DFM Excel freshness cancellation aborts an in-flight batch without warnings", async () => {
  const rows = [{
    id: "user-1",
    averageType: "user_entry",
    inputs: ["=XL_A"],
    values: [1],
  }];
  const harness = createExcelFreshnessHarness(rows, (_items, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  }));

  const pending = harness.checkDfmExcelLinkFreshness();
  harness.cancelDfmExcelFreshnessCheck();
  const result = await pending;

  assert.deepEqual(result, {
    ok: false,
    aborted: true,
    staleCount: 0,
    unverifiedCount: 0,
    invalidLinks: [],
  });
});
