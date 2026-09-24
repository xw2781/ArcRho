import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DFM_RATIO_COLOR_COMPONENTS,
  DFM_RATIO_COLOR_GROUPS,
  DFM_RATIO_COLOR_PRESETS,
  dfmRatioColorCssState,
  dfmRatioColorPropertyName,
  dfmRatioColorToken,
  findDfmRatioColorPreset,
  normalizeDfmRatioColorHex,
  normalizeDfmRatioColors,
  resetDfmRatioColorComponent,
  setDfmRatioColor,
} from "../ui/method_pages/dfm/dfm_ratio_colors_model.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("hex colours normalise to lower-case long form and reject anything else", () => {
  assert.equal(normalizeDfmRatioColorHex("#ABC"), "#aabbcc");
  assert.equal(normalizeDfmRatioColorHex(" #B5E222 "), "#b5e222");
  assert.equal(normalizeDfmRatioColorHex("b5e222"), "#b5e222");
  assert.equal(normalizeDfmRatioColorHex("#B5E22280"), "#b5e22280");
  for (const invalid of ["", "#12", "#1234", "#12345", "#1234567", "#gggggg", "red", null, undefined]) {
    assert.equal(normalizeDfmRatioColorHex(invalid), "", String(invalid));
  }
});

test("a stored preference keeps only known components, their properties and valid colours", () => {
  const prefs = normalizeDfmRatioColors({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    components: {
      "excluded-ratio": { font: "#C58BD8", fill: "nope" },
      "column-highlight": { font: "#000000", fill: "#fde2e4" },
      "no-such-part": { font: "#000000" },
    },
  });
  assert.deepEqual(prefs, {
    version: 1,
    components: {
      "excluded-ratio": { font: "#c58bd8" },
      "column-highlight": { fill: "#fde2e4" },
    },
  });
  assert.deepEqual(normalizeDfmRatioColors(null), { version: 1, components: {} });
  assert.deepEqual(normalizeDfmRatioColors("garbage"), { version: 1, components: {} });
});

test("setting, clearing and resetting colours", () => {
  let prefs = setDfmRatioColor(null, "selected-average", "fill", "#ECF8AF");
  prefs = setDfmRatioColor(prefs, "selected-average", "font", "#000");
  assert.deepEqual(prefs.components["selected-average"], { fill: "#ecf8af", font: "#000000" });

  prefs = setDfmRatioColor(prefs, "selected-average", "font", "");
  assert.deepEqual(prefs.components["selected-average"], { fill: "#ecf8af" });

  assert.deepEqual(setDfmRatioColor(prefs, "unknown", "fill", "#ffffff"), prefs);
  assert.deepEqual(setDfmRatioColor(prefs, "column-highlight", "font", "#ffffff"), prefs, "fill-only part");

  prefs = setDfmRatioColor(prefs, "ratio", "font", "#2b6df6");
  prefs = resetDfmRatioColorComponent(prefs, "selected-average");
  assert.deepEqual(prefs.components, { ratio: { font: "#2b6df6" } });
  assert.deepEqual(setDfmRatioColor(prefs, "ratio", "font", ""), { version: 1, components: {} });
});

test("a preference becomes root tokens and custom properties, and an empty one becomes none", () => {
  const prefs = setDfmRatioColor(setDfmRatioColor(null, "excluded-ratio", "font", "#b91c1c"), "row-label", "fill", "#dae4f5");
  assert.deepEqual(dfmRatioColorCssState(prefs), {
    tokens: ["excluded-ratio-font", "row-label-fill"],
    properties: {
      "--dfm-ratio-color-excluded-ratio-font": "#b91c1c",
      "--dfm-ratio-color-row-label-fill": "#dae4f5",
    },
  });
  assert.deepEqual(dfmRatioColorCssState({ components: { bogus: { fill: "#fff" } } }), { tokens: [], properties: {} });
});

test("every component belongs to a group and every colour it offers has its dfm.css rule", async () => {
  const css = await read("../ui/method_pages/dfm/dfm.css");
  const groups = new Set(DFM_RATIO_COLOR_GROUPS.map((group) => group.id));
  const ids = new Set();
  for (const component of DFM_RATIO_COLOR_COMPONENTS) {
    assert.ok(!ids.has(component.id), `${component.id} is unique`);
    ids.add(component.id);
    assert.ok(groups.has(component.group), `${component.id} has a known group`);
    assert.ok(component.properties.length > 0);
    for (const property of component.properties) {
      const token = dfmRatioColorToken(component.id, property);
      const rule = new RegExp(
        `:root\\[data-dfm-ratio-colors~="${token}"\\] #ratioWrapHost #ratioWrap :where\\([^{]+\\)\\s*\\{[^}]*`
        + `${property === "font" ? "(?<![-\\w])color" : "background-color"}:\\s*var\\(${dfmRatioColorPropertyName(component.id, property)}\\)`,
        "u",
      );
      assert.match(css, rule, `${token} has its override rule`);
    }
  }
  for (const match of css.matchAll(/data-dfm-ratio-colors~="([^"]+)"/gu)) {
    const [, token] = match;
    assert.ok(
      DFM_RATIO_COLOR_COMPONENTS.some((component) => component.properties.some((property) => dfmRatioColorToken(component.id, property) === token)),
      `${token} in dfm.css is a catalogue colour`,
    );
  }
});

test("the named colours are unique, valid and found by value", () => {
  const names = new Set(DFM_RATIO_COLOR_PRESETS.map((preset) => preset.name));
  const values = new Set(DFM_RATIO_COLOR_PRESETS.map((preset) => preset.hex));
  assert.equal(names.size, DFM_RATIO_COLOR_PRESETS.length);
  assert.equal(values.size, DFM_RATIO_COLOR_PRESETS.length);
  for (const preset of DFM_RATIO_COLOR_PRESETS) assert.equal(normalizeDfmRatioColorHex(preset.hex), preset.hex);
  assert.equal(findDfmRatioColorPreset("#ECF8AF")?.name, "Pale Lime");
  assert.equal(findDfmRatioColorPreset("#123456"), null);
});

test("both Ratios table menus offer Custom Colors and the host keeps the preference in its own file", async () => {
  const [html, preload, main] = await Promise.all([
    read("../ui/method_pages/dfm/dfm.html"),
    read("../electron/preload.js"),
    read("../electron/main.js"),
  ]);
  for (const menuId of ["dfmAvgMenu", "dfmRatioMenu"]) {
    const menu = html.match(new RegExp(`<div id="${menuId}"[^>]*>([\\s\\S]*?)\\n  </div>`, "u"))?.[1] || "";
    assert.match(menu, /<button class="dfmCtxItem" data-action="custom-colors">Custom Colors<\/button>/u, menuId);
  }
  assert.match(preload, /loadDfmRatioColorPreferences:\s*\(\)\s*=>\s*invoke\("dfm-ratio-colors-preferences-load"\)/u);
  assert.match(preload, /saveDfmRatioColorPreferences:\s*\(preferences\)\s*=>\s*invoke\("dfm-ratio-colors-preferences-save", \{ preferences \}\)/u);
  assert.match(main, /ipcMain\.handle\("dfm-ratio-colors-preferences-load"/u);
  assert.match(main, /ipcMain\.handle\("dfm-ratio-colors-preferences-save"/u);
  assert.match(main, /DFM_RATIO_COLORS_PREFS_FILE = "dfm_ratio_colors\.json"/u);
});
