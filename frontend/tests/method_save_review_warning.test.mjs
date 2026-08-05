import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  methodSaveReviewWarningCopy,
  methodReviewDatasetOpenMessage,
  openMethodReviewDataset,
  unreviewedPrecedentNames,
} from "../ui/shared/components/message_box/method_save_review_warning.js";

const frontendRoot = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, frontendRoot), "utf8");
}

test("method save review warning reports the canonical unique precedent count", () => {
  const result = {
    unreviewed_precedents: ["DFM Output", "dfm output", "BF Output"],
  };
  assert.deepEqual(unreviewedPrecedentNames(result), ["DFM Output", "BF Output"]);
  assert.deepEqual(methodSaveReviewWarningCopy(result), {
    count: 2,
    names: ["DFM Output", "BF Output"],
    title: "Method saved with review warning",
    message: "2 precedent datasets have not been reviewed. The current method was saved.",
  });
  assert.equal(methodSaveReviewWarningCopy({ unreviewed_precedents: [] }), null);
});

test("review warning links request the related method window in the hosting Project Instance", () => {
  const message = methodReviewDatasetOpenMessage("DFM Output", {
    instanceId: "dfm-1",
    projectName: "Project",
    reservingClass: "Class",
  });
  assert.deepEqual(message, {
    type: "arcrho:project-instance-open-dependent-dataset",
    inst: "dfm-1",
    datasetName: "DFM Output",
    openMethod: true,
    project: "Project",
    reservingClass: "Class",
  });

  const posted = [];
  const windowRef = {
    parent: {
      postMessage: (...args) => posted.push(args),
    },
  };
  assert.equal(openMethodReviewDataset("DFM Output", { windowRef }), true);
  assert.equal(posted[0][0].type, "arcrho:project-instance-open-dependent-dataset");
  assert.equal(posted[0][0].openMethod, true);
  assert.equal(posted[0][1], "*");
});

test("all method pages show the shared warning only after successful save", async () => {
  const [dfm, bf, cc, rsMain, rsModel, bs] = await Promise.all([
    source("ui/method_pages/dfm/dfm_persistence.js"),
    source("ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js"),
    source("ui/method_pages/cape_cod/cape_cod_main.js"),
    source("ui/method_pages/result_selection/result_selection_main.js"),
    source("ui/method_pages/result_selection/result_selection_model.js"),
    source("ui/method_pages/berquist_sherman/berquist_sherman_main.js"),
  ]);
  assert.match(dfm, /await showMethodSaveReviewWarning\(response,\s*\{/u);
  assert.match(bf, /await showMethodSaveReviewWarning\(result,\s*\{/u);
  assert.match(cc, /await showMethodSaveReviewWarning\(result,\s*\{/u);
  assert.match(rsMain, /showMethodSaveReviewWarning/u);
  assert.match(rsModel, /await showMethodSaveReviewWarning\(payload,\s*\{/u);
  assert.match(bs, /await showMethodSaveReviewWarning\(sidecar,\s*\{/u);
});

test("the shared message box renders review names as keyboard-focusable links", async () => {
  const [messageBox, styles] = await Promise.all([
    source("ui/shared/components/message_box/message_box.js"),
    source("ui/shared/components/message_box/message_box.css"),
  ]);
  assert.match(messageBox, /className = "pageMessageBoxLink"/u);
  assert.match(messageBox, /button\.addEventListener\("click"/u);
  assert.match(styles, /\.pageMessageBoxLink:focus-visible/u);
});

test("Project Instance resolves linked method metadata and falls back to Dataset Viewer", async () => {
  const messages = await source("ui/project_instance/project_instance_messages.js");
  assert.match(messages, /function indexedDatasetTypeName\(datasetName\)/u);
  assert.match(messages, /if \(openMethod && methodType === "dfm"\)/u);
  assert.match(messages, /else if \(openMethod && methodType === "result selection"\)/u);
  assert.match(messages, /else if \(openMethod && methodType === "bornhuetter ferguson"\)/u);
  assert.match(messages, /else if \(openMethod && methodType === "cape cod"\)/u);
  assert.match(messages, /else if \(openMethod && bsVariant\)/u);
  assert.match(
    messages,
    /toText\(message\?\.datasetTypeName \|\| message\?\.dataset_type_name\)[\s\S]*?indexedDatasetTypeName\(datasetName\)[\s\S]*?openDatasetWindow\(datasetName,\s*\{[\s\S]*?datasetTypeName/u,
  );
});
