import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

// `body` is a flex column that never scrolls, so an over-tall row is resolved by shrinking whatever
// may shrink. A shrinkable titlebar plus a content row sized from its own content meant a tall page
// - Home with many custom groups - stole height from the chrome, and switching tabs changed it back.
test("shell chrome keeps its height whatever the page below it contains", async () => {
  const styles = await read("../ui/shell/shell.css");

  assert.match(styles, /#customTitlebar\s*\{[^}]*flex:\s*0 0 30px/su, "the titlebar never shrinks");
  assert.match(styles, /\.content\s*\{[^}]*flex:\s*1 1 0/su, "the content row takes what is left, not what it holds");
  assert.match(styles, /\.menubar\s*\{[^}]*flex:\s*0 0 25px/su);
  assert.match(styles, /#statusBar\s*\{[^}]*flex:\s*0 0 var\(--statusbar-h\)/su);
  assert.match(styles, /\.topbar\s*\{[^}]*min-height:\s*34px/su, "the tab strip is floored by its min-height");
});

test("Home drops the dataset and method launch group so methods open from Project Instance", async () => {
  const view = await read("../ui/shell/home_view.js");
  const styles = await read("../ui/shell/shell.css");

  assert.doesNotMatch(view, /homeLaunchDataGroup/u);
  assert.doesNotMatch(view, /Datasets &amp; Methods/u);
  for (const cardId of [
    "cardOpenDataset",
    "cardOpenDfm",
    "cardOpenBornhuetterFerguson",
    "cardOpenCapeCod",
    "cardOpenResultSelection",
  ]) {
    assert.doesNotMatch(view, new RegExp(`id="${cardId}"`, "u"));
  }
  assert.ok(view.indexOf('id="homeLaunchGeneralGroup"') < view.indexOf('id="homeLaunchAutomationGroup"'));
  // Standalone BF/Cape Cod/Result Selection tabs have no Home entry point at all, so their accent
  // colors stay removed. Dataset and DFM accents remain because custom shortcut cards use them.
  for (const iconClass of ["bf", "capeCod", "resultSelection"]) {
    assert.doesNotMatch(styles, new RegExp(`\\.homeIconBox\\.${iconClass}\\b`, "u"));
  }
  assert.doesNotMatch(styles, /\.groupTitle\s*\{[^}]*text-transform:\s*uppercase/su);
});

test("Home replaces its left panel with a compact welcome panel", async () => {
  const view = await read("../ui/shell/home_view.js");
  const styles = await read("../ui/shell/shell.css");

  assert.doesNotMatch(view, /class="homeSidebar"/u);
  assert.doesNotMatch(view, /data-home-launch-group/u);
  assert.match(view, /class="homeWelcomePanel"/u);
  assert.match(view, /class="homeWelcomeTitle">Welcome to ArcRho</u);
  assert.match(view, /class="homeBrand"/u);
  assert.match(view, /class="homeBrandTitle">ArcRho</u);
  assert.match(styles, /\.homeWelcomePanel\s*\{/u);
  assert.doesNotMatch(styles, /\.homeSidebar\s*\{/u);
});

test("Home resolves the brand display name and retains login fallback behavior", async () => {
  const view = await read("../ui/shell/home_view.js");

  assert.match(view, /fetch\("\/app\/user-identity"\)/u);
  assert.match(view, /identity\?\.display_name \|\| identity\?\.login_name/u);
  assert.match(view, /hostApi\?\.getWindowsUserName/u);
});

test("Home uses larger group labels and quiet separators without a duplicate header", async () => {
  const view = await read("../ui/shell/home_view.js");
  const styles = await read("../ui/shell/shell.css");

  assert.doesNotMatch(view, /class="homeHeader"/u);
  assert.doesNotMatch(view, /class="homeTitle"/u);
  assert.match(styles, /\.groupTitle\s*\{[^}]*font-size:\s*14px/su);
  // The first custom group is not a DOM sibling of the built-in groups, so it is named alongside
  // `.homeGroup + .homeGroup` to keep one separator rule for every group on the page.
  assert.match(
    styles,
    /\.homeGroup \+ \.homeGroup,\s*\.homeShortcutGroups > \.homeCustomGroup:first-child\s*\{[^}]*border-top:\s*1px solid/su,
  );
  assert.match(styles, /border-top:\s*1px solid color-mix\(in srgb,[^;]*45%, transparent\)/u);
});

test("BF, Cape Cod, and Result Selection open restorable shell method tabs", async () => {
  const actions = await read("../ui/shell/tab_actions.js");
  const host = await read("../ui/shell/iframe_host.js");
  const shell = await read("../ui/shell/ui_shell.js");
  const state = await read("../ui/shell/shell_state.js");

  assert.match(actions, /export function openBornhuetterFergusonTab\(\)/u);
  assert.match(actions, /export function openCapeCodTab\(\)/u);
  assert.match(actions, /export function openResultSelectionTab\(\)/u);
  assert.match(host, /method_pages\/bornhuetter_ferguson\/bornhuetter_ferguson\.html/u);
  assert.match(host, /method_pages\/cape_cod\/cape_cod\.html/u);
  assert.match(host, /method_pages\/result_selection\/result_selection\.html/u);
  // Cape Cod has never been registered on the shell API; its standalone tab only exists for restore.
  assert.match(shell, /openBornhuetterFergusonTab/u);
  assert.match(shell, /openResultSelectionTab/u);
  assert.match(state, /bfTab: t\.type === "bornhuetter_ferguson"/u);
  assert.match(state, /ccTab: t\.type === "cape_cod"/u);
  assert.match(state, /rsTab: t\.type === "result_selection"/u);
});
