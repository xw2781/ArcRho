import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const cssHexToken = (css, name) => {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  assert.ok(match, `theme defines a hex value for ${name}`);
  return match[1];
};

const relativeLuminance = (hex) => {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};

const contrastRatio = (foreground, background) => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
};

const declarationsFor = (css, selectorFragment) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1].includes(selectorFragment))
  .map((match) => match[2])
  .join("\n");

const THEMED_DOCUMENTS = [
  "../ui/index.html",
  "../ui/file_explorer/file_explorer.html",
  "../ui/dataset_viewer/dataset_viewer.html",
  "../ui/method_pages/dfm/dfm.html",
  "../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html",
  "../ui/method_pages/result_selection/result_selection.html",
  "../ui/workflow/workflow.html",
  "../ui/project_instance/project_instance.html",
  "../ui/project_settings/project_settings.html",
  "../ui/shell/browsing_history.html",
  "../ui/agent_guide/agent_guide.html",
  "../ui/task_designer/task_designer.html",
  "../ui/arcode/index.html",
  "../ui/arcode/main.html",
  "../ui/arcode/code-editor/index.html",
  "../ui/arcode/notebook-editor/index.html",
  "../ui/arcode/snowflake-console/index.html",
];

test("every runtime frontend document bootstraps the shared theme before loading separated theme sheets", () => {
  for (const path of THEMED_DOCUMENTS) {
    const html = read(path);
    const bootstrap = html.indexOf("/ui/shared/services/color_theme.js?v=20260723a");
    const firstStylesheet = html.indexOf("rel=\"stylesheet\"");
    const light = html.indexOf("/ui/shared/styles/themes/light.css?v=20260722a");
    const dark = html.indexOf("/ui/shared/styles/themes/dark.css?v=20260723a");
    const endHead = html.indexOf("</head>");
    assert.ok(bootstrap >= 0, `${path} loads the shared bootstrap`);
    assert.ok(firstStylesheet < 0 || bootstrap < firstStylesheet, `${path} applies theme state before visual CSS`);
    assert.ok(light > bootstrap && dark > light, `${path} loads light then dark theme ownership`);
    assert.ok(endHead > dark, `${path} loads theme sheets inside the head`);
  }
});

