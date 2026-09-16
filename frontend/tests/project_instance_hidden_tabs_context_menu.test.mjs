import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [htmlSource, hiddenTabsSource, contextSource, cssSource] = await Promise.all([
  readFile(new URL("../ui/project_instance/project_instance.html", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_hidden_tabs.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_context.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance.css", import.meta.url), "utf8"),
]);

test("the minimized tab bar carries a context menu with the three window actions", () => {
  assert.match(htmlSource, /id="hiddenTabsContextMenu"[^>]*role="menu"/u);
  assert.match(htmlSource, /class="pi-table-context-menu pi-hidden-tabs-context-menu"/u);
  assert.match(htmlSource, /data-hidden-tabs-action="restore-all">Restore windows<\/button>/u);
  assert.match(htmlSource, /data-hidden-tabs-action="minimize-all">Minimize all<\/button>/u);
  assert.match(htmlSource, /data-hidden-tabs-action="close-all">Close all windows<\/button>/u);
  assert.match(contextSource, /hiddenTabsContextMenu: document\.getElementById\("hiddenTabsContextMenu"\)/u);
  assert.match(cssSource, /\.pi-hidden-tabs-context-menu \{/u);
});

test("the empty tab bar keeps full toolbar height so its right-click target survives", () => {
  assert.match(cssSource, /\.pi-hidden-tabs-wrap \{[^}]*align-self: stretch;/su);
  assert.doesNotMatch(cssSource, /\.pi-hidden-tabs-wrap\.empty \{[^}]*display: none;/su);
});

test("right-clicking the minimized tab bar opens the menu and closes the hidden-tabs dropdown", () => {
  assert.match(hiddenTabsSource, /els\.hiddenTabsWrap\.addEventListener\("contextmenu"/u);
  assert.match(
    hiddenTabsSource,
    /openHiddenTabsContextMenu\(clientX, clientY\) \{[^}]*setHiddenTabsMenuOpen\(false, \{ pinned: false \}\);/su,
  );
  assert.match(hiddenTabsSource, /initHiddenTabsArea\(\) \{\s*initHiddenTabsContextMenu\(\);/u);
});

test("each action is disabled while it has nothing to act on", () => {
  assert.match(hiddenTabsSource, /"restore-all": hiddenWindows\.size > 0/u);
  assert.match(hiddenTabsSource, /"minimize-all": visibleCount > 0/u);
  assert.match(hiddenTabsSource, /"close-all": cleanCount > 0/u);
  assert.match(hiddenTabsSource, /item\.disabled = !enabled\[item\.dataset\.hiddenTabsAction\]/u);
  assert.match(hiddenTabsSource, /if \(!item \|\| item\.disabled\) return;/u);
});

test("Minimize all docks every visible window and Close all leaves unsaved windows open", () => {
  assert.match(
    hiddenTabsSource,
    /await Promise\.all\(frames\.map\(\(frame\) => hideDatasetWindow\(frame, getFrameRect\(frame\)\)\)\)/u,
  );
  assert.match(
    hiddenTabsSource,
    /closeAllCleanDatasetWindows\(\) \{[^}]*if \(frame\.dataset\.dirty === "1"\) continue;/su,
  );
  assert.match(hiddenTabsSource, /with unsaved changes stayed open\./u);
});
