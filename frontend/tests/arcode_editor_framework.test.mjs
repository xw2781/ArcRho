import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const framework = () => read("../ui/arcode/shared/editor_framework.js");

test("one framework draws every Arcode editor page", () => {
  const source = framework();
  const pages = [
    "../ui/arcode/code-editor/index.html",
    "../ui/arcode/snowflake-console/index.html",
    "../ui/arcode/sql-server-console/index.html",
  ];

  assert.match(source, /export function createEditorPage\(mode\)/);
  for (const path of pages) {
    const html = read(path);
    assert.match(html, /<div id="editorRoot"><\/div>/, `${path} hosts the framework chrome`);
    assert.match(html, /shared\/editor_framework\.css\?v=/, `${path} loads the framework stylesheet`);
    // No page restates the command strip, the banner, or the panel.
    assert.doesNotMatch(html, /ce-toolbar|ce-file-banner|ce-output-panel/, `${path} draws no chrome of its own`);
  }
});

test("Run acts on the selection when there is one", () => {
  const source = framework();

  // One selection rule, used by Run and by the ArcBot context alike.
  assert.match(source, /function getSelectionContext\(\) \{[\s\S]*?if \(!selected\.trim\(\)\) \{\s*return \{ text: editor\.getValue\(\)/);
  assert.match(
    source,
    /async function runNow\(\) \{[\s\S]*?const context = getSelectionContext\(\);[\s\S]*?selectionOnly: context\.selectionOnly/,
  );
  assert.match(source, /runBtn"\)\?\.addEventListener\("click", \(\) => void runNow\(\)\)/);
  // Ctrl+Enter is the same command as the button, with no second Run variant.
  const enterBranch = source.match(/key === "enter"\) \{[\s\S]*?\n      \}/)?.[0] || "";
  assert.match(enterBranch, /void runNow\(\)/);
  assert.doesNotMatch(enterBranch, /shiftKey/);
  assert.doesNotMatch(source, /runSelectionBtn|Run Selection/);
});

test("the command strip carries icon commands and no Test or Format button", () => {
  const source = framework();
  const css = read("../ui/arcode/shared/editor_framework.css");

  // Glyphs are defined once and used by every command button.
  assert.match(source, /export const TOOLBAR_ICONS = \{/);
  for (const icon of ["run:", "stop:", "restart:"]) {
    assert.ok(source.includes(icon), `TOOLBAR_ICONS defines ${icon}`);
  }
  assert.match(source, /function commandButton\(\{ id, label, icon/);
  assert.match(source, /\$\{iconMarkup\(icon\)\}<span class="ce-btn-label">\$\{label\}<\/span>/);
  for (const id of ["runBtn", "stopBtn", "restartBtn"]) {
    assert.ok(source.includes(`id: "${id}"`), `the command strip defines ${id}`);
  }
  assert.doesNotMatch(source, /formatBtn|testConnectionBtn|saveBtn/);
  assert.match(css, /\.ce-btn-icon \{[^}]*stroke: currentColor/);
});

test("Settings opens Database Connections above Color Theme", () => {
  const html = read("../ui/arcode/main.html");
  const shell = read("../ui/arcode/main.js");

  const settingsMenu = html.match(/<div id="settingsMenuDropdown"[\s\S]*?\n  <\/div>/)?.[0] || "";
  assert.ok(settingsMenu, "the settings menu exists");
  assert.ok(
    settingsMenu.indexOf('data-action="database-connections"') < settingsMenu.indexOf("arcodeColorThemeMenuItem"),
    "Database Connections sits above Color Theme",
  );
  assert.match(shell, /if \(action === "database-connections"\) return databaseConnectionsDialog\.open\(\);/);
  assert.match(html, /id="dbcBackdrop"/);
  assert.match(html, /database-connections\/database-connections\.css\?v=/);
});

test("the Database Connections dialog edits every engine the same way", () => {
  const dialog = read("../ui/arcode/database-connections/dialog.js");
  const shell = read("../ui/arcode/main.js");

  // The form is generated from the engine descriptor rather than restated.
  assert.match(dialog, /engine\.profileFields\.map\(fieldMarkup\)/);
  assert.match(dialog, /SQL_ENGINES\.map\(\(engine\) =>/);
  // An edit posts the profile it started from, so a rename moves it in place.
  assert.match(dialog, /connection: editingName/);
  // Testing a connection lives here now, and tests what a tab would use.
  assert.match(dialog, /async function testConnection\(\)/);
  assert.match(dialog, /Save the connection before testing it\./);
  // No credential is ever collected for either engine.
  assert.doesNotMatch(dialog, /type="password"/);
  assert.doesNotMatch(dialog, /password/i);
  // Open editors are told, so their pickers never show a stale list.
  assert.match(shell, /onChanged: \(\) => broadcastToTabs\(\{ type: "arcode:database-connections-changed" \}\)/);
});