test("light values remain explicit and dark values stay isolated", () => {
  const light = read("../ui/shared/styles/themes/light.css");
  const dark = read("../ui/shared/styles/themes/dark.css");

  assert.match(light, /:root\[data-arcrho-theme="light"\]/);
  assert.match(light, /--ar-native-window-background:\s*#ffffff/);
  assert.match(light, /--ar-color-surface:\s*#ffffff/);
  assert.match(light, /--ar-color-text:\s*#1f2937/);
  assert.match(light, /--ar-color-accent:\s*#2b6df6/);
  assert.match(light, /--ar-color-scrollbar-track:\s*#f1f3f5/);
  assert.match(light, /--ar-chart-dataset-status-text:\s*#000000/);
  assert.match(light, /--ar-chart-dfm-empty-text:\s*#555555/);
  assert.match(light, /--ar-chart-dfm-point-border:\s*#94a3b8/);
  assert.doesNotMatch(light, /data-arcrho-theme="dark"/);

  assert.match(dark, /:root\[data-arcrho-theme="dark"\]/);
  assert.match(dark, /color-scheme:\s*dark/);
  assert.doesNotMatch(dark, /:root\[data-arcrho-theme="light"\]/);

  const lightTokens = [...light.matchAll(/(--ar-[\w-]+)\s*:/g)].map((match) => match[1]);
  const darkTokens = new Set([...dark.matchAll(/(--ar-[\w-]+)\s*:/g)].map((match) => match[1]));
  for (const token of lightTokens) assert.ok(darkTokens.has(token), `dark theme defines ${token}`);
});

test("dark theme text tokens keep readable contrast on operational surfaces", () => {
  const dark = read("../ui/shared/styles/themes/dark.css");
  const pairs = [
    ["--ar-color-text", "--ar-color-canvas"],
    ["--ar-color-text", "--ar-color-surface"],
    ["--ar-color-text-muted", "--ar-color-surface"],
    ["--ar-color-text-subtle", "--ar-color-surface"],
    ["--ar-color-accent", "--ar-color-accent-soft"],
    ["--ar-color-success", "--ar-color-success-soft"],
    ["--ar-color-warning", "--ar-color-warning-soft"],
    ["--ar-color-danger", "--ar-color-danger-soft"],
  ];

  for (const [foregroundName, backgroundName] of pairs) {
    const foreground = cssHexToken(dark, foregroundName);
    const background = cssHexToken(dark, backgroundName);
    const ratio = contrastRatio(foreground, background);
    assert.ok(ratio >= 4.5, `${foregroundName} on ${backgroundName} has ${ratio.toFixed(2)}:1 contrast`);
  }
});

test("dark titlebar window controls use themed surfaces and state colors", () => {
  const dark = read("../ui/shared/styles/themes/dark.css");
  const button = declarationsFor(dark, ".titlebarBtn");
  const icon = declarationsFor(dark, ".titlebarIcon");
  const standardHover = declarationsFor(dark, "#titlebarMinBtn");
  const closeHover = declarationsFor(dark, "#titlebarCloseBtn");

  assert.match(button, /background-color:\s*var\(--ar-color-surface-raised\)/);
  assert.match(button, /border-color:\s*var\(--ar-color-border-strong\)/);
  assert.match(icon, /stroke:\s*currentColor/);
  assert.match(standardHover, /background-color:\s*var\(--ar-color-accent-soft\)/);
  assert.match(standardHover, /border-color:\s*var\(--ar-color-border-focus\)/);
  assert.match(closeHover, /background-color:\s*#9f2940/);
  assert.match(closeHover, /border-color:\s*var\(--ar-color-danger\)/);
  assert.match(closeHover, /color:\s*#ffffff/);
});

test("Project Settings and Project Instance override light-only child paint in Dark mode", () => {
  const dark = read("../ui/shared/styles/themes/dark.css");
  const requiredRules = [
    [".ptree-label", /color:\s*var\(--ar-color-text\)/],
    [".pi-table-header-cell", /background:\s*var\(--ar-color-table-header\)/],
    [".pi-window-titlebar", /background:\s*var\(--ar-popout-header\)/],
    [".pi-window-titlebar-icon", /stroke:\s*currentColor/],
    [".pi-number-formats-header", /background-color:\s*var\(--ar-color-surface-muted\)/],
    [".tree-project", /color:\s*var\(--ar-color-text\)/],
    [".ribbon-label", /color:\s*var\(--ar-color-text-muted\)/],
    [".summary-columns", /background:\s*var\(--ar-color-input\)/],
    [".summary-derived-label", /color:\s*var\(--ar-color-text-muted\)/],
    [".stat-value", /color:\s*var\(--ar-color-text-strong\)/],
    ["#datasetTypesErrorTitle", /color:\s*var\(--ar-color-text\)/],
    [".rct-formula-calculated-icon", /color:\s*var\(--ar-color-accent-strong\)/],
    [".dpr-token-menu-tick", /color:\s*var\(--ar-color-accent-strong\)/],
    [".dpr-editor", /--dpr-ink:\s*inherit/],
  ];

  for (const [selector, expectedDeclaration] of requiredRules) {
    const declarations = declarationsFor(dark, selector);
    assert.ok(declarations, `dark theme contains ${selector}`);
    assert.match(declarations, expectedDeclaration, `${selector} uses shared dark-theme paint`);
  }
  assert.doesNotMatch(dark, /\.pi-number-formats-titlebar/);

  const datasetTypesCss = read("../ui/project_settings/project_settings_dataset_types.css");
  const datasetTypesJs = read("../ui/project_settings/project_settings_dataset_types.js");
  const projectSettingsHtml = read("../ui/project_settings/project_settings.html");
  assert.match(datasetTypesCss, /\.datasetTypesRecalcOverlay\s*\{/);
  assert.doesNotMatch(datasetTypesJs, /datasetTypesRecalcDialogStyles|createElement\("style"\)/);
  assert.match(projectSettingsHtml, /project_settings_dataset_types\.css\?v=20260722a/);
});

test("theme runtime validates, persists per user, applies, notifies frames, and updates Monaco live", async () => {
  const source = read("../ui/shared/services/color_theme.js");
  const attributes = new Map();
  const storage = new Map();
  const listeners = new Map();
  const posted = [];
  const monacoThemes = [];
  const events = [];
  const nativeBackgrounds = [];
  const savedHostThemes = [];
  const root = {
    getAttribute: (name) => attributes.get(name) || null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const context = {
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    document: {
      documentElement: root,
      readyState: "complete",
      querySelectorAll: () => [{ contentWindow: { postMessage: (message) => posted.push(message) } }],
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { search: "" },
    monaco: { editor: { setTheme: (theme) => monacoThemes.push(theme) } },
    getComputedStyle: () => ({ getPropertyValue: () => "#ffffff" }),
    ADAHost: {
      setWindowBackgroundColor: (color) => nativeBackgrounds.push(color),
      loadColorThemePreference: async () => ({ exists: false, theme: "light" }),
      saveColorThemePreference: async (theme) => {
        savedHostThemes.push(theme);
        return { ok: true, theme };
      },
    },
    addEventListener: (type, handler) => listeners.set(type, handler),
    dispatchEvent: (event) => events.push(event),
  };
  context.window = context;
  context.top = context;

  vm.runInNewContext(source, context, { filename: "color_theme.js" });
  assert.equal(attributes.get("data-arcrho-theme"), "light");
  assert.equal(context.ArcRhoColorTheme.normalizeTheme("unsupported"), "light");
  assert.equal(context.ArcRhoColorTheme.getMonacoTheme("dark"), "vs-dark");

  context.ArcRhoColorTheme.setTheme("dark");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(storage.get("arcrho_color_theme"), "dark");
  assert.equal(savedHostThemes.at(-1), "dark");
  assert.equal(attributes.get("data-arcrho-theme"), "dark");
  assert.equal(monacoThemes.at(-1), "vs-dark");
  assert.equal(posted.at(-1)?.type, "arcrho:set-color-theme");
  assert.equal(posted.at(-1)?.theme, "dark");
  assert.equal(events.at(-1).type, "arcrho:color-theme-changed");
  assert.equal(nativeBackgrounds.at(-1), "#ffffff");

  listeners.get("message")?.({ data: { type: "arcrho:set-color-theme", theme: "light" } });
  assert.equal(attributes.get("data-arcrho-theme"), "light");
  assert.equal(monacoThemes.at(-1), "vs");

  const childNativeBackgrounds = [];
  const childContext = {
    CustomEvent: context.CustomEvent,
    document: {
      documentElement: root,
      readyState: "complete",
      querySelectorAll: () => [],
    },
    localStorage: context.localStorage,
    location: { search: "" },
    getComputedStyle: context.getComputedStyle,
    ADAHost: { setWindowBackgroundColor: (color) => childNativeBackgrounds.push(color) },
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  childContext.window = childContext;
  childContext.top = {};
  vm.runInNewContext(source, childContext, { filename: "color_theme_child.js" });
  assert.deepEqual(childNativeBackgrounds, [], "child frames do not overwrite native BrowserWindow paint");
});

test("theme runtime restores the Electron user preference after renderer storage is cleared", async () => {
  const source = read("../ui/shared/services/color_theme.js");
  const attributes = new Map();
  const storage = new Map();
  const context = {
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    URLSearchParams,
    document: {
      documentElement: {
        getAttribute: (name) => attributes.get(name) || null,
        setAttribute: (name, value) => attributes.set(name, value),
      },
      readyState: "complete",
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { search: "" },
    getComputedStyle: () => ({ getPropertyValue: () => "#151a22" }),
    ADAHost: {
      loadColorThemePreference: async () => ({ exists: true, theme: "dark" }),
      saveColorThemePreference: async () => ({ ok: true, theme: "dark" }),
      setWindowBackgroundColor: () => {},
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  context.window = context;
  context.top = context;

  vm.runInNewContext(source, context, { filename: "color_theme_restore.js" });
  assert.equal(attributes.get("data-arcrho-theme"), "light", "renderer cache starts from its fallback");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attributes.get("data-arcrho-theme"), "dark", "host preference restores the selected theme");
  assert.equal(storage.get("arcrho_color_theme"), "dark", "renderer cache is rebuilt from the host preference");
});

test("ArcRho and standalone Arcode expose accessible live theme choices", () => {
  const shellHtml = read("../ui/index.html");
  const shellPreferences = read("../ui/shell/shell_preferences.js");
  const shellMenus = read("../ui/shell/shell_menus.js");
  const iframeHost = read("../ui/shell/iframe_host.js");
  const arcodeHtml = read("../ui/arcode/main.html");
  const arcodeMain = read("../ui/arcode/main.js");

  for (const html of [shellHtml, arcodeHtml]) {
    assert.match(html, /data-action="color-theme-light"[^>]*role="menuitemradio"/);
    assert.match(html, /data-action="color-theme-dark"[^>]*role="menuitemradio"/);
    assert.match(html, /data-color-theme-trigger[^>]*tabindex="0"/);
    assert.match(html, /data-color-theme-menu[^>]*aria-haspopup="menu"/);
    assert.match(html, /data-color-theme-value="light"[^>]*tabindex="-1"/);
  }
  assert.match(shellPreferences, /api\?\.setTheme\?\./);
  assert.match(shellPreferences, /type:\s*messageType,\s*theme:\s*normalized/);
  assert.match(shellMenus, /action === "color-theme-light" \|\| action === "color-theme-dark"/);
  assert.match(iframeHost, /postMessage\(\{ type: messageType, theme \}/);
  assert.match(arcodeMain, /ArcRhoColorTheme\?\.setTheme/);
  assert.match(arcodeMain, /\.menu\[aria-expanded="true"\][^\n]*setAttribute\("aria-expanded", "false"\)/);

  const runtime = read("../ui/shared/services/color_theme.js");
  assert.match(runtime, /wireThemeMenus/);
  assert.match(runtime, /\["Enter", " ", "ArrowDown"\]/);
  assert.match(runtime, /event\.key === "ArrowUp"/);
  assert.match(runtime, /event\.key === "ArrowLeft" \|\| event\.key === "Escape"/);
});

test("shell submenu indicators use the shared SVG chevron instead of text glyphs", () => {
  const shellHtml = read("../ui/index.html");
  const shellCss = read("../ui/shell/shell.css");
  const arcodeHtml = read("../ui/arcode/main.html");
  const arcodeCss = read("../ui/arcode/main.css");
  const icon = read("../ui/shared/icons/chevron-right.svg");

  for (const html of [shellHtml, arcodeHtml]) {
    assert.match(html, /class="menuSubmenuIcon"/);
    assert.match(html, /chevron-right\.svg\?v=20260722a#chevron-right/);
  }
  assert.match(icon, /<symbol id="chevron-right"/);
  assert.match(icon, /stroke="currentColor"/);
  assert.doesNotMatch(shellCss, /hasSubmenu::after/);
  assert.doesNotMatch(shellCss, /content:\s*">"/);
  assert.doesNotMatch(arcodeHtml, /class="menuArrow"/);
  assert.doesNotMatch(arcodeCss, /\.menuArrow/);
});

test("all Monaco owners choose the shared initial theme and Electron accepts computed theme paint", () => {
  const editorOwners = [
    read("../ui/arcode/code-editor/index.js"),
    read("../ui/arcode/notebook-editor/core.js"),
    read("../ui/arcode/snowflake-console/index.js"),
  ];
  for (const owner of editorOwners) {
    assert.match(owner, /ArcRhoColorTheme\?\.getMonacoTheme\?\.\(\) \|\| "vs"/);
    assert.doesNotMatch(owner, /theme:\s*"vs"/);
  }

  const preload = read("../electron/preload.js");
  const main = read("../electron/main.js");
  assert.match(preload, /setWindowBackgroundColor/);
  assert.match(preload, /loadColorThemePreference/);
  assert.match(preload, /saveColorThemePreference/);
  assert.match(main, /ipcMain\.handle\("window-set-background-color"/);
  assert.match(main, /ipcMain\.handle\("color-theme-preference-load"/);
  assert.match(main, /ipcMain\.handle\("color-theme-preference-save"/);
  assert.match(main, /color_theme:\s*theme/);
  assert.match(main, /buildArcRhoUrl\(\{ uiVersion \}\)/);
  assert.match(main, /normalizeColorThemePreference\(payload\?\.colorTheme\)/);
  assert.match(read("../ui/shell/app_lifecycle.js"), /colorTheme:\s*shell\.getColorTheme\?\.\(\)/);
  assert.match(read("../ui/arcode/main.js"), /colorTheme:\s*window\.ArcRhoColorTheme\?\.getTheme\?\.\(\)/);
  assert.match(main, /getIpcWindow\(event\)/);
  assert.match(main, /setBackgroundColor\(color\)/);
  assert.match(main, /saveCachedWindowBackgroundColor\(color\)/);
  assert.doesNotMatch(main, /saveCachedWindowBackgroundColor\(DEFAULT_WINDOW_BACKGROUND_COLOR\)/);

  const light = read("../ui/shared/styles/themes/light.css");
  const runtime = read("../ui/shared/services/color_theme.js");
  assert.match(light, /data-arcrho-app="arcode"[\s\S]*--ar-native-window-background:\s*#f7f8fa/);
  assert.match(runtime, /global\.top && global\.top !== global/);
});

test("the startup splash mirrors the renderer-derived persisted theme without changing Light defaults", () => {
  const splash = read("../ui/splash.html");
  const dark = read("../ui/shared/styles/themes/dark.css");
  const main = read("../electron/main.js");

  const bootstrap = splash.indexOf("data-arcrho-theme");
  const inlineStyles = splash.indexOf("<style>");
  assert.ok(bootstrap >= 0 && bootstrap < inlineStyles, "splash theme state is set before first paint styles");
  assert.match(splash, /requestedTheme === "dark" \? "dark" : "light"/);
  assert.match(splash, /background:\s*#f8f9fc/);
  assert.match(splash, /\.\/shared\/styles\/themes\/light\.css\?v=20260722a/);
  assert.match(splash, /\.\/shared\/styles\/themes\/dark\.css\?v=20260723a/);
  assert.match(dark, /\.startupSplash/);
  assert.match(dark, /\.splash-container\s*\{[^}]*width:\s*292px[^}]*border:\s*1px solid var\(--ar-color-border\)[^}]*border-radius:\s*6px/s);
  assert.match(dark, /\.logo-icon img\s*\{[^}]*width:\s*88px[^}]*height:\s*88px/s);
  assert.match(dark, /\.logo-icon\s*\{[^}]*animation:\s*none/s);
  assert.match(dark, /:is\(\.orb, \.scan-line\)\s*\{[^}]*display:\s*none/s);
  assert.match(main, /theme:\s*isDarkWindowBackgroundColor\(startupBackgroundColor\) \? "dark" : "light"/);
  assert.match(main, /backgroundColor:\s*startupBackgroundColor/);
});

test("changed theme and chart owners are reached through current cache-version chains", () => {
  const expectedReferences = [
    ["../ui/dataset_viewer/dataset_viewer.html", "dataset_viewer_main.js?v=20260722a"],
    ["../ui/dataset_viewer/dataset_viewer_main.js", "dataset_chart_tab.js?v=20260722a"],
    ["../ui/dataset_viewer/tabs/dataset_chart_tab.js", "dataset_chart_renderer.js?v=20260722a"],
    ["../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html", "bornhuetter_ferguson_main.js?v=20260722a"],
    ["../ui/method_pages/result_selection/result_selection.html", "result_selection_main.js?v=20260722b"],
    ["../ui/method_pages/dfm/dfm.html", "dfm_main.js?v=20260722b"],
    ["../ui/project_settings/project_settings.html", "project_settings.js?v=20260722a"],
    ["../ui/project_settings/project_settings.js", "project_settings_dataset_types.js?v=20260722a"],
    ["../ui/arcode/code-editor/index.html", "code-editor/index.js?v=20260722a"],
    ["../ui/arcode/notebook-editor/index.html", "notebook-editor/core.js?v=20260722a"],
    ["../ui/arcode/snowflake-console/index.html", "snowflake-console/index.js?v=20260722a"],
  ];
  for (const [path, reference] of expectedReferences) {
    assert.ok(read(path).includes(reference), `${path} loads ${reference}`);
  }

  const iframeHost = read("../ui/shell/iframe_host.js");
  assert.match(iframeHost, /workflow\.html\?\$\{params\.toString\(\)\}/);
  assert.match(iframeHost, /params\.set\("v", uiVersionParam\)/);
});

test("large page styles are maintained as feature CSS instead of inline blocks", () => {
  const extractedPages = [
    ["../ui/index.html", "/ui/shell/shell.css"],
    ["../ui/workflow/workflow.html", "/ui/workflow/workflow.css"],
    ["../ui/project_instance/project_instance.html", "/ui/project_instance/project_instance.css"],
    ["../ui/method_pages/dfm/dfm.html", "/ui/method_pages/dfm/dfm.css"],
    ["../ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.html", "/ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson.css"],
    ["../ui/method_pages/result_selection/result_selection.html", "/ui/method_pages/result_selection/result_selection.css"],
    ["../ui/shell/browsing_history.html", "/ui/shell/browsing_history.css"],
    ["../ui/agent_guide/agent_guide.html", "/ui/agent_guide/agent_guide.css"],
  ];
  for (const [path, stylesheet] of extractedPages) {
    const html = read(path);
    assert.match(html, new RegExp(stylesheet.replaceAll("/", "\\/")));
    assert.doesNotMatch(html, /<style>/);
  }
});
