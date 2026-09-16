import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all(["data", "grids"].map((part) => readFile(
  new URL(`../ui/method_pages/result_selection/result_selection_${part}.js`, import.meta.url),
  "utf8",
)));

for (const sourceKind of ["engine", "calculated", "input", "dfm"]) {
  test(`Result Selection opens ${sourceKind} sources without blocking display saves`, async () => {
    const messages = [];
    const window = {
      parent: { postMessage: (message) => messages.push(message) },
      addEventListener() {},
      removeEventListener() {},
      setTimeout() {},
    };
    const sandbox = vm.createContext({ window });
    sources.forEach((source) => vm.runInContext(source, sandbox));
    const ctx = {
      datasetTypeItems: [],
      text: (value) => String(value || "").trim(),
      norm: (value) => String(value || "").trim().toLowerCase(),
      validSourceOriginLength: (value) => Number(value) || 0,
      createSpreadsheetTableController: () => ({}),
      state: { sources: [{ name: "Dataset" }] },
      postStatus: (message) => assert.fail(message),
    };
    const data = window.ResultSelectionParts.installData(ctx);
    ctx.cachedRows = data.normalizeDatasetRows({ files: [{
      name: "Dataset",
      dataset_type: "Dataset Type",
      source_kind: sourceKind,
      data_format: "Triangle",
    }] });
    const grids = window.ResultSelectionParts.installGrids(ctx);

    await grids.viewOrEditSourceDataset(0);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "arcrho:automation-open-dataset");
    assert.equal(messages[0].args.datasetName, "Dataset");
    assert.equal(messages[0].args.datasetTypeName, "Dataset Type");
    assert.equal(!!messages[0].args.readOnly, false);
  });
}
