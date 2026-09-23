import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { registerDataTabInputsController } from "../ui/shared/tabs/data/data_tab_inputs_controller.js";

// The DFM page hosts the shared Data tab in its own document, where the id
// "decimalPlaces" is the method's ratio decimal places. Loading the input
// triangle once wrote the triangle's precision (0 for claim counts) into it,
// so a new DFM started at 0 instead of 4.
function withDecimalInput(isDfmHost, run) {
  const input = { value: "4" };
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === "decimalPlaces" ? input : null) };
  const runtime = {
    state: {},
    workflowId: "",
    DEFAULT_TOKEN: "__DEFAULT__",
    isDfmDataTabHost: () => isDfmHost,
    clampDatasetDecimalPlaces: (value) => Math.max(0, Math.min(6, Number.parseInt(String(value), 10) || 0)),
  };
  registerDataTabInputsController(runtime);
  try {
    run(runtime, input);
  } finally {
    globalThis.document = originalDocument;
  }
}

test("a dataset's decimal places never overwrite a DFM's own", () => {
  withDecimalInput(true, (runtime, input) => {
    runtime.setDatasetDecimalPlacesValue(0);
    assert.equal(input.value, "4");
  });
});

test("the Dataset Viewer still takes the dataset's decimal places", () => {
  withDecimalInput(false, (runtime, input) => {
    runtime.setDatasetDecimalPlacesValue(0);
    assert.equal(input.value, "0");
  });
});

test("a new DFM's Decimal Places box starts at 4", async () => {
  const html = await readFile(new URL("../ui/method_pages/dfm/dfm.html", import.meta.url), "utf8");
  assert.match(html, /<input id="decimalPlaces" type="number" min="0" max="6" value="4"/u);
});
