import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailsControllerSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_details_controller.js", import.meta.url),
  "utf8",
);

test("Details precedent and dependent links both request method-aware routing", () => {
  const dependentsRenderer = detailsControllerSource.match(
    /function renderDatasetDependents[\s\S]*?function renderDatasetPrecedents/u,
  )?.[0] || "";
  const precedentsRenderer = detailsControllerSource.match(
    /function renderDatasetPrecedents[\s\S]*?function getDatasetInitialTab/u,
  )?.[0] || "";

  assert.match(
    dependentsRenderer,
    /openRelatedDataset\(dependent, \{ openMethod: true \}\)/u,
  );
  assert.match(
    precedentsRenderer,
    /openRelatedDataset\(precedent, \{ openMethod: true \}\)/u,
  );
  assert.match(detailsControllerSource, /if \(text === "cape cod"\) return "Cape Cod"/u);
});

test("Project Instance falls back to Dataset Viewer when method-aware routing finds no method", async () => {
  const messagesSource = await readFile(
    new URL("../ui/project_instance/project_instance_messages.js", import.meta.url),
    "utf8",
  );
  const handler = messagesSource.match(
    /function handleOpenDependentDataset[\s\S]*?function handleAutomationWindowCommand/u,
  )?.[0] || "";

  assert.match(handler, /const openMethod = !!message\?\.openMethod/u);
  assert.match(handler, /else \{\s*frame = openDatasetWindow\(datasetName,/u);
});
