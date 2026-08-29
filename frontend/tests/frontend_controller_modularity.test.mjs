import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);

const dataTabModules = [
  "ui/shared/tabs/data/data_tab_controller.js",
  "ui/shared/tabs/data/data_tab_host_controller.js",
  "ui/shared/tabs/data/data_tab_details_controller.js",
  "ui/shared/tabs/data/data_tab_inputs_controller.js",
  "ui/shared/tabs/data/data_tab_preferences_controller.js",
  "ui/shared/tabs/data/data_tab_request_controller.js",
  "ui/shared/tabs/data/data_tab_persistence_controller.js",
  "ui/shared/tabs/data/data_tab_dirty_state.js",
];

const dfmSummaryModules = [
  "ui/method_pages/dfm/dfm_ratios_summary_table.js",
  "ui/method_pages/dfm/ratios_summary/summary_runtime.js",
  "ui/method_pages/dfm/ratios_summary/summary_model.js",
  "ui/method_pages/dfm/ratios_summary/summary_formula_bar.js",
  "ui/method_pages/dfm/ratios_summary/summary_excel.js",
  "ui/method_pages/dfm/ratios_summary/summary_entries.js",
  "ui/method_pages/dfm/ratios_summary/summary_interactions.js",
];

const dataTabExports = [
  "bootDatasetDataTab",
  "breakDatasetExternalLink",
  "breakDatasetExternalLinks",
  "breakDatasetInternalLinks",
  "getDatasetExternalLinkCellInfo",
  "getDatasetExternalLinkRecords",
  "getDatasetInternalLinkRecords",
  "refreshDatasetExternalLinkRecords",
  "refreshDatasetInternalLinkRecords",
];

const dfmSummaryExports = [
  "DFM_RATIO_HIGHLIGHT_EDGE_CLASSES",
  "applyAverageSelectionFromSaved",
  "applyRatioSelectionPattern",
  "applySelectedSummaryFromSaved",
  "applySummarySelection",
  "breakDfmExternalLink",
  "breakDfmExternalLinks",
  "buildAverageSelectionPayload",
  "buildRatioSelectionPattern",
  "cancelDfmExcelFreshnessCheck",
  "checkDfmExcelLinkFreshness",
  "clearSummaryTableHighlight",
  "getDfmExternalLinkRecords",
  "getUserEntryValueForCol",
  "initDefaultSummarySelection",
  "isUserEntryConfig",
  "recalculateUserEntryDependencies",
  "refreshAllExcelLinks",
  "refreshRatioHighlightHeaders",
  "resetSummaryFormulaEditState",
  "scheduleRatioSummaryUpdate",
  "selectSummaryCell",
  "setSummaryTableCallbacks",
  "updateRatioSummary",
  "wireSummaryContextMenu",
  "wireSummaryRowDrag",
  "wireSummarySelection",
];

async function source(path) {
  return readFile(new URL(path, frontendRoot), "utf8");
}

function physicalLineCount(text) {
  return text.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n").length;
}

function exportedNames(text) {
  const names = new Set();
  for (const match of text.matchAll(
    /\bexport\s+(?:async\s+)?(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}/gsu)) {
    for (const item of match[1].split(",")) {
      const parts = item.trim().split(/\s+as\s+/u);
      const name = parts.at(-1)?.trim();
      if (name) names.add(name);
    }
  }
  return Array.from(names).sort();
}

// A guide, not a limit. A module past it is usually worth splitting, but the
// right moment to split one is a judgement about what it holds, so this is
// reported for a human to weigh rather than failed.
const SUGGESTED_MODULE_LINES = 1000;

async function loadModuleSet(t, modulePaths) {
  const sources = await Promise.all(modulePaths.map(source));
  modulePaths.forEach((path, index) => {
    const lines = physicalLineCount(sources[index]);
    if (lines < SUGGESTED_MODULE_LINES) return;
    t.diagnostic(
      `${path} is ${lines.toLocaleString("en-US")} lines, past the suggested `
      + `${SUGGESTED_MODULE_LINES.toLocaleString("en-US")}; consider splitting it.`,
    );
  });
  return sources;
}

