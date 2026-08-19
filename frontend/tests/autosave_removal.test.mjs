import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("ArcRho and Arcode keep saving explicit after AutoSave removal", () => {
  const shellHtml = read("../ui/index.html");
  const shellCss = read("../ui/shell/shell.css");
  const shellPreferences = read("../ui/shell/shell_preferences.js");
  const shellHost = read("../ui/shell/iframe_host.js");
  const lifecycle = read("../ui/shell/app_lifecycle.js");
  const workflow = read("../ui/workflow/workflow_main.js");
  const arcodeHtml = read("../ui/arcode/main.html");
  const arcodeCss = read("../ui/arcode/main.css");
  const arcodeMain = read("../ui/arcode/main.js");
  const codeEditor = read("../ui/arcode/code-editor/index.js");
  // Saving belongs to the editor framework every Arcode editor page runs.
  const editorFramework = read("../ui/arcode/shared/editor_framework.js");
  const notebookCore = read("../ui/arcode/notebook-editor/core.js");
  const notebookIo = read("../ui/arcode/notebook-editor/notebook-io.js");
  const notebookIndex = read("../ui/arcode/notebook-editor/index.js");

  assert.doesNotMatch(shellHtml, /id="autoSave(?:Toggle|Switch|State)"/u);
  assert.doesNotMatch(arcodeHtml, /id="arcodeAutoSave/u);
  assert.doesNotMatch(shellCss, /\.auto(?:saveToggle|Switch)/u);
  assert.doesNotMatch(arcodeCss, /\.auto(?:saveToggle|Switch)/u);

  for (const [name, source] of Object.entries({
    shellPreferences,
    shellHost,
    lifecycle,
    workflow,
    arcodeMain,
    codeEditor,
    editorFramework,
    notebookCore,
    notebookIo,
    notebookIndex,
  })) {
    assert.doesNotMatch(source, /(?:arcrho|arcode):autosave-toggle/u, `${name} has no AutoSave message path`);
    assert.doesNotMatch(source, /\bautoSave\w*/u, `${name} has no AutoSave state or timer`);
  }

  assert.match(workflow, /type === "arcrho:workflow-save"[\s\S]*?saveWorkflowToDefaultDir\(\{ force: true \}\)/u);
  // The code editor toolbar carries no Save button; saving stays an explicit
  // user gesture through the File menu message and the Ctrl+S handler.
  assert.match(editorFramework, /msg\.type === "arcode:scripting-save"[\s\S]*?void saveCurrentFile\(\)/u);
  assert.match(editorFramework, /key === "s"[\s\S]*?void saveCurrentFile\(\{ saveAs: event\.shiftKey \}\)/u);
  assert.match(notebookIo, /async function saveCurrentNotebookFile\(/u);
  assert.match(arcodeMain, /function confirmWindowClose\(\)/u);
});
