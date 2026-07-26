import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  normalizeRatioBasisValueSets,
  ratioBasisValuesForName,
  upsertRatioBasisValueSet,
} from "../ui/method_pages/result_selection/result_selection_json_contract.js";

test("Result Selection source reloads use bounded parallel workers", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /const SOURCE_LOAD_CONCURRENCY = 4;/);
  assert.match(source, /mapWithConcurrency\(existingSources, SOURCE_LOAD_CONCURRENCY/);
  assert.doesNotMatch(source, /for \(const existing of state\.sources \|\| \[\]\)/);
});


test("older Ratio Basis loads cannot overwrite the newest selection", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { ResultSelectionParts: {} };

  let activeBasis = "Basis A";
  const pending = new Map();
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Promise((resolve) => {
      pending.set(request.dataset_name, (value) => resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data_format: "Vector",
          origin_length: 12,
          values: [[value]],
        }),
      }));
    });
  };

  try {
    Function(source)();
    const state = {
      project: "Example Project",
      reservingClass: "Example RC",
      ratioBasisValues: [],
      ratioBasisValueSets: [],
    };
    let renderCount = 0;
    const api = globalThis.window.ResultSelectionParts.installData({
      state,
      cachedRows: [
        { name: "Basis A", datasetType: "Basis A", dataFormat: "Vector", originLength: 12, sourceKind: "input" },
        { name: "Basis B", datasetType: "Basis B", dataFormat: "Vector", originLength: 12, sourceKind: "input" },
      ],
      datasetTypeItems: [],
      text: (value) => String(value || "").trim(),
      norm: (value) => String(value || "").trim().toLowerCase(),
      validSourceOriginLength: (value) => Number(value) || 0,
      numberOrNull: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
      isEngineSource: () => false,
      getDetails: () => ({ originLength: 12 }),
      syncRatioBasisSelector: () => {},
      getActiveRatioBasisName: () => activeBasis,
      renderMethodGrid: () => { renderCount += 1; },
      postStatus: () => {},
      ratioBasisValuesForName,
      upsertRatioBasisValueSet,
    });

    const older = api.refreshRatioBasisValues();
    activeBasis = "Basis B";
    const newer = api.refreshRatioBasisValues();
    pending.get("Basis B")(200);
    assert.equal(await newer, true);
    pending.get("Basis A")(100);
    assert.equal(await older, false);

    assert.deepEqual(state.ratioBasisValues, [200]);
    assert.equal(renderCount, 1);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test("newer Ratio Basis refresh owns status after an older engine load finishes", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { ResultSelectionParts: {} };

  let activeBasis = "Basis A";
  let resolveOlderEngine;
  const statuses = [];
  globalThis.fetch = async (url, options) => {
    const route = String(url);
    const request = JSON.parse(options.body);
    if (route === "/arcrho/tri") {
      return new Promise((resolve) => {
        resolveOlderEngine = () => resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, data_path: "Basis A@12@12@cum@dev.csv" }),
        });
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data_format: request.dataset_name === "Basis A" ? "Triangle" : "Vector",
        origin_length: 12,
        values: [[request.dataset_name === "Basis A" ? 100 : 200]],
      }),
    };
  };

  try {
    Function(source)();
    const norm = (value) => String(value || "").trim().toLowerCase();
    const state = {
      project: "Example Project",
      reservingClass: "Example RC",
      ratioBasisValues: [],
      ratioBasisValueSets: [],
    };
    const api = globalThis.window.ResultSelectionParts.installData({
      state,
      cachedRows: [
        { name: "Basis A", datasetType: "Basis A", dataFormat: "Triangle", originLength: 3, sourceKind: "engine" },
        { name: "Basis B", datasetType: "Basis B", dataFormat: "Vector", originLength: 12, sourceKind: "input" },
      ],
      datasetTypeItems: [],
      text: (value) => String(value || "").trim(),
      norm,
      validSourceOriginLength: (value) => Number(value) || 0,
      numberOrNull: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
      isEngineSource: (item) => norm(item?.sourceKind || item?.source_kind) === "engine",
      isVectorSource: (item) => norm(item?.dataFormat || item?.data_format) === "vector",
      getDetails: () => ({ originLength: 12 }),
      syncRatioBasisSelector: () => {},
      getActiveRatioBasisName: () => activeBasis,
      renderMethodGrid: () => {},
      postStatus: (message, tone = "") => statuses.push({ message, tone }),
      ratioBasisValuesForName,
      upsertRatioBasisValueSet,
    });

    const older = api.refreshRatioBasisValues();
    assert.equal(statuses.at(-1)?.message, "Loading Basis A at origin length 12...");

    activeBasis = "Basis B";
    const newer = api.refreshRatioBasisValues();
    assert.equal(await newer, true);
    assert.deepEqual(state.ratioBasisValues, [200]);
    assert.deepEqual(statuses.at(-1), {
      message: "Ratio Basis 'Basis B' ready.",
      tone: "",
    });

    const statusCountAfterNewer = statuses.length;
    resolveOlderEngine();
    assert.equal(await older, false);
    assert.equal(statuses.length, statusCountAfterNewer);
    assert.deepEqual(statuses.at(-1), {
      message: "Ratio Basis 'Basis B' ready.",
      tone: "",
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test("older missing-basis refresh cannot replace a newer basis list", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { ResultSelectionParts: {} };
  const pending = new Map();
  let basisNames = ["Basis A"];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Promise((resolve) => {
      pending.set(request.dataset_name, (value) => resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data_format: "Vector",
          origin_length: 12,
          values: [[value]],
        }),
      }));
    });
  };

  try {
    Function(source)();
    const state = {
      project: "Example Project",
      reservingClass: "Example RC",
      datasetCatalogLoaded: true,
      ratioBasisValues: [],
      ratioBasisValueSets: [],
    };
    const api = globalThis.window.ResultSelectionParts.installData({
      state,
      cachedRows: [
        { name: "Basis A", dataFormat: "Vector", originLength: 12 },
        { name: "Basis B", dataFormat: "Vector", originLength: 12 },
      ],
      datasetTypeItems: [],
      text: (value) => String(value || "").trim(),
      norm: (value) => String(value || "").trim().toLowerCase(),
      validSourceOriginLength: (value) => Number(value) || 0,
      numberOrNull: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
      isEngineSource: () => false,
      getDetails: () => ({ originLength: 12 }),
      getRatioBasisNames: () => basisNames.slice(),
      getActiveRatioBasisName: () => basisNames[0] || "",
      renderMethodGrid: () => {},
      normalizeRatioBasisValueSets,
      ratioBasisValuesForName,
      upsertRatioBasisValueSet,
    });

    const older = api.refreshMissingRatioBasisValues();
    basisNames = ["Basis B"];
    const newer = api.refreshMissingRatioBasisValues();
    for (let index = 0; index < 8 && (!pending.has("Basis A") || !pending.has("Basis B")); index += 1) {
      await Promise.resolve();
    }
    pending.get("Basis B")(200);
    assert.equal(await newer, true);
    pending.get("Basis A")(100);
    assert.equal(await older, false);
    assert.deepEqual(state.ratioBasisValueSets, [{ name: "Basis B", values: [200] }]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test("engine source length metadata controls whether Result Selection materializes", async () => {
  const source = await readFile(
    new URL("../ui/method_pages/result_selection/result_selection_data.js", import.meta.url),
    "utf8",
  );
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { ResultSelectionParts: {} };
  const requests = [];
  const cacheLoadOutcomes = [];
  globalThis.fetch = async (url, options) => {
    const route = String(url);
    const request = JSON.parse(options.body);
    requests.push({ route, request });
    const isEngineRequest = route.startsWith("/arcrho/");
    const cacheLoadOutcome = isEngineRequest ? null : cacheLoadOutcomes.shift();
    if (cacheLoadOutcome?.status) {
      return {
        ok: false,
        status: cacheLoadOutcome.status,
        json: async () => ({ detail: cacheLoadOutcome.detail }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => isEngineRequest
        ? { ok: true, data_path: "Paid@12@12@cum@dev.csv" }
        : {
            ok: true,
            data_format: "Triangle",
            origin_length: cacheLoadOutcome?.originLength ?? 12,
            values: [[1]],
          },
    };
  };

  try {
    Function(source)();
    const norm = (value) => String(value || "").trim().toLowerCase();
    const api = globalThis.window.ResultSelectionParts.installData({
      state: { project: "Example Project", reservingClass: "Example RC" },
      cachedRows: [],
      datasetTypeItems: [],
      text: (value) => String(value || "").trim(),
      norm,
      validSourceOriginLength: (value) => Number(value) || 0,
      numberOrNull: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
      isEngineSource: (item) => norm(item?.sourceKind || item?.source_kind) === "engine",
      isVectorSource: () => false,
      getDetails: () => ({ originLength: 12 }),
      postStatus: () => {},
    });

    await api.loadSourceDatasetPayload({
      name: "Paid",
      datasetType: "Paid",
      sourceKind: "engine",
      originLength: 12,
    });
    assert.deepEqual(requests.splice(0).map((item) => item.route), ["/dataset/cache/load"]);

    await api.loadSourceDatasetPayload({
      name: "Paid",
      datasetType: "Paid",
      sourceKind: "engine",
      originLength: 3,
    });
    assert.deepEqual(
      requests.splice(0).map((item) => item.route),
      ["/arcrho/tri", "/dataset/cache/load"],
    );

    await api.loadSourceDatasetPayload({
      name: "Paid",
      datasetType: "Paid",
      sourceKind: "engine",
      originLength: 0,
    });
    assert.deepEqual(requests.splice(0).map((item) => item.route), ["/dataset/cache/load"]);

    cacheLoadOutcomes.push({ originLength: 3 });
    await api.loadSourceDatasetPayload({
      name: "Paid",
      datasetType: "Paid",
      sourceKind: "engine",
      originLength: 0,
    });
    const mismatchRequests = requests.splice(0);
    assert.deepEqual(
      mismatchRequests.map((item) => item.route),
      ["/dataset/cache/load", "/arcrho/tri", "/dataset/cache/load"],
    );
    assert.equal("origin_length" in mismatchRequests[0].request, false);
    assert.equal(mismatchRequests[2].request.csv_file, "Paid@12@12@cum@dev.csv");
    assert.equal(mismatchRequests[2].request.origin_length, 12);
    assert.equal(mismatchRequests[2].request.development_length, 12);

    cacheLoadOutcomes.push({ status: 404, detail: "Cached dataset CSV not found." });
    await api.loadSourceDatasetPayload({
      name: "Paid",
      datasetType: "Paid",
      sourceKind: "engine",
      originLength: 0,
    });
    const missingRequests = requests.splice(0);
    assert.deepEqual(
      missingRequests.map((item) => item.route),
      ["/dataset/cache/load", "/arcrho/tri", "/dataset/cache/load"],
    );
    assert.equal("origin_length" in missingRequests[0].request, false);
    assert.equal(missingRequests[2].request.csv_file, "Paid@12@12@cum@dev.csv");
    assert.equal(missingRequests[2].request.origin_length, 12);
    assert.equal(missingRequests[2].request.development_length, 12);
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
