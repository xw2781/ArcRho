import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [projectInstanceHtml, projectInstanceCss, contextSource, cacheSource, tableSource, windowsSource, dataTabSource, datasetApiSource] = await Promise.all([
  readFile(new URL("../ui/project_instance/project_instance.html", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance.css", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_context.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_dataset_cache.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_dataset_table.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_windows.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/shared/tabs/data/data_tab_controller.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/shared/dataset/dataset_api.js", import.meta.url), "utf8"),
]);

test("Project Instance exposes a session-only temporary dataset view", () => {
  assert.match(projectInstanceHtml, /id="datasetTempViewBtn"/);
  assert.match(projectInstanceHtml, /aria-pressed="false"/);
  assert.match(contextSource, /datasetViewMode:\s*"normal"/);
  assert.match(contextSource, /temporaryDatasetSessionId:\s*""/);
  assert.match(cacheSource, /function createTemporaryDatasetSessionId\(\)/);
  assert.match(cacheSource, /state\.datasetViewMode = "temporary"/);
  assert.match(cacheSource, /state\.datasetViewMode = "normal"/);
  assert.match(cacheSource, /function captureNormalDatasetTableFilters\(\)/);
  assert.match(cacheSource, /function restoreNormalDatasetTableFilters\(\)/);
  assert.match(cacheSource, /window\.addEventListener\("pagehide"/);
});

test("temporary view uses index membership for its status without cleanup", () => {
  assert.doesNotMatch(cacheSource, /arcrho\/temporary\/cleanup/);
  assert.doesNotMatch(cacheSource, /cleanupTemporaryDatasetSession/);
  assert.doesNotMatch(cacheSource, /sidecarNames/);
  assert.doesNotMatch(cacheSource, /sidecar_exists/);
  assert.match(tableSource, /state\.datasetRows\s*\.filter\(\(row\) => getDatasetGenerated\(row\)\)/);
  assert.match(tableSource, /isIndexed:\s*temporary && isDatasetRecordCached\(\{ datasetName \}\)/);
  assert.match(tableSource, /temp-indexed/);
  assert.match(tableSource, /temp-unindexed/);
  assert.match(tableSource, /already listed in index\.json/);
  assert.match(projectInstanceCss, /\.pi-status-cell\.temp-indexed\s*\{\s*color:\s*#15803d;/);
  assert.match(projectInstanceCss, /\.pi-status-cell\.temp-unindexed\s*\{\s*color:\s*#98a2b3;/);
  assert.match(tableSource, /\["methodType", "lastModified", "created", "user"\]/);
  assert.match(tableSource, /isTemporaryViewActive\(\) && normalized !== "view"/);
  assert.match(tableSource, /function saveDatasetTablePreferences\(\) \{\s*if \(isTemporaryViewActive\(\)\) return;/);
});

test("temporary view toolbar uses concise dataset copy and a styled mode tooltip", () => {
  assert.match(cacheSource, /Temporary view \| \$\{count\} \$\{count === 1 \? "dataset" : "datasets"\}/);
  assert.doesNotMatch(cacheSource, /engine datasets?/);
  assert.doesNotMatch(cacheSource, /datasetTempViewBtn\.title/);
  assert.match(projectInstanceHtml, /class="dataset-temp-view-control"/);
  assert.match(projectInstanceHtml, /id="datasetTempViewTooltip" role="tooltip"/);
  assert.match(projectInstanceHtml, /aria-describedby="datasetTempViewTooltip"/);
  assert.match(contextSource, /datasetTempViewTooltipTitle: document\.getElementById\("datasetTempViewTooltipTitle"\)/);
  assert.match(contextSource, /datasetTempViewTooltipDescription: document\.getElementById\("datasetTempViewTooltipDescription"\)/);
  assert.match(projectInstanceHtml, /id="datasetTempViewTooltipTitle">Temporary view is disabled/);
  assert.match(projectInstanceHtml, /id="datasetTempViewTooltipDescription">Normal view shows saved datasets only\. Click to enable Temporary view\./);
  assert.match(cacheSource, /Temporary view is enabled/);
  assert.match(cacheSource, /Temporary view is disabled/);
  assert.match(cacheSource, /Temporary view shows all datasets that can be generated\. Click to return to Normal view\./);
  assert.match(projectInstanceCss, /\.dataset-temp-view-control:hover \.dataset-temp-view-tooltip/);
});

test("temporary dataset windows pass the session to the viewer and are not restored", () => {
  assert.match(windowsSource, /params\.set\("temporary_view", "1"\)/);
  assert.match(windowsSource, /params\.set\("temporary_session_id", toText\(options\.temporaryViewSessionId\)\)/);
  assert.match(windowsSource, /function closeTemporaryDatasetWindows\(temporaryViewSessionId\)/);
  assert.match(windowsSource, /if \(toText\(frame\.dataset\?\.temporaryViewSessionId\)\) return null/);
  assert.match(tableSource, /temporaryViewSessionId: temporaryView \? toText\(state\.temporaryDatasetSessionId\) : ""/);
});

test("the Dataset Viewer sends the temporary-mode signal and blocks writes", () => {
  assert.match(dataTabSource, /const isTemporaryDatasetView = qs\.get\("temporary_view"\) === "1" && !!temporaryDatasetSessionId/);
  assert.match(dataTabSource, /TemporarySessionId: temporaryDatasetSessionId/);
  assert.match(dataTabSource, /Temporary view does not save permanent dataset sidecars\./);
  assert.match(dataTabSource, /Temporary view is read-only and cannot save notes\./);
  assert.match(dataTabSource, /if \(isTemporaryDatasetView\) return false;/);
  assert.match(dataTabSource, /loadTemporaryNumberFormatSettings/);
  assert.match(dataTabSource, /resolved_number_format/);
  assert.match(datasetApiSource, /dataset\/number-format-defaults/);
  assert.match(datasetApiSource, /dataset_type_name/);
  assert.doesNotMatch(datasetApiSource, /reserving_class/);
});
