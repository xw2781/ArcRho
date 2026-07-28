import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const repoFile = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
const read = (relativePath) => readFile(repoFile(relativePath), "utf8");

test("dataset sidecars are the only persisted notes owner", async () => {
  const runtimeFiles = await Promise.all([
    "frontend/app_server/services/dataset_service.py",
    "frontend/app_server/services/dataset_instance_index_service.py",
    "python-api/src/arcrho_api/dataset_index_contract.py",
    "python-api/migration/resq_migration/core.py",
    "python-api/migration/resq_migration/catalog.py",
  ].map(read));
  assert.doesNotMatch(runtimeFiles.filter((_source, index) => index !== 2).join("\n"), /ArcRhoTriNotes@/u);
  assert.match(runtimeFiles[2], /migrate_legacy_notes_files/u);

  const methodFiles = await Promise.all([
    "frontend/ui/method_pages/dfm/dfm_persistence.js",
    "frontend/ui/method_pages/result_selection/result_selection_model.js",
    "frontend/ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js",
    "frontend/ui/method_pages/berquist_sherman/berquist_sherman_main.js",
    "data-engine/src/arcrho_bridge/resq_client.py",
    "python-api/migration/resq_migration/dfm.py",
    "python-api/migration/resq_migration/extractors.py",
  ].map(read));
  const methodSource = methodFiles.join("\n");
  assert.doesNotMatch(methodSource, /["']notes tab["']\s*:/u);
  assert.doesNotMatch(methodSource, /\bnotes_tab\s*:/u);

  const datasetService = runtimeFiles[0];
  assert.match(datasetService, /"notes": str\(payload\.get\("notes"\) or ""\)/u);
  assert.match(datasetService, /payload\["notes"\] = str\(notes/u);

  const rpcSnapshots = (await Promise.all([
    "frontend/app_server/services/dfm_rpc_bridge_service.py",
    "frontend/app_server/services/result_selection_rpc_bridge_service.py",
  ].map(read))).join("\n");
  assert.doesNotMatch(rpcSnapshots, /^\s*["']notes["']\s*:/mu);
});

test("Project Instance DSV open uses the aggregate sidecar and CSV cache route", async () => {
  const controller = (await Promise.all([
    "frontend/ui/shared/tabs/data/data_tab_controller.js",
    "frontend/ui/shared/tabs/data/data_tab_host_controller.js",
    "frontend/ui/shared/tabs/data/data_tab_persistence_controller.js",
  ].map(read))).join("\n");
  assert.match(controller, /isProjectInstanceCachedDatasetOpen/u);
  assert.match(controller, /loadProjectInstanceCachedDataset/u);
  assert.match(controller, /loadCachedDataset\(/u);
  assert.match(controller, /sidecarData: data/u);
});

test("Project Instance method opens reuse the parent dataset-index snapshot", async () => {
  const [cache, shared, resultSelection, bf, bs] = await Promise.all([
    read("frontend/ui/project_instance/project_instance_dataset_cache.js"),
    read("frontend/ui/shared/dataset/project_instance_dataset_snapshot.js"),
    read("frontend/ui/method_pages/result_selection/result_selection_data.js"),
    read("frontend/ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js"),
    read("frontend/ui/method_pages/berquist_sherman/berquist_sherman_main.js"),
  ]);
  assert.match(cache, /publishProjectInstanceDatasetSnapshot\(projectName, normalizedPath, payload\)/u);
  assert.match(shared, /window\.sessionStorage/u);
  for (const methodSource of [resultSelection, bf, bs]) {
    assert.match(methodSource, /readProjectInstanceDatasetSnapshot/u);
    assert.match(methodSource, /project_instance/u);
  }
});
