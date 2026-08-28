import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Browsing History separates Project Instances, My Workspace folders, and Dataset records", async () => {
  const html = await read("../ui/shell/browsing_history.html");
  const main = await read("../ui/shell/browsing_history_main.js");
  const workspaceHistory = await read("../ui/shared/services/workspace_history.js");
  const explorer = await read("../ui/file_explorer/file_explorer.js");
  assert.match(html, /<h2 class="groupTitle">Project Instances<\/h2>/u);
  assert.match(html, /<h2 class="groupTitle">My Workspace Folders<\/h2>/u);
  assert.match(html, /<h2 class="groupTitle">Datasets<\/h2>/u);
  assert.match(main, /entry\.tabType === "project_instance"/u);
  assert.match(main, /getWorkspaceHistoryEntries/u);
  assert.match(main, /arcrho:open-file-explorer-from-history/u);
  assert.match(workspaceHistory, /arcrho_workspace_history_v1/u);
  assert.match(explorer, /pushWorkspaceHistoryEntry/u);
});

test("Browsing History rows carry the shell tab-type icon and a filter strip", async () => {
  const html = await read("../ui/shell/browsing_history.html");
  const main = await read("../ui/shell/browsing_history_main.js");
  const css = await read("../ui/shell/browsing_history.css");
  assert.match(html, /\/ui\/shell\/tab-type-icons\/tab_type_icons\.css\?v=/u);
  assert.match(html, /id="filterInput"/u);
  assert.match(main, /icon\.className = "tabTypeIcon rowIcon"/u);
  assert.match(main, /attachArcrhoTooltip/u);
  // Theme colors come from the shared tokens, not page-local hex values.
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/iu);
});
