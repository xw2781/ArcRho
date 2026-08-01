import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pathPanelUrl = new URL("../ui/project_instance/project_instance_path_panel.js", import.meta.url);
const pathPanelSource = await readFile(pathPanelUrl, "utf8");
const cssSource = await readFile(
  new URL("../ui/project_instance/project_instance.css", import.meta.url),
  "utf8",
);
const { matchesPathSegmentSearch } = await import(
  `data:text/javascript;base64,${Buffer.from(pathPanelSource).toString("base64")}`
);

test("path segment search matches case-insensitive substrings and normalized spaces", () => {
  assert.equal(matchesPathSegmentSearch("Auto Liab Total", "liab"), true);
  assert.equal(matchesPathSegmentSearch("Auto   Liab Total", "auto liab"), true);
  assert.equal(matchesPathSegmentSearch("Auto Liab Total", "property"), false);
  assert.equal(matchesPathSegmentSearch("Auto Liab Total", ""), true);
});

test("path segment menu renders and focuses a live search filter", () => {
  assert.match(pathPanelSource, /searchInput\.type = "search"/u);
  assert.match(pathPanelSource, /searchInput\.addEventListener\("input", applySearchFilter\)/u);
  assert.match(pathPanelSource, /if \(menu\.isConnected\) searchInput\.focus/u);
  assert.match(pathPanelSource, /empty\.textContent = "No matching values\."/u);
});

test("path segment results support vertical-only scrolling and keyboard navigation", () => {
  assert.match(cssSource, /\.pi-path-segment-list\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su);
  assert.match(pathPanelSource, /event\.key === "ArrowDown"/u);
  assert.match(pathPanelSource, /event\.key === "Enter" && visibleButtons\.length === 1/u);
});
