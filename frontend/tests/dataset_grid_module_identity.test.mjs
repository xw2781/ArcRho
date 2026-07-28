import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);
const gridViewPath = "/ui/shared/tabs/data/dataset_grid_view.js";
const dataTabControllerPath = "/ui/shared/tabs/data/data_tab_controller.js";

const gridViewConsumers = [
  "ui/shared/tabs/data/data_tab_controller.js",
  "ui/shared/tabs/data/dataset_grid_interactions.js",
  "ui/dataset_viewer/tabs/dataset_chart_tab.js",
  "ui/method_pages/dfm/dfm_ratios_tab.js",
  "ui/method_pages/dfm/dfm_results_tab.js",
];

async function importedGridViewUrl(path) {
  const source = await readFile(new URL(path, frontendRoot), "utf8");
  const match = source.match(/from\s+"(\/ui\/shared\/tabs\/data\/dataset_grid_view\.js\?v=[^"]+)"/u);
  assert.ok(match, `${path} must import the versioned shared grid module.`);
  return match[1];
}

test("stateful shared-grid consumers use one cache-busted module URL", async () => {
  const gridViewUrls = await Promise.all(gridViewConsumers.map(importedGridViewUrl));
  assert.equal(new Set(gridViewUrls).size, 1);
  assert.equal(new URL(gridViewUrls[0], "http://arcrho.test").pathname, gridViewPath);
});

test("the data-tab controller and its interaction adapter share the grid module version", async () => {
  const controllerSource = await readFile(
    new URL("ui/shared/tabs/data/data_tab_controller.js", frontendRoot),
    "utf8",
  );
  const [gridViewUrl, interactionsUrl] = await Promise.all([
    importedGridViewUrl("ui/shared/tabs/data/data_tab_controller.js"),
    controllerSource.match(/from\s+"(\/ui\/shared\/tabs\/data\/dataset_grid_interactions\.js\?v=[^"]+)"/u)?.[1],
  ]);
  assert.ok(interactionsUrl, "The data-tab controller must cache-bust its interaction adapter.");
  assert.equal(
    new URL(interactionsUrl, "http://arcrho.test").searchParams.get("v"),
    new URL(gridViewUrl, "http://arcrho.test").searchParams.get("v"),
  );
});

test("Dataset Viewer and DFM load one cache-busted Data-tab facade", async () => {
  const consumers = [
    "ui/dataset_viewer/dataset_viewer_main.js",
    "ui/method_pages/dfm/dfm_data_tab_adapter.js",
  ];
  const urls = await Promise.all(consumers.map(async (path) => {
    const source = await readFile(new URL(path, frontendRoot), "utf8");
    const match = source.match(/"(\/ui\/shared\/tabs\/data\/data_tab_controller\.js\?v=[^"]+)"/u);
    assert.ok(match, path + " must import the versioned Data-tab facade.");
    return match[1];
  }));
  assert.equal(new Set(urls).size, 1);
  assert.equal(new URL(urls[0], "http://arcrho.test").pathname, dataTabControllerPath);
});
