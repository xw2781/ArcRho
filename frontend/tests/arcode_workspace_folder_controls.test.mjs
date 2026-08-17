import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Arcode explorer header offers add and refresh actions with shared button styling", () => {
  const shell = read("../ui/arcode/main.js");
  const css = read("../ui/arcode/main.css");
  const dark = read("../ui/shared/styles/themes/dark.css");

  assert.match(shell, /id="arcodeExplorerAddFolderBtn" class="arcodeExplorerHeaderBtn"/);
  assert.match(shell, /id="arcodeExplorerRefreshBtn" class="arcodeExplorerHeaderBtn"/);
  assert.match(
    shell,
    /#arcodeExplorerAddFolderBtn"\)\?\.addEventListener\("click", \(\) => \{\s*void pickWorkspaceFolder\(\{ replace: false \}\);/,
  );
  assert.match(css, /\.arcodeExplorerHeaderBtn \{/);
  assert.doesNotMatch(css, /\.arcodeExplorerRefreshBtn/);
  assert.match(dark, /\.arcodeExplorerHeaderBtn\) \{/);
  assert.doesNotMatch(dark, /\.arcodeExplorerRefreshBtn/);
});

test("Arcode explorer root rows expose a remove control wired to removeWorkspaceFolder", () => {
  const shell = read("../ui/arcode/main.js");
  const css = read("../ui/arcode/main.css");

  assert.match(shell, /<div class="arcodeExplorerRootRow" role="none">/);
  assert.match(shell, /class="arcodeExplorerRemoveRootBtn"[^>]*data-path="\$\{encodeURIComponent\(folderPath\)\}"/);
  assert.match(
    shell,
    /\.arcodeExplorerRemoveRootBtn"\)\.forEach[\s\S]{0,220}removeWorkspaceFolder\(decodeURIComponent\(button\.getAttribute\("data-path"\) \|\| ""\)\)/,
  );
  // The remove control must not steal clicks from the row until the row is hovered or the button is focused.
  assert.match(css, /\.arcodeExplorerRemoveRootBtn \{[\s\S]*?opacity: 0;\s*pointer-events: none;/);
  assert.match(
    css,
    /\.arcodeExplorerRootRow:hover \.arcodeExplorerRemoveRootBtn,\s*\.arcodeExplorerRemoveRootBtn:focus-visible \{\s*opacity: 1;\s*pointer-events: auto;/,
  );
});

test("Removing an Arcode workspace root clears only its explorer state", () => {
  const shell = read("../ui/arcode/main.js");
  const body = shell.slice(shell.indexOf("function removeWorkspaceFolder("));

  assert.match(body, /const remaining = current\.filter\(\(item\) => explorerPathKey\(item\) !== folderKey\)/);
  assert.match(body, /if \(remaining\.length === current\.length\) return;/);
  assert.match(body, /explorerPathKey\(state\.activeWorkspaceFolder\) === folderKey[\s\S]{0,120}remaining\[0\] \|\| ""/);
  assert.match(body, /expandedExplorerPaths[\s\S]{0,160}!explorerPathWithin\(folderPath, item\)/);
  assert.match(body, /Object\.keys\(state\.folderListings\)[\s\S]{0,160}delete state\.folderListings\[listedPath\]/);
  // saveWorkspaceFolders persists the roots and re-syncs folder watchers for the surviving tree.
  assert.match(body, /saveExpandedExplorerPaths\(\);\s*saveWorkspaceFolders\(\);\s*render\(\);/);
});
