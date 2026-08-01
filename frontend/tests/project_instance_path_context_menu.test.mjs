import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [htmlSource, pathPanelSource, cssSource] = await Promise.all([
  readFile(new URL("../ui/project_instance/project_instance.html", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_path_panel.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance.css", import.meta.url), "utf8"),
]);

test("Project Instance path context menu exposes Copy and Paste", () => {
  assert.match(htmlSource, /id="pathContextMenu"[^>]*role="menu"/u);
  assert.match(htmlSource, /data-path-action="copy">Copy<\/button>/u);
  assert.match(htmlSource, /data-path-action="paste">Paste<\/button>/u);
});

test("right-click highlights the complete toolbar path", () => {
  assert.match(pathPanelSource, /addEventListener\("contextmenu"/u);
  assert.match(pathPanelSource, /range\.selectNodeContents\(target\)/u);
  assert.match(pathPanelSource, /target\.classList\.add\("is-context-selected"\)/u);
  assert.match(cssSource, /\.pi-toolbar-path\.has-path\.is-context-selected/u);
});

test("pasted paths resolve through the picker model and reveal the selected tree leaf", () => {
  assert.match(pathPanelSource, /state\.pathPickerModel\.getPathNode\(requestedPath\)/u);
  assert.match(pathPanelSource, /node\.has_children \|\| node\.hasChildren/u);
  assert.match(
    pathPanelSource,
    /const previousPath = state\.selectedPath;\s*setSelectedPath\(nextPath\);\s*await revealPathTreeSelection\(nextPath, previousPath\);/u,
  );
});
