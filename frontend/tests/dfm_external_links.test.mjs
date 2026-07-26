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
  new URL("../ui/method_pages/dfm/dfm_ratios_summary_table.js", import.meta.url),
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
    summarySource,
    "export function cancelDfmExcelFreshnessCheck",
    "function invalidateDfmExcelRefresh",
  ).replace("export function", "function");
  const canonicalSource = sourceSlice(
    summarySource,
    "function canonicalExcelComparisonValue",
    "function excelFreshnessSourceKey",
  );
  const sourceKeySource = sourceSlice(
    summarySource,
    "function excelFreshnessSourceKey",
    "/**\n * Checks saved workbook values",
  );
  const checkSource = sourceSlice(
    summarySource,
    "export async function checkDfmExcelLinkFreshness",
    "function collectDfmExternalLinkGroups",
  ).replace("export async function", "async function");
  const factory = new Function("deps", `
    "use strict";
    let _dfmExcelFreshnessGeneration = 0;
    let _dfmExcelFreshnessAbortController = null;
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
    ${cancelSource}
    ${canonicalSource}
    ${sourceKeySource}
    ${checkSource}
    return { checkDfmExcelLinkFreshness, cancelDfmExcelFreshnessCheck };
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
    summarySource,
    /function setUserEntryCellEntry[\s\S]*?!_applyingDfmExcelRefresh[\s\S]*?invalidateDfmExcelRefresh\(\)/u,
  );
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
  assert.deepEqual(result, {
    ok: true,
    linkedCellCount: 4,
    staleCount: 1,
    unverifiedCount: 1,
  });
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
  });
});
