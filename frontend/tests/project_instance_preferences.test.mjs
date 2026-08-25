import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");

test("Project Instance opens one Preferences window from the dataset toolbar", async () => {
  const [html, boot, moduleSource] = await Promise.all([
    read("ui/project_instance/project_instance.html"),
    read("ui/project_instance/project_instance_boot.js"),
    read("ui/project_instance/project_instance_preferences.js"),
  ]);

  assert.match(html, /id="piPrefsBtn"/);
  assert.match(html, /id="piPrefsOverlay"/);
  assert.match(html, /id="piPrefsNav"/);
  assert.match(html, /id="piPrefsPanelFormats"/);
  assert.match(html, /id="piPrefsPanelTabs"/);
  assert.match(boot, /installProjectInstancePreferences\(ctx\)/);
  assert.match(boot, /api\.initProjectInstancePreferences\(\)/);
  // The default tabs are local-user state the page state carries from the
  // start, so boot has no read of its own to wait for.
  assert.doesNotMatch(boot, /loadDefaultWindowTabPreferences/);
  assert.match(moduleSource, /export function installProjectInstancePreferences/);
});

test("The shared number-format section keeps its server-wide contract", async () => {
  const [html, moduleSource] = await Promise.all([
    read("ui/project_instance/project_instance.html"),
    read("ui/project_instance/project_instance_preferences.js"),
  ]);

  assert.match(html, /<th>Dataset Type Name<\/th>/);
  assert.doesNotMatch(html, /<th>Reserving Class Path<\/th>/);
  assert.doesNotMatch(html, /<th>Dataset Name<\/th>/);
  assert.match(moduleSource, /\/dataset\/number-format-defaults/);
  assert.match(moduleSource, /method: "PUT"/);
  assert.match(moduleSource, /expected_revision/);
  assert.match(moduleSource, /dataset_type_name/);
  assert.doesNotMatch(moduleSource, /reserving_class/);
  assert.doesNotMatch(moduleSource, /row\.dataset_name/);
});

