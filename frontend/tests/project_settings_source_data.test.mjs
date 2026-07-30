import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(
  new URL("../ui/project_settings/project_settings_source_data.js", import.meta.url),
  "utf8",
);
const {
  getLastClosedMonthCanonical,
  getMonthPickerYearRange,
  formatSummaryNumber,
  getColumnRowSummary,
  getHistBarRangeLabels,
} = await import(
  new URL("../ui/project_settings/project_settings_source_data.js", import.meta.url)
);
const generalSettingsSource = await readFile(
  new URL("../ui/project_settings/project_settings_general_settings.js", import.meta.url),
  "utf8",
);
const projectSettingsJs = await readFile(
  new URL("../ui/project_settings/project_settings.js", import.meta.url),
  "utf8",
);
const projectSettingsHtml = await readFile(
  new URL("../ui/project_settings/project_settings.html", import.meta.url),
  "utf8",
);
const summaryCss = await readFile(
  new URL("../ui/project_settings/project_settings_summary.css", import.meta.url),
  "utf8",
);
const summaryService = await readFile(
  new URL("../app_server/services/table_summary_service.py", import.meta.url),
  "utf8",
);
const summaryRouter = await readFile(
  new URL("../app_server/api/table_summary_router.py", import.meta.url),
  "utf8",
);

test("Source Data markup keeps the ids project_settings.js binds", () => {
  const boundIds = [
    "summaryTablePathInput",
    "summaryTablePathReloadBtn",
    "summaryTablePathBrowseBtn",
    "summaryOriginStartInput",
    "summaryOriginEndInput",
    "summaryDevelopmentEndInput",
  ];
  for (const id of boundIds) {
    assert.ok(projectSettingsHtml.includes(`id="${id}"`), `missing #${id} in markup`);
    assert.ok(projectSettingsJs.includes(id), `#${id} is no longer referenced by project_settings.js`);
  }

  // Rendering targets moved to the feature module and must stay resolvable there.
  for (const id of ["summaryStats", "summaryColumns"]) {
    assert.ok(projectSettingsHtml.includes(`id="${id}"`), `missing #${id} in markup`);
    assert.ok(moduleSource.includes(id), `#${id} is not owned by the Source Data module`);
  }
});

test("Source Data panel exposes the quiet surface elements", () => {
  for (const id of [
    "summaryPathIdentity",
    "summaryPathDisplay",
    "summaryPathName",
    "summaryPathDir",
    "summaryCopyFolderBtn",
    "summaryInfoBtn",
    "summaryCopyPathBtn",
    "summaryOpenFolderBtn",
    "summaryMessage",
    "summaryColumnFilter",
    "summaryColumnCount",
    "summaryColumnsHead",
    "summaryStatsCard",
  ]) {
    assert.ok(projectSettingsHtml.includes(`id="${id}"`), `missing #${id} in markup`);
  }
  assert.match(projectSettingsHtml, /class="sd-resizer" data-col="name"/);
  assert.match(projectSettingsHtml, /class="sd-resizer" data-col="type"/);
  assert.ok(!projectSettingsHtml.includes("summaryStateDot"), "the removed state dot remains in markup");
  assert.ok(!moduleSource.includes("summaryStateDot"), "the removed state dot remains bound");
  assert.ok(!moduleSource.includes("setStateTone"), "the removed state-dot behavior remains");
  assert.ok(!summaryCss.includes(".sd-state-dot"), "the removed state-dot styles remain");
});

