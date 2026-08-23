import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = async (path) => readFile(new URL(path, root), "utf8");

const [
  apiSource,
  persistenceSource,
  resultsSource,
  auditSource,
  dataControllerSource,
  windowsSource,
  datasetTableSource,
  projectMessagesSource,
  summarySource,
  summaryValidationSource,
  linksSource,
  ratioCalcSource,
] = await Promise.all([
  source("ui/method_pages/dfm/dfm_method_api.js"),
  source("ui/method_pages/dfm/dfm_persistence.js"),
  source("ui/method_pages/dfm/dfm_results_tab.js"),
  source("ui/method_pages/dfm/dfm_audit_log.js"),
  source("ui/shared/tabs/data/data_tab_controller.js"),
  source("ui/project_instance/project_instance_windows.js"),
  source("ui/project_instance/project_instance_dataset_table.js"),
  source("ui/project_instance/project_instance_messages.js"),
  source("ui/method_pages/dfm/ratios_summary/summary_excel.js"),
  source("ui/method_pages/dfm/ratios_summary/summary_excel_validation.js"),
  source("ui/method_pages/dfm/dfm_links_tab.js"),
  source("ui/method_pages/dfm/dfm_ratio_calc.js"),
]);

function functionSlice(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return text.slice(start, end);
}