test("The default-tab section keeps one local choice used by every project", async () => {
  const [moduleSource, catalog] = await Promise.all([
    read("ui/project_instance/project_instance_preferences.js"),
    read("ui/shared/tabs/window_tab_catalog.js"),
  ]);

  // One browser-storage key on this PC, never a file under a project.
  assert.match(catalog, /export const DEFAULT_WINDOW_TABS_STORAGE_KEY = "arcrho_default_window_tabs";/);
  assert.match(catalog, /localStorage\?\.setItem\(DEFAULT_WINDOW_TABS_STORAGE_KEY/);
  // A partial map would leave a kind on an older stored value.
  assert.match(catalog, /const defaults = normalizeDefaultWindowTabs\(chosen\);/);
  assert.match(moduleSource, /const chosen = writeDefaultWindowTabs\(editor\.tabs\.chosen\);/);
  assert.match(moduleSource, /state\.defaultWindowTabs = chosen;/);
  assert.doesNotMatch(moduleSource, /ProjectUserPreferences/);
  // A save in one project reaches the windows already open on the others.
  assert.match(moduleSource, /window\.addEventListener\("storage", adoptTabDefaultsFromAnotherWindow\)/);
});

test("Both scroll surfaces in the window use the shared framed scrollbar", async () => {
  const [html, css, sharedCss] = await Promise.all([
    read("ui/project_instance/project_instance.html"),
    read("ui/project_instance/project_instance_preferences.css"),
    read("ui/shared/styles/framed_scrollbars.css"),
  ]);

  assert.match(html, /shared\/styles\/framed_scrollbars\.css/);
  assert.match(html, /class="pi-number-formats-table-wrap ar-framed-scroll"/);
  assert.match(html, /class="pi-prefs-tab-list ar-framed-scroll"/);
  // One arrow at each tray end, and no page-local copy of the treatment.
  assert.match(sharedCss, /::-webkit-scrollbar-button:vertical:start:decrement/);
  assert.match(sharedCss, /::-webkit-scrollbar-button:vertical:end:increment/);
  assert.doesNotMatch(css, /-webkit-scrollbar/);
});

test("Project Instance windows open on the user's default tab", async () => {
  const [windows, catalog, context] = await Promise.all([
    read("ui/project_instance/project_instance_windows.js"),
    read("ui/shared/tabs/window_tab_catalog.js"),
    read("ui/project_instance/project_instance_context.js"),
  ]);

  assert.match(windows, /import \{ resolveWindowTab \} from "\/ui\/shared\/tabs\/window_tab_catalog\.js/);
  assert.match(windows, /const windowTab = \(kind, requestedTab\) => resolveWindowTab\(kind, requestedTab, state\.defaultWindowTabs\);/);
  for (const kind of ["dataset", "dfm", "result_selection", "bornhuetter_ferguson", "cape_cod", "berquist_sherman"]) {
    assert.ok(windows.includes(`windowTab("${kind}"`), `${kind} windows resolve their tab`);
  }
  // No opener may hard-code a default tab beside the catalog's.
  assert.doesNotMatch(windows, /options\?\.dfmTab \|\| "ratios"/);
  assert.match(context, /defaultWindowTabs: readDefaultWindowTabs\(\)/);
  // Every kind's app default, in catalog order.
  assert.deepEqual(catalog.match(/appDefaultTab: "(\w+)"/gu), [
    'appDefaultTab: "data"',
    'appDefaultTab: "ratios"',
    'appDefaultTab: "method"',
    'appDefaultTab: "method"',
    'appDefaultTab: "method"',
    'appDefaultTab: "method"',
  ]);
});

test("Every tabbed page reads its tab list from the shared catalog", async () => {
  const [catalog, dsv, dfmConfig, bf, cc, rs, bs, dataTab] = await Promise.all([
    read("ui/shared/tabs/window_tab_catalog.js"),
    read("ui/dataset_viewer/dataset_viewer_main.js"),
    read("ui/method_pages/dfm/dfm_tab_config.js"),
    read("ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js"),
    read("ui/method_pages/cape_cod/cape_cod_main.js"),
    read("ui/method_pages/result_selection/result_selection_main.js"),
    read("ui/method_pages/berquist_sherman/berquist_sherman_main.js"),
    read("ui/shared/tabs/data/data_tab_controller.js"),
  ]);

  assert.match(catalog, /export const WINDOW_TAB_KINDS/);
  assert.match(dsv, /DATASET_VIEWER_TAB_DEFS as DATASET_VIEWER_TABS/);
  assert.match(dfmConfig, /DFM_TAB_DEFS as CATALOG_DFM_TAB_DEFS/);
  assert.match(bf, /const BF_TABS = BORNHUETTER_FERGUSON_TAB_DEFS;/);
  assert.match(cc, /const CC_TABS = CAPE_COD_TAB_DEFS;/);
  assert.match(rs, /const RS_TAB_DEFS = RESULT_SELECTION_TAB_DEFS;/);
  assert.match(bs, /const TABS = BERQUIST_SHERMAN_TAB_DEFS;/);
  assert.match(dataTab, /DATASET_VIEWER_TAB_IDS: windowTabIds\("dataset"\)/);
  // The Data tab's own id set was a second copy of the Dataset Viewer's tabs.
  assert.doesNotMatch(dataTab, /new Set\(\["details", "data", "chart"/);
});

test("The default-tab chips carry no app-default marker", async () => {
  const [moduleSource, css, html] = await Promise.all([
    read("ui/project_instance/project_instance_preferences.js"),
    read("ui/project_instance/project_instance_preferences.css"),
    read("ui/project_instance/project_instance.html"),
  ]);

  for (const [name, sourceText] of [["module", moduleSource], ["stylesheet", css], ["markup", html]]) {
    assert.doesNotMatch(sourceText, /is-app-default/u, `${name} has no app-default marker`);
    assert.doesNotMatch(sourceText, /pi-prefs-tab-legend/u, `${name} has no app-default legend`);
  }
});

test("Opening an existing method never pins its tab past the preference", async () => {
  const [table, messages, windows] = await Promise.all([
    read("ui/project_instance/project_instance_dataset_table.js"),
    read("ui/project_instance/project_instance_messages.js"),
    read("ui/project_instance/project_instance_windows.js"),
  ]);

  // "Open Result Selection" and its siblings used to hard-code the Method tab,
  // which silently beat the user's default for every method page but DFM.
  for (const [name, sourceText] of [["dataset table", table], ["automation routes", messages]]) {
    assert.doesNotMatch(sourceText, /initialTab: "method"/u, `${name} leaves the tab to the window layer`);
  }
  assert.doesNotMatch(windows, /Tab \|\| "method"/u);

  // Adding a brand-new method still opens on Details: nothing can be computed
  // before its inputs are chosen.
  assert.match(table, /fresh: true,\s+initialTab: "details"/u);
  assert.equal(table.match(/initialTab: "details"/gu)?.length, 6);
});

test("Every tabbed page paints its requested tab before the tab system loads", async () => {
  const PAGES = [
    ["ui/method_pages/dfm/dfm.html", ["details", "data", "ratios", "results", "notes", "links", "audit"]],
    ["ui/method_pages/result_selection/result_selection.html", ["details", "method", "chart", "results", "validation", "notes", "audit"]],
    ["ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html", ["details", "method", "chart", "notes", "audit"]],
    ["ui/method_pages/cape_cod/cape_cod.html", ["details", "method", "ultimates", "ratios", "notes", "audit"]],
    ["ui/method_pages/berquist_sherman/berquist_sherman.html", ["details", "method", "notes", "audit"]],
  ];

  for (const [page, tabIds] of PAGES) {
    const html = await read(page);
    // Loaded during parsing, so the requested panel is the one that paints.
    assert.match(html, /tabbed_page\/initial_tab_paint\.js\?v=[^"]+" data-auto="1"/u, `${page} runs the pre-paint pass`);
    for (const tabId of tabIds) {
      assert.ok(html.includes(`data-page="${tabId}"`), `${page} tags its ${tabId} panel`);
    }
  }

  // The Dataset Viewer builds its panels in script, so it applies the same pass
  // to the fragment before inserting it rather than running it automatically.
  const [datasetHtml, datasetView, paint] = await Promise.all([
    read("ui/dataset_viewer/dataset_viewer.html"),
    read("ui/dataset_viewer/dataset_viewer_view.js"),
    read("ui/shared/tabbed_page/initial_tab_paint.js"),
  ]);
  assert.match(datasetHtml, /tabbed_page\/initial_tab_paint\.js/u);
  assert.doesNotMatch(datasetHtml, /initial_tab_paint\.js[^"]*" data-auto/u);
  assert.match(datasetView, /window\.arcrhoApplyInitialTabbedPage\?\.\(wrapper\)/u);
  for (const tabId of ["details", "data", "chart", "notes", "links", "auditLog"]) {
    assert.ok(datasetView.includes(`data-page="${tabId}"`), `Dataset Viewer tags its ${tabId} panel`);
  }

  // It has to match what the tab system itself applies, or the handoff moves.
  assert.match(paint, /style\.display = active \? "block" : "none"/u);
  assert.match(paint, /\[data-page\]:not\(button\)/u);
});

test("Every tabbed page stays blank until its opening tab has rendered", async () => {
  const HOLDING_PAGES = [
    "ui/dataset_viewer/dataset_viewer.html",
    "ui/method_pages/dfm/dfm.html",
    "ui/method_pages/result_selection/result_selection.html",
    "ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html",
    "ui/method_pages/cape_cod/cape_cod.html",
    "ui/method_pages/berquist_sherman/berquist_sherman.html",
  ];
  for (const page of HOLDING_PAGES) {
    const html = await read(page);
    assert.match(html, /<body data-arcrho-page-hold="1">/u, `${page} holds its first paint`);
  }

  // Every held page has exactly one place that lets go of the hold, and it runs
  // whether its bootstrap succeeds or fails.
  const REVEALS = [
    ["ui/dataset_viewer/dataset_viewer_main.js", /window\.arcrhoRevealPage\?\.\(\)/u],
    ["ui/method_pages/dfm/dfm.html", /\} finally \{\s*window\.arcrhoRevealPage\?\.\(\);/u],
    ["ui/method_pages/result_selection/result_selection_main.js", /\.finally\(\(\) => window\.arcrhoRevealPage\?\.\(\)\)/u],
    ["ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js", /void init\(\)\.finally\(\(\) => window\.arcrhoRevealPage\?\.\(\)\)/u],
    ["ui/method_pages/cape_cod/cape_cod_main.js", /void init\(\)\.finally\(\(\) => window\.arcrhoRevealPage\?\.\(\)\)/u],
    ["ui/method_pages/berquist_sherman/berquist_sherman_main.js", /void init\(\)\.finally\(\(\) => window\.arcrhoRevealPage\?\.\(\)\)/u],
  ];
  for (const [path, pattern] of REVEALS) {
    assert.match(await read(path), pattern, `${path} reveals its page`);
  }

  const [paint, css] = await Promise.all([
    read("ui/shared/tabbed_page/initial_tab_paint.js"),
    read("ui/shared/tabbed_page/tabbed_page.css"),
  ]);
  // The body itself keeps painting, so a dark window cannot flash white.
  assert.match(css, /body\[data-arcrho-page-hold\] > \* \{/u);
  assert.doesNotMatch(css, /body\[data-arcrho-page-hold\] \{/u);
  // Two independent releases so a page can never stay blank: a script watchdog
  // plus a pure-CSS one that survives the script failing to load.
  assert.match(paint, /watchdog = window\.setTimeout\(revealPage, HOLD_WATCHDOG_MS\)/u);
  assert.match(paint, /addEventListener\("error", revealPage\)/u);
  assert.match(paint, /addEventListener\("unhandledrejection", revealPage\)/u);
  assert.match(css, /animation: arcrhoPageHoldRelease 0s linear 12s forwards/u);
});

test("The number-format table lists the project's dataset types without writing", async () => {
  const [moduleSource, html, context, boot] = await Promise.all([
    read("ui/project_instance/project_instance_preferences.js"),
    read("ui/project_instance/project_instance.html"),
    read("ui/project_instance/project_instance_context.js"),
    read("ui/project_instance/project_instance_boot.js"),
  ]);

  // The list of types comes from Project Settings' Dataset Types, never from a
  // reserving-class index that only names instances.
  assert.match(moduleSource, /fetchProjectDatasetTypes\(projectName\)/u);
  assert.doesNotMatch(moduleSource, /index\.json/u);
  assert.match(moduleSource, /mergeNumberFormatRows\(\{ overrides, datasetTypeNames \}\)/u);
  // Listing never writes: the only PUT is the Save path.
  assert.equal(moduleSource.match(/method: "PUT"/gu)?.length, 1);
  assert.match(moduleSource, /async function saveNumberFormats\(\) \{\s+const body = numberFormatsPayload\(\);\s+const response = await fetch\(NUMBER_FORMATS_ENDPOINT, \{\s+method: "PUT"/u);
  // A project type's name is not free text, and a blank format shows the fallback.
  assert.match(moduleSource, /nameInput\.readOnly = !!row\.in_project;/u);
  assert.match(moduleSource, /formatInput\.placeholder = row\.in_project \? fallback : "";/u);
  assert.match(html, /id="piPrefsFormatsScope"/u);
  assert.match(html, /No matching dataset types\./u);
  assert.match(context, /piPrefsFormatsScope: document\.getElementById\("piPrefsFormatsScope"\)/u);
  assert.match(boot, /project_instance_preferences\.js\?v=20260824g/u);
});

test("Project types on the fallback never become overrides", async () => {
  const {
    mergeNumberFormatRows,
    numberFormatOverridesFromRows,
    numberFormatOverridesKey,
    effectiveNumberFormat,
  } = await import(new URL("ui/project_instance/project_instance_number_format_rows.js", root));

  const overrides = [
    { dataset_type_name: "Paid Claims", number_format: "0,000.00" },
    { dataset_type_name: "Legacy Type", number_format: "0.0%" },
    { dataset_type_name: "paid claims", number_format: "ignored duplicate" },
  ];
  const rows = mergeNumberFormatRows({
    overrides,
    datasetTypeNames: ["Claim Counts", "Paid Claims", " Claim  Counts ", "Incurred Claims"],
  });

  // Project order first, each project type once, then the foreign override.
  assert.deepEqual(rows, [
    { dataset_type_name: "Claim Counts", number_format: "", in_project: true },
    { dataset_type_name: "Paid Claims", number_format: "0,000.00", in_project: true },
    { dataset_type_name: "Incurred Claims", number_format: "", in_project: true },
    { dataset_type_name: "Legacy Type", number_format: "0.0%", in_project: false },
  ]);

  // Only the rows with a format of their own reach the shared file.
  assert.deepEqual(numberFormatOverridesFromRows(rows), [
    { dataset_type_name: "Paid Claims", number_format: "0,000.00" },
    { dataset_type_name: "Legacy Type", number_format: "0.0%" },
  ]);
  // So a freshly listed project has nothing to save.
  assert.equal(
    numberFormatOverridesKey(numberFormatOverridesFromRows(rows)),
    numberFormatOverridesKey(overrides.slice(0, 2)),
  );
  // Reordering rows is not an edit.
  assert.equal(
    numberFormatOverridesKey([...overrides.slice(0, 2)].reverse()),
    numberFormatOverridesKey(overrides.slice(0, 2)),
  );
  assert.equal(effectiveNumberFormat(rows[0], "0,000"), "0,000");
  assert.equal(effectiveNumberFormat(rows[1], "0,000"), "0,000.00");

  // Rows added by hand still have to be complete and unique.
  assert.throws(
    () => numberFormatOverridesFromRows([{ dataset_type_name: "", number_format: "0", in_project: false }]),
    /Override row 1 is incomplete/u,
  );
  assert.throws(
    () => numberFormatOverridesFromRows([{ dataset_type_name: "Other", number_format: "", in_project: false }]),
    /Override row 1 is incomplete/u,
  );
  assert.throws(
    () => numberFormatOverridesFromRows([
      { dataset_type_name: "Paid Claims", number_format: "0", in_project: true },
      { dataset_type_name: "PAID CLAIMS", number_format: "0.0", in_project: false },
    ]),
    /Duplicate override: PAID CLAIMS/u,
  );
});
