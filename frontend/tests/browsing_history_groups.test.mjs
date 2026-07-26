import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Browsing History separates Project Instances, My Workspace paths, and Dataset Viewer records", async () => {
  const html = await read("../ui/shell/browsing_history.html");
  const main = await read("../ui/shell/browsing_history_main.js");
  const workspaceHistory = await read("../ui/shared/services/workspace_history.js");
  const explorer = await read("../ui/file_explorer/file_explorer.js");
  assert.match(html, /Project Instances/u);
  assert.match(html, /Recent My Workspace Paths/u);
  assert.match(html, /<h2 class="sectionTitle">Other<\/h2>/u);
  assert.match(main, /entry\.tabType === "project_instance"/u);
  assert.match(main, /getWorkspaceHistoryEntries/u);
  assert.match(main, /arcrho:open-file-explorer-from-history/u);
  assert.match(workspaceHistory, /arcrho_workspace_history_v1/u);
  assert.match(explorer, /pushWorkspaceHistoryEntry/u);
});
