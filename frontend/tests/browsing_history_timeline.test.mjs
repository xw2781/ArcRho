import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Browsing History merges Project Instances, My Workspace folders, and Dataset records into one timeline", async () => {
  const html = await read("../ui/shell/browsing_history.html");
  const main = await read("../ui/shell/browsing_history_main.js");
  const workspaceHistory = await read("../ui/shared/services/workspace_history.js");
  const explorer = await read("../ui/file_explorer/file_explorer.js");
  assert.match(html, /id="timeline"/u);
  assert.match(html, /data-kind="all" aria-pressed="true"/u);
  assert.match(html, /data-kind="project_instance"/u);
  assert.match(html, /data-kind="file_explorer"/u);
  assert.match(html, /data-kind="dataset"/u);
  assert.match(main, /entry\.tabType === "project_instance"/u);
  assert.match(main, /getWorkspaceHistoryEntries/u);
  assert.match(main, /arcrho:open-file-explorer-from-history/u);
  assert.match(main, /arcrho:open-dataset-from-history/u);
  assert.match(main, /arcrho:open-shell-activity-history-entry/u);
  // One stream, newest first, split into day groups that each hold a date header and its rows.
  assert.match(main, /sort\(\(a, b\) => b\.ts - a\.ts\)/u);
  assert.match(main, /group\.className = "dayGroup"/u);
  // Consecutive records on the same day join one group; the comparison is day key to day key.
  assert.match(main, /if \(last && last\.day === day\) last\.records\.push\(record\);/u);
  // A date header is a button that folds its day away and back; it carries no record count.
  assert.match(main, /header\.setAttribute\("aria-expanded", collapsed \? "false" : "true"\)/u);
  assert.match(main, /group\.classList\.toggle\("isCollapsed", collapsed\)/u);
  assert.doesNotMatch(main, /dayCount/u);
  assert.match(main, /header\.className = "dayHeader"/u);
  // The page-type switch is the only filter; there is no text filter box.
  assert.doesNotMatch(html, /filterInput/u);
  assert.doesNotMatch(main, /filterInput/u);
  assert.match(workspaceHistory, /arcrho_workspace_history_v1/u);
  assert.match(explorer, /pushWorkspaceHistoryEntry/u);
});

test("Browsing History rows sit on a spine, carry the shell tab-type icon, and enter with short motion", async () => {
  const html = await read("../ui/shell/browsing_history.html");
  const main = await read("../ui/shell/browsing_history_main.js");
  const css = await read("../ui/shell/browsing_history.css");
  assert.match(html, /\/ui\/shell\/tab-type-icons\/tab_type_icons\.css\?v=/u);
  assert.match(main, /icon\.className = "tabTypeIcon rowIcon"/u);
  assert.match(main, /attachArcrhoTooltip/u);
  // Only a record that was not on the page a moment ago animates in.
  assert.match(main, /if \(!shownKeys\.has\(key\)\)/u);
  assert.match(main, /classList\.add\("isNew"\)/u);
  assert.match(css, /\.spine::before/u);
  // Rows share the timeline's columns, so every detail starts on one line across the page.
  assert.match(css, /grid-template-columns: subgrid;/u);
  assert.match(css, /\.dayGroup\.isCollapsed > \.dayRows \{\s*grid-template-rows: 0fr;/u);
  assert.match(main, /row\.append\(time, spine, icon, nameEl, detail, go\);/u);
  assert.match(css, /\.dayHeader \{\s*position: sticky;/u);
  assert.match(css, /@keyframes historyEnter/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  // Theme colors come from the shared tokens, not page-local hex values.
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/iu);
});
