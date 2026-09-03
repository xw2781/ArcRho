// A length control the open dataset has no use for is locked rather than
// removed. The Data tab locks Development Length on a Vector, which has one
// column of values and no development dimension.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requestControllerSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_request_controller.js", import.meta.url),
  "utf8",
);
const persistenceControllerSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_persistence_controller.js", import.meta.url),
  "utf8",
);
const datasetViewerCss = await readFile(
  new URL("../ui/dataset_viewer/dataset_viewer.css", import.meta.url),
  "utf8",
);

// The controller imports its siblings by their server-absolute `/ui/...` paths,
// which Node cannot resolve. Only the tooltip binding is reached on the paths
// under test, so the imports are swapped for no-op stubs and the module is
// loaded from source rather than pulling in the whole page graph.
function importRequestController() {
  const stubbed = requestControllerSource.replace(
    /^import\s*\{([\s\S]*?)\}\s*from\s*"\/ui\/[^"]*";$/gmu,
    (_match, names) => `const {${names}} = __moduleStubs;`,
  );
  const source = `const __moduleStubs = new Proxy({}, { get: () => () => {} });\n${stubbed}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.handlers = new Map();
    this.className = "";
    this.textContent = "";
    this.tabIndex = 0;
    this.classList = {
      contains: (name) => this.className.split(/\s+/u).includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/u).filter(Boolean));
        if (force === undefined ? classes.has(name) : !force) classes.delete(name);
        else classes.add(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  set innerHTML(_value) { this.children = []; }

  get innerHTML() { return ""; }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

  hasAttribute(name) { return this.attributes.has(name); }

  removeAttribute(name) { this.attributes.delete(name); }

  appendChild(child) { this.children.push(child); return child; }

  addEventListener(type, handler) { this.handlers.set(type, handler); }

  dispatchEvent(event) { this.handlers.get(event?.type)?.(event); return true; }

  querySelector(selector) {
    return selector === ".lenSelectValue" ? this.valueLabel : null;
  }

  fire(type, event = {}) {
    this.handlers.get(type)?.({ preventDefault() {}, stopPropagation() {}, ...event });
  }
}

class FakeSelect extends FakeElement {
  constructor(values) {
    super("select");
    this.options = values.map((value) => ({ value: String(value), textContent: String(value) }));
    this.selectedIndex = 0;
  }

  get value() { return this.options[this.selectedIndex]?.value ?? ""; }

  set value(next) {
    const index = this.options.findIndex((option) => option.value === String(next));
    if (index >= 0) this.selectedIndex = index;
  }
}

function buildLengthControlDom() {
  const elements = {};
  for (const name of ["origin", "dev"]) {
    const wrap = new FakeElement();
    wrap.className = "lenSelectWrap";
    const button = new FakeElement("button");
    button.valueLabel = new FakeElement("span");
    button.valueLabel.textContent = "12";
    const dropdown = new FakeElement();
    const select = new FakeSelect([12, 6, 3, 1]);
    elements[`${name}LenWrap`] = wrap;
    elements[`${name}LenDisplay`] = button;
    elements[`${name}LenDropdown`] = dropdown;
    elements[`${name}LenSelect`] = select;
  }
  return elements;
}

async function createLengthControlRuntime() {
  const elements = buildLengthControlDom();
  const originalDocument = globalThis.document;
  globalThis.document = {
    body: new FakeElement("body"),
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const runtime = {
    state: { dirty: new Map(), model: null },
    config: {},
    isTemporaryDatasetView: false,
    qs: new URLSearchParams(""),
    temporaryDatasetSessionId: "",
    LEN_DROPDOWN_CONFIG: {
      originLenSelect: {
        wrapId: "originLenWrap",
        buttonId: "originLenDisplay",
        dropdownId: "originLenDropdown",
      },
      devLenSelect: {
        wrapId: "devLenWrap",
        buttonId: "devLenDisplay",
        dropdownId: "devLenDropdown",
      },
    },
    createDatasetDependencyGuard: () => ({}),
    showProjectDropdown() {},
    showDatasetDropdown() {},
  };
  const { registerDataTabRequestController } = await importRequestController();
  registerDataTabRequestController(runtime);
  runtime.wireLenDropdowns();
  return { runtime, elements, restore: () => { globalThis.document = originalDocument; } };
}

test("a locked length control shows its fixed value and cannot be opened", async () => {
  const { runtime, elements, restore } = await createLengthControlRuntime();
  try {
    const wrap = elements.devLenWrap;
    const button = elements.devLenDisplay;
    const select = elements.devLenSelect;

    // Unlocked, the trigger reads the select and opens its list on click.
    assert.equal(button.valueLabel.textContent, "12");
    button.fire("click");
    assert.equal(wrap.classList.contains("open"), true);

    runtime.setLenSelectLock("devLenSelect", {
      locked: true,
      displayValue: "0",
      reason: "A vector has no development periods.",
    });

    // Locking closes the open list and repaints the trigger as a fixed 0.
    assert.equal(wrap.classList.contains("open"), false);
    assert.equal(button.valueLabel.textContent, "0");
    assert.equal(wrap.classList.contains("is-locked"), true);
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(button.tabIndex, -1);
    assert.equal(wrap.getAttribute("data-locked-reason"), "A vector has no development periods.");

    // The value underneath is untouched, so nothing that reads the stored
    // development length sees a 0 the user never chose.
    assert.equal(select.value, "12");

    // Click, keyboard, and wheel all refuse while locked.
    button.fire("click");
    assert.equal(wrap.classList.contains("open"), false);
    button.fire("keydown", { key: "ArrowDown" });
    assert.equal(wrap.classList.contains("open"), false);
    button.fire("wheel", { deltaY: 1 });
    assert.equal(select.value, "12");
    assert.equal(button.valueLabel.textContent, "0");

    // A later repaint of the list cannot restore the real value to the trigger.
    runtime.renderLenDropdownOptions("devLenSelect");
    assert.equal(button.valueLabel.textContent, "0");
    runtime.setLenSelectValue("devLenSelect", "6");
    assert.equal(button.valueLabel.textContent, "0");
    assert.equal(select.value, "6");

    // The neighbouring control is unaffected by the lock.
    assert.equal(elements.originLenWrap.classList.contains("is-locked"), false);
    elements.originLenDisplay.fire("click");
    assert.equal(elements.originLenWrap.classList.contains("open"), true);

    // Unlocking hands the trigger back to the select.
    runtime.setLenSelectLock("devLenSelect", { locked: false });
    assert.equal(wrap.classList.contains("is-locked"), false);
    assert.equal(button.getAttribute("aria-disabled"), "false");
    assert.equal(button.tabIndex, 0);
    assert.equal(button.valueLabel.textContent, "6");
    button.fire("click");
    assert.equal(wrap.classList.contains("open"), true);
  } finally {
    restore();
  }
});

test("the Data tab locks Development Length to 0 for a vector dataset", () => {
  // The lock follows the resolved data format of the open dataset.
  assert.match(
    persistenceControllerSource,
    /normalizeDatasetModeText\(getDatasetRunDataFormat\(\)\) === "vector"/u,
  );
  assert.match(persistenceControllerSource, /setLenSelectLock\("devLenSelect", \{/u);
  assert.match(persistenceControllerSource, /displayValue: "0"/u);
  // It is reapplied wherever the length controls are repainted, so switching
  // between a Triangle and a Vector Dataset Type cannot strand the old state.
  assert.match(persistenceControllerSource, /updateVectorDevelopmentLengthControl\(\);/u);
  // The stored development length is never rewritten to 0.
  assert.doesNotMatch(persistenceControllerSource, /setLenSelectValue\("devLenSelect", "0"\)/u);
  // The lock is generic to the top-bar length controls: the shared dropdown
  // helpers decide neither which control is locked nor what it then reads.
  assert.doesNotMatch(requestControllerSource, /isLenSelectLocked\("devLenSelect"\)/u);
  assert.doesNotMatch(requestControllerSource, /displayValue: "0"/u);
  assert.match(datasetViewerCss, /\.lenSelectWrap\.is-locked \.lenSelectDisplay \{/u);
});
