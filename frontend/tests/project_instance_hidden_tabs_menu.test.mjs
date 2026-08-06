import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [htmlSource, hiddenTabsSource, cssSource, darkSource] = await Promise.all([
  readFile(new URL("../ui/project_instance/project_instance.html", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance_hidden_tabs.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/project_instance/project_instance.css", import.meta.url), "utf8"),
  readFile(new URL("../ui/shared/styles/themes/dark.css", import.meta.url), "utf8"),
]);

test("hidden tabs area starts empty and hides its button and menu when nothing is hidden", () => {
  assert.match(htmlSource, /class="pi-hidden-tabs-wrap empty" id="hiddenTabsWrap"/u);
  assert.match(hiddenTabsSource, /els\.hiddenTabsWrap\.classList\.toggle\("empty", !count\)/u);
  assert.match(hiddenTabsSource, /if \(!count\) setHiddenTabsMenuOpen\(false, \{ pinned: false \}\)/u);
  assert.match(hiddenTabsSource, /syncHiddenTabsVisibility\(count\)/u);
  assert.match(
    cssSource,
    /\.pi-hidden-tabs-wrap\.empty \.pi-hidden-tabs-button,\s*\.pi-hidden-tabs-wrap\.empty \.pi-hidden-tabs-menu \{\s*display: none;/u,
  );
});

test("the empty-state menu placeholder is gone because the menu never renders empty", () => {
  assert.doesNotMatch(hiddenTabsSource, /pi-hidden-tabs-empty/u);
  assert.doesNotMatch(cssSource, /pi-hidden-tabs-empty/u);
  assert.doesNotMatch(darkSource, /pi-hidden-tabs-empty/u);
});

test("the hidden tabs dropdown has an inline SVG close icon that dismisses the menu", () => {
  assert.match(hiddenTabsSource, /dismissBtn\.className = "pi-hidden-tabs-dismiss"/u);
  assert.match(hiddenTabsSource, /dismissBtn\.setAttribute\("aria-label", "Close hidden tabs menu"\)/u);
  assert.match(hiddenTabsSource, /dismissBtn\.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"><\/path><\/svg>'/u);
  assert.match(
    hiddenTabsSource,
    /dismissBtn\.addEventListener\("click", \(event\) => \{[^}]*setHiddenTabsMenuOpen\(false, \{ pinned: false \}\);/su,
  );
  assert.match(hiddenTabsSource, /actions\.append\(resumeAllBtn, closeAllBtn, dismissBtn\)/u);
  assert.match(cssSource, /\.pi-hidden-tabs-dismiss \{/u);
  assert.match(darkSource, /\.pi-hidden-tabs-dismiss/u);
});