async function javascriptSources(directoryPath) {
  const result = [];
  async function visit(directoryUrl) {
    const entries = await readdir(directoryUrl, { withFileTypes: true });
    for (const entry of entries) {
      const entryUrl = new URL(entry.name, directoryUrl);
      if (entry.isDirectory()) {
        await visit(new URL(`${entry.name}/`, directoryUrl));
      } else if (entry.name.endsWith(".js")) {
        result.push({ path: entryUrl.pathname, text: await readFile(entryUrl, "utf8") });
      }
    }
  }
  await visit(new URL(directoryPath, frontendRoot));
  return result;
}

test("the Data-tab split preserves its facade", async (t) => {
  const [facade] = await loadModuleSet(t, dataTabModules);
  assert.deepEqual(exportedNames(facade), [...dataTabExports].sort());
  assert.match(facade, /let bootPromise = null;/u);
  assert.match(
    facade,
    /export function bootDatasetDataTab\(\) \{\s*if \(!bootPromise\) bootPromise = bootDatasetDataTabOnce\(\);\s*return bootPromise;\s*\}/u,
  );
});

test("the DFM ratios-summary split preserves its facade", async (t) => {
  const [facade] = await loadModuleSet(t, dfmSummaryModules);
  assert.deepEqual(exportedNames(facade), [...dfmSummaryExports].sort());
});

test("DFM ratio rerenders dispose the selected-rows controller before replacing DOM", async () => {
  const ratiosTab = await source("ui/method_pages/dfm/dfm_ratios_tab.js");
  assert.match(
    ratiosTab,
    /function renderRatioTable\(\)[\s\S]*?selectedRowsTableHighlight\?\.destroy\?\.\(\);[\s\S]*?selectedRowsTableHighlight = null;[\s\S]*?wrap\.innerHTML = "";/u,
  );
});

test("DFM runtime imports never load one module under multiple version URLs", async () => {
  const files = await javascriptSources("ui/method_pages/dfm/");
  const importsByPath = new Map();
  files.forEach(({ path, text }) => {
    for (const match of text.matchAll(
      /["'](\/ui\/[^"'?]+\.js)\?v=([^"']+)["']/gu,
    )) {
      if (!importsByPath.has(match[1])) importsByPath.set(match[1], []);
      importsByPath.get(match[1]).push({ path, url: `${match[1]}?v=${match[2]}` });
    }
  });
  assert.ok(importsByPath.size > 0, "DFM must contain versioned runtime imports.");
  importsByPath.forEach((imports, modulePath) => {
    assert.equal(
      new Set(imports.map(({ url }) => url)).size,
      1,
      `${modulePath} imports must use one URL: ${JSON.stringify(imports)}`,
    );
  });

  const uiFiles = await javascriptSources("ui/");
  const tableSelectionImports = uiFiles.flatMap(({ path, text }) => Array.from(
    text.matchAll(/["']([^"']*table_selection\.js(?:\?v=[^"']+)?)['"]/gu),
    (match) => ({ path, specifier: match[1] }),
  ));
  assert.ok(tableSelectionImports.length > 0, "table_selection.js must have consumers.");
  const normalizedTableSelectionUrls = new Set(tableSelectionImports.map(({ specifier }) => (
    specifier.startsWith("./")
      ? `/ui/shared/components/spreadsheet/${specifier.slice(2)}`
      : specifier
  )));
  assert.deepEqual(
    Array.from(normalizedTableSelectionUrls),
    ["/ui/shared/components/spreadsheet/table_selection.js?v=20260726a"],
    `table_selection.js consumers must share one module identity: ${JSON.stringify(tableSelectionImports)}`,
  );
});
