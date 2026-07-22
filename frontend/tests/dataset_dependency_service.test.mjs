import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../ui/shared/dataset/dataset_dependency_service.js", import.meta.url),
  "utf8",
);
const testableSource = source.replace(
  /import \{ state \} from "\/ui\/shared\/dataset\/dataset_state\.js";/,
  "const state = {};",
);
const { createDatasetDependencyGuard } = await import(
  `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`
);

const normalize = (value) => String(value || "").trim().toLowerCase();

function datasetTypesResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        columns: ["Name", "Data Format", "Category", "Calculated", "Formula", "Source", "Generated"],
        rows: [
          ["Manual Input", "Triangle", "Input", false, "", "", false],
          ["Calculated Output", "Triangle", "Output", true, '"Manual Input" * 2', "", false],
        ],
      },
    }),
  };
}

function fieldMappingResponse() {
  return {
    ok: true,
    json: async () => ({ data: { rows: [] } }),
  };
}

function createGuard(precheckArcRhoTriCsv, statuses = []) {
  return createDatasetDependencyGuard({
    state: {},
    normalizeProjectText: normalize,
    getResolvedProjectValue: () => "Example Project",
    getTriInputs: () => ({
      project: "Example Project",
      path: "Example RC",
      tri: "Calculated Output",
      originLen: 12,
      devLen: 12,
      cumulative: true,
      calendar: false,
    }),
    precheckArcRhoTriCsv,
    precheckArcRhoVecCsv: precheckArcRhoTriCsv,
    setInputInvalid: () => {},
    clearInputInvalid: () => {},
    setStatus: (message) => statuses.push(message),
  });
}

test("cached ad-hoc formula inputs satisfy dependency validation", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const checkedNames = [];
  globalThis.document = { getElementById: () => null };
  globalThis.fetch = async (url) => (
    String(url).startsWith("/dataset_types") ? datasetTypesResponse() : fieldMappingResponse()
  );
  try {
    const guard = createGuard(async (inputs) => {
      checkedNames.push(inputs.tri);
      return {
        ok: true,
        hasExistingCsv: inputs.tri === "Manual Input",
        data: inputs.tri === "Manual Input" ? { data_path: "E:\\cache\\Manual Input.csv" } : {},
      };
    });
    const result = await guard.validateDatasetTypeDependencies("Calculated Output", { forceReload: true });

    assert.equal(result.ok, true);
    assert.equal(result.bypassedByExistingDependencies, true);
    assert.deepEqual(checkedNames, ["Calculated Output", "Manual Input"]);
    assert.deepEqual(result.dependencyDataPaths, ["E:\\cache\\Manual Input.csv"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});

test("dependency validation reports only caches that remain unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const statuses = [];
  globalThis.document = { getElementById: () => null };
  globalThis.fetch = async (url) => (
    String(url).startsWith("/dataset_types") ? datasetTypesResponse() : fieldMappingResponse()
  );
  try {
    const guard = createGuard(async () => ({ ok: true, hasExistingCsv: false, data: {} }), statuses);
    const result = await guard.validateDatasetTypeDependencies("Calculated Output", { forceReload: true });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["Manual Input"]);
    assert.match(statuses.at(-1), /cannot be generated due to missing dependencies/u);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});
