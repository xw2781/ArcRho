import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const persistenceSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_persistence_controller.js", import.meta.url),
  "utf8",
);
const messageBoxSource = await readFile(
  new URL("../ui/shared/components/message_box/message_box.js", import.meta.url),
  "utf8",
);
const messageBoxStyles = await readFile(
  new URL("../ui/shared/components/message_box/message_box.css", import.meta.url),
  "utf8",
);

test("DSV schedules a one-time timestamp check after linked sidecar data loads", () => {
  assert.match(persistenceSource, /datasetExcelFreshnessCheckedKeys = new Set\(\)/);
  assert.match(persistenceSource, /window\.setTimeout\(async \(\) => \{/);
  assert.match(persistenceSource, /checkForNewerWorkbooks\(\s*state\.fileMtime/);
  assert.match(persistenceSource, /if \(data\.exists\) scheduleDatasetExcelFreshnessPrompt/);
});

test("freshness prompt defaults to keeping values and refreshes only on request", () => {
  assert.match(persistenceSource, /okLabel: "Keep Current Values"/);
  assert.match(persistenceSource, /actions: \[\{ id: "refresh", label: "Refresh from Excel" \}\]/);
  assert.match(persistenceSource, /balancedActions: true/);
  assert.match(persistenceSource, /if \(choice === "refresh" && isCurrent\(\)\) \{\s*await refreshDatasetExternalLinks/);
  assert.match(messageBoxSource, /okButton\.textContent = String\(okLabel \|\| "OK"\)/);
  assert.match(messageBoxSource, /pageMessageBoxActionsBalanced/);
  assert.match(messageBoxStyles, /\.pageMessageBoxActionsBalanced \{\s*gap: 8px;/);
  assert.match(messageBoxStyles, /\.pageMessageBoxActionsBalanced \.pageMessageBoxButton \{\s*flex: 1 1 0;/);
});
