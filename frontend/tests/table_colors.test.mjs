import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TABLE_COLOR_COMPONENTS,
  TABLE_COLOR_GROUPS,
  TABLE_COLOR_PRESETS,
  findTableColorPreset,
  normalizeTableColorHex,
  normalizeTableColors,
  resetTableColorComponent,
  resetTableColorsFor,
  setTableColor,
  tableColorCssState,
  tableColorGroupsFor,
  tableColorPropertyName,
  tableColorToken,
} from "../ui/shared/components/spreadsheet/table_colors_model.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const groupById = new Map(TABLE_COLOR_GROUPS.map((group) => [group.id, group]));
const pageOf = (component) => groupById.get(component.group)?.page || "";

// Every method page built on the shared spreadsheet tables, with the file that
// starts its colours and the menu markup that offers the window.
const METHOD_PAGES = [
  { html: "../ui/method_pages/dfm/dfm.html", boot: "../ui/method_pages/dfm/dfm.html", page: "dfm" },
  { html: "../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html", boot: "../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js" },
  { html: "../ui/method_pages/cape_cod/cape_cod.html", boot: "../ui/method_pages/cape_cod/cape_cod_main.js" },
  { html: "../ui/method_pages/berquist_sherman/berquist_sherman.html", boot: "../ui/method_pages/berquist_sherman/berquist_sherman_main.js" },
  { html: "../ui/method_pages/bootstrap/bootstrap.html", boot: "../ui/method_pages/bootstrap/bootstrap_main.js" },
  { html: "../ui/method_pages/stochastic_consolidation/stochastic_consolidation.html", boot: "../ui/method_pages/stochastic_consolidation/stochastic_consolidation_main.js" },
  { html: "../ui/method_pages/result_selection/result_selection.html", boot: "../ui/method_pages/result_selection/result_selection_main.js" },
];

test("hex colours normalise to lower-case long form and reject anything else", () => {
  assert.equal(normalizeTableColorHex("#ABC"), "#aabbcc");
  assert.equal(normalizeTableColorHex(" #B5E222 "), "#b5e222");
  assert.equal(normalizeTableColorHex("b5e222"), "#b5e222");
  assert.equal(normalizeTableColorHex("#B5E22280"), "#b5e22280");
  for (const invalid of ["", "#12", "#1234", "#12345", "#1234567", "#gggggg", "red", null, undefined]) {
    assert.equal(normalizeTableColorHex(invalid), "", String(invalid));
  }
});

test("a stored preference keeps only known components, their properties and valid colours", () => {
  const prefs = normalizeTableColors({
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    components: {
      "excluded-ratio": { font: "#C58BD8", fill: "nope" },
      "column-highlight": { font: "#000000", fill: "#fde2e4" },
      "highlighted-label": { font: "#000000", fill: "#dae4f5" },
      "no-such-part": { font: "#000000" },
    },
  });
  assert.deepEqual(prefs, {
    version: 1,
    components: {
      "excluded-ratio": { font: "#c58bd8" },
      "column-highlight": { fill: "#fde2e4" },
      "highlighted-label": { fill: "#dae4f5" },
    },
  });
  assert.deepEqual(normalizeTableColors(null), { version: 1, components: {} });
  assert.deepEqual(normalizeTableColors("garbage"), { version: 1, components: {} });
});

test("setting, clearing and resetting colours", () => {
  let prefs = setTableColor(null, "selected-cell", "fill", "#ECF8AF");
  prefs = setTableColor(prefs, "selected-cell", "font", "#000");
  assert.deepEqual(prefs.components["selected-cell"], { fill: "#ecf8af", font: "#000000" });

  prefs = setTableColor(prefs, "selected-cell", "font", "");
  assert.deepEqual(prefs.components["selected-cell"], { fill: "#ecf8af" });

  assert.deepEqual(setTableColor(prefs, "unknown", "fill", "#ffffff"), prefs);
  assert.deepEqual(setTableColor(prefs, "column-highlight", "font", "#ffffff"), prefs, "fill-only part");

  prefs = setTableColor(prefs, "ratio", "font", "#2b6df6");
  prefs = resetTableColorComponent(prefs, "selected-cell");
  assert.deepEqual(prefs.components, { ratio: { font: "#2b6df6" } });
  assert.deepEqual(setTableColor(prefs, "ratio", "font", ""), { version: 1, components: {} });
});

