import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDatasetSaveStatus,
  collectDatasetPropagationFailures,
  datasetPropagationFailureStep,
} from "../ui/shared/tabs/data/data_tab_propagation_report.js";


test("dataset propagation failures include calculated, DFM, Result Selection, BF, Cape Cod, and Bootstrap details", () => {
  const report = {
    ok: false,
    steps: [{
      ok: false,
      dataset_type_name: "Calculated Ratio",
      reason: "calculation_error",
      errors: ["Division by zero"],
    }],
    dfm_updates: {
      ok: false,
      errors: [{ dataset_name: "DFM Paid", reason: "Input triangle refresh failed" }],
    },
    result_selection_updates: {
      ok: false,
      errors: [{ dataset_name: "Selected Ultimate", reason: "Ratio Basis is unreadable" }],
    },
    bornhuetter_ferguson_updates: {
      ok: false,
      errors: [{
        dataset_name: "BF Reported",
        reason: "Prior vector refresh failed",
        cascade: {
          ok: false,
          errors: [{ dataset_name: "BF Downstream", reason: "Dependent refresh failed" }],
        },
      }],
    },
    cape_cod_updates: {
      ok: false,
      errors: [{ dataset_name: "CC Reported", reason: "Exposure vector refresh failed" }],
    },
    bootstrap_updates: {
      ok: false,
      errors: [{ dataset_name: "BST Incurred", reason: "Required Bootstrap precedent needs review: DFM Paid" }],
    },
  };

  const failures = collectDatasetPropagationFailures(report);
  assert.deepEqual(
    failures.map(({ scope, datasetName, reason }) => [scope, datasetName, reason]),
    [
      ["Calculated dataset", "Calculated Ratio", "calculation_error"],
      ["DFM", "DFM Paid", "Input triangle refresh failed"],
      ["Result Selection", "Selected Ultimate", "Ratio Basis is unreadable"],
      ["Bornhuetter Ferguson", "BF Reported", "Prior vector refresh failed"],
      ["Bornhuetter Ferguson downstream", "BF Downstream", "Dependent refresh failed"],
      ["Cape Cod", "CC Reported", "Exposure vector refresh failed"],
      ["Bootstrap", "BST Incurred", "Required Bootstrap precedent needs review: DFM Paid"],
    ],
  );
  assert.deepEqual(datasetPropagationFailureStep(failures[3]), {
    ok: false,
    skipped: true,
    status: "failed",
    dataset_type_name: "Bornhuetter Ferguson: BF Reported",
    reason: "Prior vector refresh failed",
    errors: [],
  });
});


test("dataset save status distinguishes a committed source from failed downstream refresh", () => {
  const outcome = buildDatasetSaveStatus({
    ok: true,
    propagation_ok: false,
    calculated_updates: {
      ok: false,
      bornhuetter_ferguson_updates: {
        ok: false,
        errors: [{
          dataset_name: "C 41 - BF Reported ex CWOP",
          reason: "Prior source could not be refreshed",
        }],
      },
    },
  });

  assert.equal(outcome.tone, "warn");
  assert.match(outcome.text, /^Dataset saved, but downstream refresh failed:/u);
  assert.match(outcome.text, /Bornhuetter Ferguson C 41 - BF Reported ex CWOP/u);
  assert.match(outcome.text, /Prior source could not be refreshed/u);
  assert.deepEqual(buildDatasetSaveStatus({ propagation_ok: true }), {
    text: "Dataset settings saved.",
    tone: "",
  });
});


test("successful no-change method skips are not reported as propagation failures", () => {
  const report = {
    ok: true,
    dfm_updates: {
      ok: true,
      skipped: [{ dataset_name: "DFM Paid", reason: "not_updated" }],
    },
  };

  assert.deepEqual(collectDatasetPropagationFailures(report), []);
});


test("dataset dependency previews clear only after the awaited save response", async () => {
  const source = await readFile(
    new URL("../ui/shared/tabs/data/data_tab_persistence_controller.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function saveDatasetSidecarForCurrentContext()");
  const end = source.indexOf("async function saveDatasetChanges", start);
  const saveFlow = source.slice(start, end);

  const request = saveFlow.indexOf("const resp = await saveDatasetSidecar(");
  const responseCheck = saveFlow.indexOf("if (!resp.ok)", request);
  const clear = saveFlow.indexOf('clearDatasetDependencyPreview("save")', responseCheck);
  assert.ok(request >= 0, "save request is awaited");
  assert.ok(responseCheck > request, "HTTP response is checked after the awaited request");
  assert.ok(clear > responseCheck, "preview clear remains after the completed save response");
});