test("aggregate DFM API sends method and output identities with revision-aware save", async () => {
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => {
    requests.push({ path, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, method: {} }) };
  };
  try {
    const api = await import(
      `data:text/javascript;base64,${Buffer.from(apiSource).toString("base64")}`
    );
    await api.loadDfmMethod({
      project_name: "Project",
      reserving_class: "RC",
      method_name: "Method",
      output_dataset: "Output",
    });
    await api.previewDfmMethod({ "json_format": api.DFM_METHOD_JSON_FORMAT });
    await api.saveDfmMethod({
      project_name: "Project",
      reserving_class: "RC",
      method: { "json_format": api.DFM_METHOD_JSON_FORMAT },
      notes: "keep",
      expected_owned_revision: "owned",
      expected_derived_revision: "derived",
    });
    await api.resolveDfmDatasetReferences({
      project_name: "Project",
      reserving_class: "RC",
      references: [{ dataset_name: "Paid", row_idx: "1", col_idx: "2" }],
    });

    assert.deepEqual(requests[0], {
      path: "/dfm/method/load",
      body: {
        project_name: "Project",
        reserving_class: "RC",
        method_name: "Method",
        output_dataset: "Output",
      },
    });
    assert.equal(requests[1].path, "/dfm/method/preview");
    assert.deepEqual(requests[2].body, {
      project_name: "Project",
      reserving_class: "RC",
      method: { "json_format": api.DFM_METHOD_JSON_FORMAT },
      notes: "keep",
      expected_owned_revision: "owned",
      expected_derived_revision: "derived",
    });
    assert.deepEqual(requests[3], {
      path: "/dfm/method/dataset-references/resolve",
      body: {
        project_name: "Project",
        reserving_class: "RC",
        references: [{ dataset_name: "Paid", row_idx: "1", col_idx: "2" }],
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("v2 open hydrates snapshots, stays clean, and warms the dataset-reference cache", () => {
  const load = functionSlice(
    persistenceSource,
    "export async function loadRatioSelectionIfExists",
    "export function scheduleRatioSelectionLoad",
  );
  assert.match(load, /loadDfmMethod\(identity\)/u);
  assert.match(load, /hydrateDfmOutputSidecar/u);
  assert.match(load, /scheduleDfmExcelFreshnessCheck/u);
  // Dataset-referenced formula values are refreshed by the Engine propagation
  // walk when a referenced dataset is saved; opening never re-evaluates them
  // into the page or marks the window dirty. The open flow only warms the
  // session cache that powers live re-evaluation after ratio edits.
  assert.match(load, /warmDfmDatasetReferenceCache\(method\)/u);
  assert.doesNotMatch(load, /refreshAllExcelLinks|markDfmDirty/u);
  assert.doesNotMatch(load, /readJsonFile|ADA_DFM_REFRESH_DATASET|loadDatasetSidecar/u);

  const warm = functionSlice(
    persistenceSource,
    "function warmDfmDatasetReferenceCache",
    "function getDfmRatioTriangleTab",
  );
  assert.match(warm, /resolveDfmDatasetReferencesInFormulas\(datasetFormulas\)/u);
  assert.doesNotMatch(warm, /setUserEntryCellEntry|markDfmDirty|persistUserEntryRowsFromState/u);

  const linkedRefresh = functionSlice(
    summarySource,
    "export async function refreshAllExcelLinks",
    "function collectDfmExternalLinkGroups",
  );
  assert.doesNotMatch(linkedRefresh, /datasetReferencesOnly|dfm-open/u);
  assert.match(linkedRefresh, /save to keep the refreshed values/u);

  assert.match(dataControllerSource, /if \(persistedDfmBootstrap \|\| isProjectInstanceCachedDatasetOpen \|\| isTemporaryDatasetView\) \{[^}]*runtime\.applyTriInputsFromQueryParams\(\);/u);
  assert.match(dataControllerSource, /if \(persistedDfmBootstrap\) \{\s*runtime\.setStatus\("Loading DFM method\.\.\."\);/u);
  assert.match(resultsSource, /applyPersistedResultsSnapshot/u);
  assert.match(resultsSource, /getRatioBasisInputEl\(\) && !ratioBasisEmbeddedSnapshot/u);
  assert.match(resultsSource, /ratioBasisEmbeddedSnapshot \? null : queueRatioBasisColumnLoadIfNeeded/u);
  assert.match(
    resultsSource,
    /if \(Array\.isArray\(stateLike\.originLabels\) && stateLike\.originLabels\.length\) return null;/u,
  );
  assert.match(auditSource, /if \(hydratedDfmSidecar\)/u);
});

test("an Origin Length change re-reads the embedded Ratio Basis before any payload", () => {
  // The persisted Ratio Basis column is captured on the DFM's origin basis and
  // the method contract requires its labels to equal the DFM origins exactly,
  // so a new origin basis must drop the embedded snapshot and reload the
  // column instead of saving the previous basis.
  const drop = functionSlice(
    resultsSource,
    "function dropEmbeddedRatioBasisSnapshotOnOriginChange",
    "export async function ensureResultsRatioBasisAligned",
  );
  assert.match(drop, /matchesOriginLabels\(ratioBasisColumnState\.originLabels, origins\)/u);
  assert.match(drop, /ratioBasisEmbeddedSnapshot = false;\s*clearRatioBasisColumnState\(\);/u);

  const render = resultsSource.slice(resultsSource.indexOf("export function renderResultsTable"));
  assert.match(
    render,
    /wrap\.innerHTML = "";\s*dropEmbeddedRatioBasisSnapshotOnOriginChange\(\);/u,
  );

  const align = functionSlice(
    resultsSource,
    "export async function ensureResultsRatioBasisAligned",
    "function readCurrentOriginLen",
  );
  assert.match(align, /await ratioBasisColumnLoadPromise/u);
  assert.match(align, /does not line up with the current origins/u);

  // Both payload producers wait for that re-read; the save names the field
  // rather than letting the contract reject an unaligned column.
  const save = functionSlice(
    persistenceSource,
    "async function runDfmMethodSave",
    "export async function saveDfmTemplate",
  );
  assert.match(
    save,
    /const ratioBasis = await ensureResultsRatioBasisAligned\(\);[\s\S]*?if \(!ratioBasis\.ok\)[\s\S]*?return \{ ok: false, error: ratioBasis\.error \};[\s\S]*?const preview = await flushDfmMethodPreview\(\)/u,
  );
  const preview = functionSlice(
    persistenceSource,
    "async function runDfmMethodPreview",
    "export function scheduleDfmMethodPreview",
  );
  assert.match(preview, /await ensureResultsRatioBasisAligned\(\);[\s\S]*?dfmPreviewGeneration \+= 1;/u);
});

test("v2 payload and PI restore preserve distinct method/output identities", () => {
  const builder = functionSlice(
    persistenceSource,
    "export function buildDfmMethodPayload",
    "function normalizeRatioMatrixCellValue",
  );
  for (const field of [
    "input_data_triangle_values",
    "input_data_triangle_mask",
    "input_source_revision",
    "output_dataset",
    "ultimate_vector",
    "owned_revision",
    "derived_revision",
    "publication_revision",
  ]) {
    assert.match(builder, new RegExp(field, "u"));
  }
  for (const field of [
    "ratio_basis_origin_labels",
    "ratio_basis_values",
    "ratio_basis_data_format",
    "ratio_basis_source_revision",
  ]) {
    assert.match(resultsSource, new RegExp(field, "u"));
  }
  assert.doesNotMatch(builder, /csv path/u);
  assert.match(windowsSource, /params\.set\("output_dataset", outputDataset\)/u);
  assert.doesNotMatch(windowsSource, /options\?\.outputDataset \|\| name/u);
  assert.match(datasetTableSource, /outputDataset:\s*datasetName/u);
  assert.match(projectMessagesSource, /outputDataset:\s*datasetName/u);
  assert.match(windowsSource, /frame\.dataset\.windowOutputDataset = outputDataset/u);
  assert.match(windowsSource, /outputDataset: kind === "dfm"/u);
  assert.match(
    windowsSource,
    /outputDataset: toText\(item\?\.outputDataset \|\| item\?\.output_dataset \|\| ""\)/u,
  );
  assert.doesNotMatch(
    windowsSource,
    /outputDataset: toText\(item\?\.outputDataset \|\| item\?\.datasetName \|\| name\)/u,
  );
});

test("the built payload carries the owned output category through", () => {
  // 'output_category' is an owned field the DFM page never edits, so a payload
  // that drops it hashes to a different owned revision and is rejected wherever
  // the method is validated as complete -- the macro handoff, for one.
  const builder = functionSlice(
    persistenceSource,
    "export function buildDfmMethodPayload",
    "function normalizeRatioMatrixCellValue",
  );
  assert.match(builder, /"output_category": currentDfmOutputCategory/u);
  const grouped = functionSlice(
    persistenceSource,
    "function buildDfmGroupedMethodPayload",
    "function recordCleanDfmMethodPayload",
  );
  assert.match(grouped, /"output_category",/u);
  // Captured from the applied method, and omitted when unknown so a Save cannot
  // clear the category held on disk.
  assert.match(persistenceSource, /currentDfmOutputCategory = String\(/u);
  assert.match(builder, /currentDfmOutputCategory \? \{ "output_category"/u);
});

test("DFM Save As rekeys and restores the new method/output identity", () => {
  assert.match(
    projectMessagesSource,
    /msg\.type === "arcrho:dfm-identity"[\s\S]*?syncDfmWindowIdentity\(frame, methodName, outputDataset\)/u,
  );
  assert.match(windowsSource, /function syncDfmWindowIdentity\(frame, methodName, outputDataset = ""\)/u);
  assert.match(windowsSource, /const canonicalKey = getDfmWindowKey\(name, targetPath\)/u);
  assert.match(windowsSource, /existing && existing !== frame[\s\S]*?nextKey = `\$\{canonicalKey\}\\u0001instance/u);
  assert.match(windowsSource, /datasetWindows\.delete\(previousKey\)/u);
  assert.match(windowsSource, /frame\.dataset\.windowKey = nextKey/u);
  assert.match(windowsSource, /frame\.dataset\.windowDatasetName = name/u);
  assert.match(windowsSource, /frame\.dataset\.windowItemName = name/u);
  assert.match(windowsSource, /frame\.dataset\.windowTitle = title/u);
  assert.match(windowsSource, /frame\.dataset\.windowOutputDataset = declaredOutputDataset/u);
  assert.match(windowsSource, /datasetWindows\.set\(nextKey, frame\)/u);
  assert.match(windowsSource, /const name = toText\(frame\.dataset\.windowItemName/u);
  assert.match(windowsSource, /outputDataset: kind === "dfm" \? toText\(frame\.dataset\.windowOutputDataset/u);
  assert.match(
    windowsSource,
    /kind === "dfm"[\s\S]*?openDfmWindow\(name, \{[\s\S]*?outputDataset: toText\(item\?\.outputDataset \|\| item\?\.output_dataset \|\| ""\)/u,
  );
});

test("preview/save and Excel freshness retain owned and stored-value semantics", () => {
  assert.match(persistenceSource, /previewDfmMethod\(buildDfmMethodPayload\(\)/u);
  assert.match(persistenceSource, /export async function applyDfmOwnedPatchPayload/u);
  assert.match(persistenceSource, /projectDfmOwnedPatch/u);
  assert.match(persistenceSource, /expected_owned_revision:\s*currentOwnedRevision/u);
  assert.match(
    persistenceSource,
    /if \(applied && isV2 && options\.markClean !== false\) \{[\s\S]*currentOwnedRevision/u,
  );
  assert.match(persistenceSource, /\(forceSaveAs \|\| identityChanged\) \? \{\} :/u);
  assert.match(
    persistenceSource,
    /const nextOutputDataset = \(forceSaveAs \|\| identityChanged\)\s*\? currentMethodName/u,
  );
  assert.match(persistenceSource, /markDfmClean\(\{ force: true \}\)/u);
  const freshnessSchedule = functionSlice(
    persistenceSource,
    "function scheduleDfmExcelFreshnessCheck",
    "export async function loadRatioSelectionIfExists",
  );
  assert.match(freshnessSchedule, /currentOwnedRevision \|\| metadata\["owned_revision"\]/u);
  assert.match(freshnessSchedule, /currentDerivedRevision \|\| metadata\["derived_revision"\]/u);
  assert.match(freshnessSchedule, /currentPublicationRevision \|\| metadata\["publication_revision"\]/u);

  const check = functionSlice(
    summaryValidationSource,
    "async function checkDfmExcelLinkFreshness",
    "registerSummaryFunctions(",
  );
  assert.match(check, /itemsByKey/u);
  assert.match(check, /readExcelCellsBatch/u);
  assert.match(check, /canonicalExcelComparisonValue/u);
  assert.doesNotMatch(check, /_xlCellValueCache\.set|setUserEntryCellEntry|persistUserEntryRowsFromState|_onRatioStateMutated/u);
  assert.match(linksSource, /Stored values remain active until you choose Refresh/u);
  assert.match(linksSource, /setWarning/u);
});

test("opaque benchmark averages render from their frozen canonical values", async () => {
  const ratioCalc = await import(
    `data:text/javascript;base64,${Buffer.from(ratioCalcSource).toString("base64")}`
  );
  const result = ratioCalc.computeAverageForColumn(
    { values: [[1, 99]], mask: [[true, true]], origin_labels: ["2024"] },
    0,
    new Set(),
    { base: "benchmark", values: [1.234567] },
  );
  assert.equal(result.value, 1.234567);
  assert.equal(result.totalIncluded, 1);
  assert.match(persistenceSource, /isFrozenBenchmark/u);
});