test("Reset all on a page clears what that page shows and keeps another page's own colours", () => {
  let prefs = setTableColor(null, "ratio", "font", "#2b6df6");
  prefs = setTableColor(prefs, "column-header", "fill", "#fdf8dc");
  assert.deepEqual(resetTableColorsFor(prefs, "").components, { ratio: { font: "#2b6df6" } });
  assert.deepEqual(resetTableColorsFor(prefs, "dfm").components, {});
});

test("each page shows its own groups and then the groups every table shares", () => {
  const shared = TABLE_COLOR_GROUPS.filter((group) => !group.page).map((group) => group.id);
  assert.deepEqual(tableColorGroupsFor("").map((group) => group.id), shared);
  const dfm = tableColorGroupsFor("dfm").map((group) => group.id);
  assert.deepEqual(dfm.slice(-shared.length), shared);
  assert.ok(dfm.length > shared.length);
});

test("an every-table colour sets its shared variable, a page colour its own, and each switches on its token", () => {
  let prefs = setTableColor(null, "excluded-ratio", "font", "#b91c1c");
  prefs = setTableColor(prefs, "row-label", "fill", "#dae4f5");
  prefs = setTableColor(prefs, "column-header", "font", "#1e3a8a");
  prefs = setTableColor(prefs, "selected-cell", "fill", "#b5e222");
  assert.deepEqual(tableColorCssState(prefs), {
    tokens: ["excluded-ratio-font", "column-header-font", "row-label-fill", "selected-cell-fill"],
    properties: {
      "--ar-table-color-excluded-ratio-font": "#b91c1c",
      "--ar-spreadsheet-header-text": "#1e3a8a",
      "--ar-spreadsheet-label-fill": "#dae4f5",
      "--ar-spreadsheet-weighted-selection-fill": "#b5e222",
    },
  });
  assert.deepEqual(tableColorCssState({ components: { bogus: { fill: "#fff" } } }), { tokens: [], properties: {} });
});

test("every component belongs to a group, and every colour it offers reaches the tables", async () => {
  const [dfmCss, spreadsheetCss] = await Promise.all([
    read("../ui/method_pages/dfm/dfm.css"),
    read("../ui/shared/components/spreadsheet/spreadsheet_table.css"),
  ]);
  const rootBlock = spreadsheetCss.match(/:root\s*\{([^}]*)\}/u)?.[1] || "";
  const ids = new Set();
  for (const component of TABLE_COLOR_COMPONENTS) {
    assert.ok(!ids.has(component.id), `${component.id} is unique`);
    ids.add(component.id);
    assert.ok(groupById.has(component.group), `${component.id} has a known group`);
    assert.ok(component.properties.length > 0);
    for (const property of component.properties) {
      const name = tableColorPropertyName(component.id, property);
      if (!pageOf(component)) {
        assert.ok(rootBlock.includes(`${name}:`), `${name} is a shared spreadsheet variable`);
        continue;
      }
      const token = tableColorToken(component.id, property);
      const rule = new RegExp(
        `:root\\[data-ar-table-colors~="${token}"\\] #ratioWrapHost #ratioWrap :where\\([^{]+\\)\\s*\\{[^}]*`
        + `${property === "font" ? "(?<![-\\w])color" : "background-color"}:\\s*var\\(${name}\\)`,
        "u",
      );
      assert.match(dfmCss, rule, `${token} has its override rule`);
    }
  }
  for (const match of dfmCss.matchAll(/data-ar-table-colors~="([^"]+)"/gu)) {
    const [, token] = match;
    assert.ok(
      TABLE_COLOR_COMPONENTS.some((component) => ["dfm", ""].includes(pageOf(component))
        && component.properties.some((property) => tableColorToken(component.id, property) === token)),
      `${token} in dfm.css is a colour the DFM window offers`,
    );
  }
});

test("Selected Cell is the green every page keeps on its selections, and it reaches the DFM's fixed Dark green", async () => {
  const [dfmCss, bfCss, rsCss] = await Promise.all([
    read("../ui/method_pages/dfm/dfm.css"),
    read("../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.css"),
    read("../ui/method_pages/result_selection/result_selection.css"),
  ]);
  const component = TABLE_COLOR_COMPONENTS.find((item) => item.id === "selected-cell");
  assert.equal(pageOf(component), "", "shown on every page");
  const fill = tableColorPropertyName("selected-cell", "fill");
  assert.match(dfmCss, new RegExp(`td\\.summaryCell\\.ratioSelectedCell[^{]*\\{[^}]*background:\\s*var\\(${fill}\\)`, "u"));
  assert.match(bfCss, new RegExp(`td\\.bfPriorCell\\.bfSelectedSourceCell\\s*\\{[^}]*background:\\s*var\\(${fill}\\)`, "u"));
  assert.match(rsCss, new RegExp(`td\\.rsSourceCell\\.rsSelectedSourceCell\\s*\\{[^}]*background:\\s*var\\(${fill}\\)`, "u"));
  // Dark paints the DFM selected average in a fixed green, so the DFM keeps a
  // token-switched rule that carries the shared colour past it.
  for (const property of component.properties) {
    const rule = new RegExp(
      `:root\\[data-ar-table-colors~="selected-cell-${property}"\\] #ratioWrapHost #ratioWrap :where\\([^{]+\\)\\s*\\{[^}]*`
      + `var\\(${tableColorPropertyName("selected-cell", property)}\\)`,
      "u",
    );
    assert.match(dfmCss, rule, `selected-cell-${property}`);
  }
});

