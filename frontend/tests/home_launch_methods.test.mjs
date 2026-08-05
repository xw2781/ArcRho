import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Home groups every dataset and method launch under a title-case label", async () => {
  const view = await read("../ui/shell/home_view.js");
  const styles = await read("../ui/shell/shell.css");

  assert.match(view, /id="homeLaunchDataGroup"[\s\S]*Datasets &amp; Methods/u);
  assert.ok(view.indexOf('id="homeLaunchGeneralGroup"') < view.indexOf('id="homeLaunchDataGroup"'));
  for (const cardId of [
    "cardOpenDataset",
    "cardOpenDfm",
    "cardOpenBornhuetterFerguson",
    "cardOpenCapeCod",
    "cardOpenResultSelection",
  ]) {
    assert.match(view, new RegExp(`id="${cardId}"`, "u"));
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
  assert.match(styles, /\.homeGroup \+ \.homeGroup\s*\{[^}]*border-top:\s*1px solid/su);
  assert.match(styles, /border-top:\s*1px solid color-mix\(in srgb,[^;]*45%, transparent\)/u);
});

test("BF, Cape Cod, and Result Selection Home cards open restorable shell method tabs", async () => {
  const view = await read("../ui/shell/home_view.js");
  const actions = await read("../ui/shell/tab_actions.js");
  const host = await read("../ui/shell/iframe_host.js");
  const shell = await read("../ui/shell/ui_shell.js");
  const state = await read("../ui/shell/shell_state.js");

  assert.match(view, /shell\.openBornhuetterFergusonTab/u);
  assert.match(view, /shell\.openCapeCodTab/u);
  assert.match(view, /shell\.openResultSelectionTab/u);
  assert.match(actions, /export function openBornhuetterFergusonTab\(\)/u);
  assert.match(actions, /export function openCapeCodTab\(\)/u);
  assert.match(actions, /export function openResultSelectionTab\(\)/u);
  assert.match(host, /method_pages\/bornhuetter_ferguson\/bornhuetter_ferguson\.html/u);
  assert.match(host, /method_pages\/cape_cod\/cape_cod\.html/u);
  assert.match(host, /method_pages\/result_selection\/result_selection\.html/u);
  assert.match(shell, /openBornhuetterFergusonTab/u);
  assert.match(shell, /openCapeCodTab/u);
  assert.match(shell, /openResultSelectionTab/u);
  assert.match(state, /bfTab: t\.type === "bornhuetter_ferguson"/u);
  assert.match(state, /ccTab: t\.type === "cape_cod"/u);
  assert.match(state, /rsTab: t\.type === "result_selection"/u);
});
