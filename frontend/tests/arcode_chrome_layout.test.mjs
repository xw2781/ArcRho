import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const ARCODE_DOCUMENTS = [
  "../ui/arcode/main.html",
  "../ui/arcode/code-editor/index.html",
  "../ui/arcode/notebook-editor/index.html",
  "../ui/arcode/snowflake-console/index.html",
  "../ui/arcode/sql-server-console/index.html",
];

test("every Arcode document loads the shared chrome tokens before its own stylesheet", () => {
  for (const path of ARCODE_DOCUMENTS) {
    const html = read(path);
    const chrome = html.indexOf("/ui/arcode/shared/chrome.css");
    const light = html.indexOf("/ui/shared/styles/themes/light.css");
    assert.ok(chrome >= 0, `${path} loads the shared Arcode chrome tokens`);
    assert.ok(chrome < light, `${path} defines chrome tokens before the theme sheets override them`);
  }
});

test("Arcode panes are separated by one hairline seam instead of a gutter", () => {
  const chrome = read("../ui/arcode/shared/chrome.css");
  const shell = read("../ui/arcode/main.css");
  const notebook = read("../ui/arcode/notebook-editor/notebook-editor.css");

  assert.match(chrome, /--ark-seam:\s*1px/);
  // Home and open-file layouts share one explorer seam width.
  assert.match(shell, /\.arcodeHomeLayout,\s*\.arcodeWorkspaceLayout \{[^}]*grid-template-columns:[^;]*var\(--ark-seam\)/);
  assert.match(shell, /\.arcodeFrameWorkspace\.withExplorer \{[^}]*grid-template-columns:[^;]*var\(--ark-seam\)/);
  // The seam is the separator, so the sidebar must not add a second border.
  assert.doesNotMatch(shell, /\.arcodeHomeSidebar \{[^}]*border-right/);
  assert.match(shell, /\.arcodeExplorerResizer \{[^}]*background:\s*var\(--ark-border\)/);
  assert.match(shell, /\.arcodeExplorerResizer::before \{[^}]*inset:\s*0 calc\(-1 \* var\(--ark-seam-grab\)\)/);
  assert.match(notebook, /\.sc-resize-handle \{[^}]*width:\s*var\(--ark-seam\)/);
  assert.doesNotMatch(notebook, /\.sc-sidebar-content \{[^}]*border-left/);
});

test("Arcode command strips carry actions only, not duplicated file or status labels", () => {
  const shell = read("../ui/arcode/main.js");
  const shellCss = read("../ui/arcode/main.css");
  const frameworkCss = read("../ui/arcode/shared/editor_framework.css");
  const frameworkJs = read("../ui/arcode/shared/editor_framework.js");
  const notebook = read("../ui/arcode/notebook-editor/index.html");
  const notebookIo = read("../ui/arcode/notebook-editor/notebook-io.js");

  // The explorer header carries a generic "Workspace" title plus its actions;
  // it must not duplicate the active folder name, which the root row already shows.
  assert.doesNotMatch(shell, /arcodeExplorerWorkspaceName/);
  assert.doesNotMatch(shellCss, /arcodeExplorerWorkspaceName/);
  assert.match(shell, /id="arcodeExplorerAddFolderBtn"/);
  assert.match(shell, /id="arcodeExplorerRefreshBtn"/);

  // The tab bar names the open file and the shell status bar reports state.
  // One framework draws every editor page, so one check covers all of them.
  assert.doesNotMatch(frameworkJs, /id="fileLabel"|id="statusText"/);
  assert.doesNotMatch(frameworkCss, /\.ce-(file|status|spacer)\s*[,{]/);
  assert.match(frameworkJs, /function setStatus\(text\) \{\s*const value[^}]*shared\.postStatus\(value\);\s*\}/);
  assert.doesNotMatch(notebook, /id="statusText"/);
  assert.match(notebookIo, /function setStatus\(text\) \{\s*postShellStatus\(text\);\s*\}/);
});

test("Output panel actions live in the panel header, not the editor command strip", () => {
  const css = read("../ui/arcode/shared/editor_framework.css");
  const js = read("../ui/arcode/shared/editor_framework.js");

  const toolbar = js.match(/<header class="ce-toolbar">[\s\S]*?<\/header>/)?.[0] || "";
  const panelHeader = js.match(/<div class="ce-panel-header">[\s\S]*?<\/div>/)?.[0] || "";
  assert.doesNotMatch(toolbar, /id="clearOutputBtn"/);
  // File-level commands stay in the File menu and on their shortcuts.
  assert.doesNotMatch(toolbar, /id="saveBtn"|id="saveAsBtn"/);
  assert.match(js, /key === "s"[\s\S]*?void saveCurrentFile\(\{ saveAs: event\.shiftKey \}\)/);
  assert.match(panelHeader, /id="clearOutputBtn"/);
  assert.match(js, /clearOutputBtn"\)\?\.addEventListener\("click"/);
  assert.match(css, /\.ce-panel-btn \{/);
});

test("Arcode chrome labels stay title case and command buttons stay quiet", () => {
  const shellCss = read("../ui/arcode/main.css");
  const codeEditorCss = read("../ui/arcode/shared/editor_framework.css");

  // V18: no interface label is set in full uppercase.
  assert.doesNotMatch(shellCss, /text-transform:\s*uppercase/);
  assert.doesNotMatch(codeEditorCss, /text-transform:\s*uppercase/);
  // C02: only the primary action is tinted; the rest are flat until hover.
  assert.match(codeEditorCss, /\.ce-btn \{[^}]*border:\s*1px solid transparent[^}]*background:\s*transparent/);
  assert.match(codeEditorCss, /\.ce-btn:hover:not\(:disabled\) \{[^}]*background:\s*var\(--ark-surface-hover\)/);
  assert.match(codeEditorCss, /\.ce-btn\.primary \{[^}]*background:\s*var\(--ark-accent-soft\)/);
});

test("Arcode Home cards lift without a tinted glow", () => {
  const shellCss = read("../ui/arcode/main.css");
  const dark = read("../ui/shared/styles/themes/dark.css");

  assert.doesNotMatch(shellCss, /\.arcodeCreateCard::before/);
  assert.doesNotMatch(dark, /\.arcodeCreateCard:hover::before/);
  const hover = shellCss.match(/\.arcodeCreateCard:hover,\s*\.arcodeCreateCard:focus-visible \{([^}]*)\}/)?.[1] || "";
  assert.match(hover, /box-shadow:\s*0 8px 20px rgba\(15, 23, 42, 0\.08\)/);
  assert.doesNotMatch(hover, /rgba\(43, 109, 246/);
});
