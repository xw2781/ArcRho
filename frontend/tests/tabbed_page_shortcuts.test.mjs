import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(id = "") {
    super();
    this.id = id;
    this.dataset = {};
    this.attributes = new Map();
    this.classList = {
      add: () => {},
      toggle: () => {},
    };
    this.style = {
      display: "",
      setProperty: () => {},
    };
    this.tabIndex = -1;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  focus() {}
}

function keyboardEvent(key, { blocked = false } = {}) {
  return {
    key,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    target: { closest: () => (blocked ? {} : null) },
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

test("shared tabbed pages cycle with Ctrl+PageUp/PageDown and host messages", async () => {
  const source = await readFile(new URL("ui/shared/tabbed_page/tabbed_page.js", frontendRoot), "utf8");
  const fakeWindow = new FakeEventTarget();
  fakeWindow.location = { search: "" };

  const pages = new Map([
    ["testDetailsPage", new FakeElement("testDetailsPage")],
    ["testDataPage", new FakeElement("testDataPage")],
    ["testNotesPage", new FakeElement("testNotesPage")],
  ]);
  const buttons = ["details", "data", "notes"].map((tabId) => {
    const button = new FakeElement();
    button.dataset.page = tabId;
    return button;
  });
  const tabBar = new FakeElement();
  tabBar.querySelectorAll = () => buttons;
  const container = new FakeElement();
  container.querySelector = () => tabBar;

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = fakeWindow;
  globalThis.document = {
    getElementById: (id) => pages.get(id) || null,
  };

  try {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    const tabbedPage = await import(moduleUrl);
    const changes = [];
    const system = tabbedPage.createTabbedPage(container, {
      tabs: [
        { id: "details", label: "Details" },
        { id: "data", label: "Data" },
        { id: "notes", label: "Notes" },
      ],
      cssPrefix: "test",
      injectTabBar: false,
      nextTabMessageTypes: ["arcrho:legacy-next"],
      onTabChange: (tabId) => changes.push(tabId),
    });

    assert.equal(system.getCurrentTab(), "details");

    const nextEvent = keyboardEvent("PageDown");
    fakeWindow.dispatch("keydown", nextEvent);
    assert.equal(system.getCurrentTab(), "data");
    assert.equal(nextEvent.defaultPrevented, true);
    assert.equal(nextEvent.propagationStopped, true);

    fakeWindow.dispatch("message", { data: { type: tabbedPage.TABBED_PAGE_NEXT_MESSAGE } });
    assert.equal(system.getCurrentTab(), "notes");
    fakeWindow.dispatch("message", { data: { type: tabbedPage.TABBED_PAGE_NEXT_MESSAGE } });
    assert.equal(system.getCurrentTab(), "details", "next wraps to the first tab");
    fakeWindow.dispatch("message", { data: { type: tabbedPage.TABBED_PAGE_PREVIOUS_MESSAGE } });
    assert.equal(system.getCurrentTab(), "notes", "previous wraps to the last tab");
    fakeWindow.dispatch("message", { data: { type: "arcrho:legacy-next" } });
    assert.equal(system.getCurrentTab(), "details", "configured message aliases use the shared cycle path");

    const blockedEvent = keyboardEvent("PageUp", { blocked: true });
    fakeWindow.dispatch("keydown", blockedEvent);
    assert.equal(system.getCurrentTab(), "details");
    assert.equal(blockedEvent.defaultPrevented, false);

    system.destroy();
    fakeWindow.dispatch("message", { data: { type: tabbedPage.TABBED_PAGE_NEXT_MESSAGE } });
    assert.equal(system.getCurrentTab(), "details", "destroy removes host shortcut listeners");
    assert.deepEqual(changes, ["details", "data", "notes", "details", "notes", "details"]);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("shell and Project Instance forward the shared shortcut to every hosted page", async () => {
  const [shellHotkeys, projectMessages, dfmTabs, sharedTabs, ...pageSources] = await Promise.all([
    readFile(new URL("ui/shell/shell_hotkeys.js", frontendRoot), "utf8"),
    readFile(new URL("ui/project_instance/project_instance_messages.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/dfm/dfm_tabs_orchestrator.js", frontendRoot), "utf8"),
    readFile(new URL("ui/shared/tabbed_page/tabbed_page.js", frontendRoot), "utf8"),
    readFile(new URL("ui/dataset_viewer/dataset_viewer_main.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/bornhuetter_ferguson/bornhuetter_ferguson_main.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/cape_cod/cape_cod_main.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/result_selection/result_selection_ui.js", frontendRoot), "utf8"),
    readFile(new URL("ui/method_pages/berquist_sherman/berquist_sherman_main.js", frontendRoot), "utf8"),
  ]);

  for (const pageType of [
    "dataset",
    "dfm",
    "bornhuetter_ferguson",
    "cape_cod",
    "result_selection",
    "berquist_sherman",
    "project_instance",
  ]) {
    assert.match(shellHotkeys, new RegExp(`"${pageType}"`, "u"));
  }
  assert.match(shellHotkeys, /TABBED_PAGE_PREVIOUS_MESSAGE/u);
  assert.match(shellHotkeys, /TABBED_PAGE_NEXT_MESSAGE/u);
  assert.match(projectMessages, /routeActiveTabbedPageCommand/u);
  assert.match(projectMessages, /TABBED_PAGE_PREVIOUS_MESSAGE/u);
  assert.match(projectMessages, /TABBED_PAGE_NEXT_MESSAGE/u);
  assert.match(dfmTabs, /previousTabMessageTypes:\s*\["arcrho:dfm-tab-prev"\]/u);
  assert.match(dfmTabs, /nextTabMessageTypes:\s*\["arcrho:dfm-tab-next"\]/u);
  assert.doesNotMatch(dfmTabs, /function wireLegacyDfmTabSwitchMessages/u);
  assert.doesNotMatch(dfmTabs, /addEventListener\("keydown"[\s\S]*pageup/u);
  assert.match(sharedTabs, /addEventListener\("keydown", onWindowKeyDown/u);
  for (const pageSource of [dfmTabs, ...pageSources]) {
    assert.match(pageSource, /createTabbedPage\(/u);
  }
});