test("source identity keeps the quiet info trigger beside the file name and the folder in its panel", () => {
  const nameIndex = projectSettingsHtml.indexOf('id="summaryPathName"');
  const infoIndex = projectSettingsHtml.indexOf('id="summaryInfoBtn"');
  const actionsIndex = projectSettingsHtml.indexOf('class="sd-actions"');
  const statsIndex = projectSettingsHtml.indexOf('id="summaryStatsCard"');
  const directoryIndex = projectSettingsHtml.indexOf('id="summaryPathDir"');

  assert.ok(nameIndex >= 0 && infoIndex > nameIndex, "the info trigger is not after the file name");
  assert.ok(infoIndex < actionsIndex, "the info trigger remains in the standard action-button group");
  assert.ok(directoryIndex > statsIndex, "the source directory is not inside the floating info panel");
  assert.match(projectSettingsHtml, /class="sd-info-trigger" id="summaryInfoBtn"/);
  assert.match(projectSettingsHtml, /<circle cx="8" cy="8" r="6\.4"\/><path d="M8 4\.4v4\.6"\/>/);
  assert.match(summaryCss, /\.sd-info-trigger\s*\{[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;/);
  assert.match(summaryCss, /\.sd-stats-card\s*\{[\s\S]*width:\s*420px;[\s\S]*max-width:\s*calc\(100vw - 16px\)/);
  assert.match(moduleSource, /dom\.pathIdentity\.hidden = true/);
  assert.match(moduleSource, /dom\.pathIdentity\.hidden = false/);
  assert.match(moduleSource, /dom\.pathDirRow\.hidden = !parts\.dir/);
  assert.match(moduleSource, /dom\.copyFolderBtn\?\.addEventListener\("click"/);
  assert.match(moduleSource, /splitPath\(dom\.pathInput\?\.value\)\.dir/);
});

test("period band uses the requested labels and omits the normal origin span", () => {
  assert.match(projectSettingsHtml, /id="summaryOriginLabel">Origin Period:<\/span>/);
  assert.match(projectSettingsHtml, /id="summaryDevelopmentLabel">Development End:<\/span>/);
  assert.ok(!moduleSource.includes("`${months} months`"), "the derived month-span label remains");
  assert.match(moduleSource, /dom\.originSpanNote\.textContent = "";/);
  // Each label wraps together with its inputs; groups are separated by a column gap.
  assert.match(
    projectSettingsHtml,
    /class="sd-band-group">\s*<span class="sd-key" id="summaryOriginLabel"/,
  );
  assert.match(
    projectSettingsHtml,
    /class="sd-band-group">\s*<span class="sd-key" id="summaryDevelopmentLabel"/,
  );
  assert.match(summaryCss, /\.sd-band\s*\{[\s\S]*?column-gap:\s*24px;/);
  assert.match(summaryCss, /\.sd-band-group\s*\{[\s\S]*?display:\s*flex;/);
  assert.ok(!projectSettingsHtml.includes("sd-key-gap"), "the retired label margin class remains in markup");
  assert.ok(!summaryCss.includes(".sd-key-gap"), "the retired label margin styles remain");
  assert.match(summaryCss, /\.sd-note:empty\s*\{\s*display:\s*none;/);
});

test("date inputs use one shared month/year picker that stays open under the pointer", () => {
  for (const id of [
    "summaryOriginStartPickerBtn",
    "summaryOriginEndPickerBtn",
    "summaryDevelopmentEndPickerBtn",
    "summaryMonthPicker",
    "summaryMonthPickerYear",
    "summaryMonthPickerGrid",
    "summaryMonthPickerPrevYear",
    "summaryMonthPickerNextYear",
  ]) {
    assert.ok(projectSettingsHtml.includes(`id="${id}"`), `missing #${id} in markup`);
  }
  for (const retiredId of [
    "summaryOriginStartUpBtn",
    "summaryOriginStartDownBtn",
    "summaryOriginEndUpBtn",
    "summaryOriginEndDownBtn",
    "summaryDevelopmentEndUpBtn",
    "summaryDevelopmentEndDownBtn",
  ]) {
    assert.ok(!projectSettingsHtml.includes(retiredId), `retired stepper #${retiredId} remains`);
    assert.ok(!projectSettingsJs.includes(retiredId), `coordinator still binds #${retiredId}`);
  }
  assert.ok(!projectSettingsHtml.includes("Current Month"), "the removed shortcut remains in the picker");
  assert.ok(!moduleSource.includes("summaryMonthPickerCurrent"), "the removed shortcut remains bound");
  assert.ok(!summaryCss.includes(".sd-month-picker-current"), "the removed shortcut styles remain");
  assert.match(moduleSource, /monthPickerYear -= 1/);
  assert.match(moduleSource, /monthPickerYear \+= 1/);
  assert.match(projectSettingsHtml, /id="summaryMonthPickerYear"[^>]*type="button"[^>]*aria-expanded="false"/);
  assert.match(moduleSource, /monthPickerYear\?\.addEventListener\("click", toggleMonthPickerYearView\)/);
  assert.match(moduleSource, /class="sd-month-picker-year-option"[^>]*data-year=/);
  assert.match(moduleSource, /monthPickerView = "months";/);
  assert.match(moduleSource, /monthPickerView === "years"/);
  assert.match(moduleSource, /classList\.toggle\("is-year-view-hidden", hidden\)/);
  assert.match(moduleSource, /setAttribute\("aria-hidden", "true"\)/);
  assert.match(summaryCss, /\.sd-month-picker-nav\.is-year-view-hidden\s*\{\s*visibility:\s*hidden;\s*pointer-events:\s*none;/);
  assert.match(moduleSource, /let monthPickerPointerInside = false;/);
  assert.match(moduleSource, /monthPicker\?\.addEventListener\("pointerenter", \(\) => \{\s*monthPickerPointerInside = true;/);
  assert.match(moduleSource, /monthPicker\?\.addEventListener\("pointerleave", \(\) => \{\s*monthPickerPointerInside = false;/);
  assert.match(moduleSource, /if \(monthPickerPointerInside && !force\) return;/);
  assert.match(moduleSource, /closeMonthPicker\(\{ restoreFocus: true, force: true \}\)/);
  assert.match(moduleSource, /placeFloating\(dom\.monthPicker, activeMonthInput\.getBoundingClientRect\(\), 6\)/);
  assert.doesNotMatch(moduleSource, /placeFloating\(dom\.monthPicker, button\.getBoundingClientRect\(\), 6\)/);
  assert.match(moduleSource, /input\.dispatchEvent\(new Event\("change"/);
  assert.match(generalSettingsSource, /input\.onchange = \(\) =>/);
  assert.match(generalSettingsSource, /commitPending = true/);
  assert.match(generalSettingsSource, /if \(commitPending\)/);
  assert.match(projectSettingsJs, /formatMonth: formatBoundaryYmDisplay/);
  assert.ok(!summaryCss.includes(".sd-month-lane"), "retired stepper lane styles remain");
  const pickerButtonRule = summaryCss.match(/\.sd-month-picker-btn\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.ok(!pickerButtonRule.includes("border-left"), "calendar icon retains its left divider");
  assert.match(summaryCss, /\.sd-month-picker-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, 1fr\)/);
  assert.match(moduleSource, /normalizeMonth\(input\.value\) \|\| getLastClosedMonthCanonical\(\)/);
  assert.equal(getLastClosedMonthCanonical(new Date(2026, 0, 15)), "202512");
  assert.equal(getLastClosedMonthCanonical(new Date(2026, 6, 29)), "202606");
  assert.deepEqual(getMonthPickerYearRange(2017), Array.from({ length: 51 }, (_value, index) => 1967 + index));
  assert.deepEqual(getMonthPickerYearRange(2026), Array.from({ length: 51 }, (_value, index) => 1976 + index));
  assert.deepEqual(getMonthPickerYearRange("invalid"), []);
});

test("the removed table markup and its styles are gone", () => {
  assert.ok(!projectSettingsHtml.includes("summary-derived-frame"), "old fieldset markup remains");
  assert.ok(!projectSettingsHtml.includes("summary-table-path"), "old path row markup remains");
  // "summaryColumnsTable" survives only as the shared width-preference key.
  assert.ok(!projectSettingsJs.includes('id="summaryColumnsTable"'), "old columns table is still rendered");
  assert.ok(
    !projectSettingsJs.includes('initTableColumnResizing("summaryColumnsTable"'),
    "old columns table still uses the <table> resizer",
  );
  assert.ok(!summaryCss.includes(".columns-table"), "old columns table styles remain");
  assert.ok(!summaryCss.includes(".stat-item"), "old stat tile styles remain");
});

test("project_settings.js delegates Source Data rendering to the feature module", () => {
  assert.match(projectSettingsJs, /createSourceDataFeature\(\{/);
  assert.match(projectSettingsJs, /sourceDataFeature\.renderSummary\(data\)/);
  assert.match(projectSettingsJs, /sourceDataFeature\.showNoPath\(/);
  assert.match(projectSettingsJs, /sourceDataFeature\.showError\(/);
  assert.match(projectSettingsJs, /sourceDataFeature\.setDateRoles\(mappedDateFields\)/);
  // The month parser is imported from its owner rather than reimplemented here.
  assert.match(projectSettingsJs, /normalizeMonth: normalizeBoundaryYmCanonical/);
  assert.match(projectSettingsJs, /formatMonth: formatBoundaryYmDisplay/);
  assert.match(
    projectSettingsJs,
    /import \{[\s\S]*normalizeBoundaryYmCanonical,\s*\} from "\/ui\/project_settings\/project_settings_general_settings\.js/,
  );
});

test("the column preview opens only from a Distribution-cell click", () => {
  assert.match(moduleSource, /closest\("\.sd-c-dist"\)/);
  assert.match(moduleSource, /placeAtPointer\(/);
  assert.match(
    moduleSource,
    /addEventListener\("click", \(event\) => \{\s*const cell = event\.target\.closest\("\.sd-c-dist"\);[\s\S]*if \(!cell \|\| !row\) return;[\s\S]*showPreview\(row, \{ x: event\.clientX, y: event\.clientY \}, \{ cell \}\)/,
  );
  // No hover- or focus-driven preview remains.
  assert.ok(!moduleSource.includes('dom.list?.addEventListener("mousemove"'), "the hover preview handler remains");
  assert.ok(!moduleSource.includes('dom.list?.addEventListener("focusin"'), "the focus auto-open handler remains");
  assert.ok(!moduleSource.includes("PREVIEW_OPEN_DELAY_MS"), "the hover open delay remains");
  assert.ok(!moduleSource.includes("previewPinned"), "the retired pinned flag remains");
  assert.ok(!moduleSource.includes("hidePreview({ force: true })"), "the retired force option remains");
  // Keyboard rows open the same preview anchored to the cell.
  assert.match(moduleSource, /event\.key !== "Enter" && event\.key !== " "/);
  // Escape or an outside click closes it.
  assert.match(moduleSource, /!previewCard\.contains\(event\.target\)[\s\S]*!previewCell\?\.contains\(event\.target\)/);
  assert.match(moduleSource, /hidePreview\(\);[\s\S]*closeDetails\(\)/);
  // The card is always interactive; no pinned-state pointer-events toggle remains.
  const previewCardRule = summaryCss.match(/\.sd-preview-card\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.ok(!previewCardRule.includes("pointer-events"), "the preview card still toggles pointer events");
  assert.ok(!summaryCss.includes('[data-pinned="true"]'), "the retired pinned selector remains");
  assert.match(summaryCss, /\.sd-row \.sd-c-dist\s*\{\s*cursor:\s*pointer;/);
});

test("distribution marks cover categorical and numeric columns", () => {
  assert.match(moduleSource, /kind === "numeric"/);
  assert.match(moduleSource, /kind === "categorical"/);
  assert.match(moduleSource, /preserveAspectRatio="none"/);
  assert.match(summaryCss, /\.sd-area\b/);
  assert.match(summaryCss, /\.sd-strip\b/);
});

test("distribution cells pair the mark with an inline key-value summary", () => {
  assert.match(projectSettingsHtml, /class="sd-head-label">Distribution &amp; Summary</);
  assert.match(moduleSource, /class="sd-dist-mark"/);
  assert.match(moduleSource, /class="sd-dist-summary"/);
  assert.match(summaryCss, /\.sd-dist-mark\s*\{[\s\S]*?flex:\s*0 0 196px;/);
  assert.match(summaryCss, /\.sd-dist-summary\s*\{[\s\S]*?margin-left:\s*8px;/);
  assert.match(summaryCss, /\.sd-dist-summary\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  // Null shares stay out of the row cells; the floating preview owns completeness.
  assert.ok(!moduleSource.includes("sd-dist-null"), "the removed inline null note remains rendered");
  assert.ok(!summaryCss.includes(".sd-dist-null"), "the removed inline null note styles remain");

  assert.equal(formatSummaryNumber(202612), "202,612");
  // Floats group thousands without decimals unless decimals are requested.
  assert.equal(formatSummaryNumber(1234567.891), "1,234,568");
  assert.equal(formatSummaryNumber(0.5, 4), "0.5000");
  assert.equal(formatSummaryNumber("bad"), "");

  assert.equal(
    getColumnRowSummary({
      type: "Float",
      stats: { min: -1400.6, max: 21630.29 },
      null_ratio: 0.021,
      distribution: { kind: "numeric", bins: [1] },
    }),
    "-1,401 ~ 21,630",
  );
  // Decimals stay only when the column's largest magnitude is under 10.
  assert.equal(
    getColumnRowSummary({
      type: "Float",
      stats: { min: -0.25, max: 5.5 },
      null_ratio: 0,
      distribution: { kind: "numeric", bins: [1] },
    }),
    "-0.2500 ~ 5.5000",
  );
  // Date-role columns render YYYYMM bounds as plain 6-digit integers.
  assert.equal(
    getColumnRowSummary(
      {
        type: "Float",
        stats: { min: 201701, max: 202612 },
        null_ratio: 0,
        distribution: { kind: "numeric", bins: [1] },
      },
      { asDate: true },
    ),
    "201701 ~ 202612",
  );
  assert.equal(
    getColumnRowSummary({
      type: "DateTime",
      stats: { min: "2017-01-01 00:00:00", max: "2026-05-31 00:00:00" },
      null_ratio: 0,
      distribution: { kind: "numeric", bins: [1] },
    }),
    "2017-01-01 00:00:00 ~ 2026-05-31 00:00:00",
  );
  // Date-role rows swap the displayed data type for `Date`.
  assert.match(moduleSource, /getColumnRowSummary\(column, \{ asDate: !!role \}\)/);
  assert.match(moduleSource, /const typeLabel = role \? "Date" : column\?\.type;/);
  assert.match(summaryCss, /\.sd-type-Date\s*\{\s*--sd-type-color:/);
  assert.equal(
    getColumnRowSummary({
      type: "String",
      distinct_count: 8,
      null_ratio: 0,
      distribution: { kind: "categorical", items: [{ label: "Direct", share: 0.42 }] },
    }),
    "8 distinct · Direct 42.0%",
  );
  // Columns without stats or a usable distribution fall back to the values string.
  assert.equal(
    getColumnRowSummary({ values: "(unknown)", distribution: { kind: "none" }, null_ratio: 1 }),
    "(unknown)",
  );
});

test("the first column uses regular-weight row text", () => {
  assert.match(summaryCss, /\.sd-row-name\s*\{[\s\S]*?font-weight:\s*400;/);
  assert.match(summaryCss, /\.sd-row-role\s*\{[\s\S]*?font-weight:\s*400;/);
});

test("column previews show completeness and percentage-accurate frequency meters", () => {
  assert.match(moduleSource, /const nullRatio = clampRatio\(column\?\.null_ratio\)/);
  assert.match(moduleSource, /const filledRatio = 1 - nullRatio/);
  assert.match(moduleSource, /<b>\$\{filledPercent\}<\/b> filled/);
  assert.match(moduleSource, /<b>\$\{nullPercent\}<\/b> null/);
  assert.ok(!moduleSource.includes("</b> empty"), "the retired empty-value label remains");
  assert.match(moduleSource, /Most Frequent<\/span><span>% of filled/);
  assert.match(moduleSource, /role="meter"/);
  assert.match(moduleSource, /aria-valuenow="\$\{pct\.toFixed\(1\)\}"/);
  assert.match(moduleSource, /--sd-bar-share:\$\{pct\.toFixed\(1\)\}%/);
  assert.match(summaryCss, /width:\s*var\(--sd-bar-share, 0%\)/);
  assert.match(summaryCss, /\.sd-bar-track\s*\{[\s\S]*border:\s*1px solid/);
});

test("histogram bars expose their bin range on hover", () => {
  assert.match(moduleSource, /class="sd-hist-bar"/);
  assert.match(moduleSource, /getHistBarRangeLabels\(dist\.edges, \{ asDate: !!role \}\)/);
  assert.match(summaryCss, /\.sd-hist-bar\s*\{[\s\S]*?height:\s*100%;/);
  assert.match(summaryCss, /\.sd-hist-bar:hover i\s*\{\s*opacity:\s*1;/);

  assert.deepEqual(getHistBarRangeLabels([0, 12000, 24000]), ["0 ~ 12,000", "12,000 ~ 24,000"]);
  // Decimals follow the same under-10 magnitude rule as the row summary.
  assert.deepEqual(getHistBarRangeLabels([0, 2.5, 5]), ["0 ~ 2.5000", "2.5000 ~ 5"]);
  assert.deepEqual(
    getHistBarRangeLabels([201701, 202156.5, 202612], { asDate: true }),
    ["201701 ~ 202157", "202157 ~ 202612"],
  );
  assert.deepEqual(getHistBarRangeLabels([1]), []);
  assert.deepEqual(getHistBarRangeLabels(["bad", 2]), []);
  assert.deepEqual(getHistBarRangeLabels(undefined), []);
});

test("table summary service publishes versioned distribution data", () => {
  assert.match(summaryService, /SUMMARY_VERSION = 4/);
  assert.match(summaryService, /"edges": \[float\(e\) for e in edges\]/);
  assert.match(summaryService, /def load_valid_cache\(/);
  assert.match(summaryService, /"distinct_count": distinct_count/);
  assert.match(summaryService, /"null_count": null_count/);
  assert.match(summaryService, /"null_ratio":/);
  assert.match(summaryService, /"stats": stats/);
  // Raw stats stay JSON-safe plain types because the router json.dumps the payload.
  assert.match(summaryService, /stats = \{"min": min_val, "max": max_val\}/);
  assert.match(summaryService, /min_val = float\(col_data\.min\(\)\)/);
  assert.match(summaryService, /stats = \{"min": str\(min_val\), "max": str\(max_val\)\}/);
  assert.match(summaryService, /"distribution": distribution/);
  assert.match(summaryService, /"summary_version": SUMMARY_VERSION/);
  // A stale-version cache must be regenerated rather than served.
  assert.match(summaryRouter, /load_valid_cache\(path, cache_path\)/);
  assert.ok(!summaryRouter.includes("is_cache_valid(path, cache_path)"), "router still trusts mtime alone");
});