test("column headers and row labels take their own label colour inside every table", async () => {
  const css = await read("../ui/shared/components/spreadsheet/spreadsheet_table.css");
  assert.match(css, /--ar-spreadsheet-header-text:\s*var\(--ar-spreadsheet-label-text\)/u);
  assert.match(css, /--ar-spreadsheet-row-label-text:\s*var\(--ar-spreadsheet-label-text\)/u);
  assert.match(css, /:where\(table > thead\)\s*\{\s*--ar-spreadsheet-label-text:\s*var\(--ar-spreadsheet-header-text\);/u);
  assert.match(css, /:where\(table > tbody\)\s*\{\s*--ar-spreadsheet-label-text:\s*var\(--ar-spreadsheet-row-label-text\);/u);
});

test("the named colours are unique, valid and found by value", () => {
  const names = new Set(TABLE_COLOR_PRESETS.map((preset) => preset.name));
  const values = new Set(TABLE_COLOR_PRESETS.map((preset) => preset.hex));
  assert.equal(names.size, TABLE_COLOR_PRESETS.length);
  assert.equal(values.size, TABLE_COLOR_PRESETS.length);
  for (const preset of TABLE_COLOR_PRESETS) assert.equal(normalizeTableColorHex(preset.hex), preset.hex);
  assert.equal(findTableColorPreset("#ECF8AF")?.name, "Pale Lime");
  assert.equal(findTableColorPreset("#123456"), null);
});

test("every method page starts the colours, links the window and offers Custom Colors on its tables", async () => {
  for (const { html: htmlPath, boot: bootPath, page } of METHOD_PAGES) {
    const [html, boot] = await Promise.all([read(htmlPath), read(bootPath)]);
    const call = page ? `bootTableColors({ page: "${page}" })` : "bootTableColors()";
    assert.ok(boot.includes("/ui/shared/components/spreadsheet/table_colors.js?v="), `${bootPath} loads the colours`);
    assert.ok(boot.includes(call), `${bootPath} calls ${call}`);
    assert.match(html, /\/ui\/shared\/components\/spreadsheet\/table_colors_window\.css\?v=/u, htmlPath);
    assert.match(html, /<button[^>]*\sdata-table-colors[\s>][^<]*Custom Colors<\/button>/u, htmlPath);
  }
  const dfm = await read("../ui/method_pages/dfm/dfm.html");
  for (const menuId of ["dfmAvgMenu", "dfmRatioMenu", "ctxMenu"]) {
    const menu = dfm.match(new RegExp(`<div id="${menuId}"[^>]*>([\\s\\S]*?)\\n  </div>`, "u"))?.[1] || "";
    assert.match(menu, /data-table-colors>Custom Colors<\/button>/u, menuId);
  }
  const curves = await read("../ui/method_pages/dfm/dfm_curves_tab.js");
  assert.match(curves, /\{ label: "Custom Colors", onSelect: openTableColorsWindow \}/u);
});

test("the host keeps the preference in its own file", async () => {
  const [preload, main] = await Promise.all([read("../electron/preload.js"), read("../electron/main.js")]);
  assert.match(preload, /loadTableColorPreferences:\s*\(\)\s*=>\s*invoke\("table-colors-preferences-load"\)/u);
  assert.match(preload, /saveTableColorPreferences:\s*\(preferences\)\s*=>\s*invoke\("table-colors-preferences-save", \{ preferences \}\)/u);
  assert.match(main, /ipcMain\.handle\("table-colors-preferences-load"/u);
  assert.match(main, /ipcMain\.handle\("table-colors-preferences-save"/u);
  assert.match(main, /TABLE_COLORS_PREFS_FILE = "table_colors\.json"/u);
});
