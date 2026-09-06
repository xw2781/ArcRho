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
const preferencesControllerSource = await readFile(
  new URL("../ui/shared/tabs/data/data_tab_preferences_controller.js", import.meta.url),
  "utf8",
);
const gridInteractionsSource = await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_interactions.js", import.meta.url),
  "utf8",
);
const runControllerSource = await readFile(
  new URL("../ui/shared/dataset/dataset_run_controller.js", import.meta.url),
  "utf8",
);
const datasetViewerViewSource = await readFile(
  new URL("../ui/dataset_viewer/dataset_viewer_view.js", import.meta.url),
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

  set innerHTML(_value) {
    this.children = [];
    this.options = [];
    this.selectedIndex = -1;
  }

  get innerHTML() { return ""; }

  appendChild(child) {
    this.children.push(child);
    this.options.push(child);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
    return child;
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


// ---------------------------------------------------------------------------
// A display length is only ever a whole multiple of the period the dataset's
// own file is stored at, the window opens at the display shape the sidecar
// saved, and a coarser view is read-only because its cells are a roll-up.

test("a length control offers only whole multiples of the stored period", async () => {
  const { runtime, elements, restore } = await createLengthControlRuntime();
  try {
    assert.deepEqual(runtime.lenChoicesForStoredLength(1), [12, 6, 3, 1]);
    assert.deepEqual(runtime.lenChoicesForStoredLength(3), [12, 6, 3]);
    assert.deepEqual(runtime.lenChoicesForStoredLength(6), [12, 6]);
    assert.deepEqual(runtime.lenChoicesForStoredLength(12), [12]);
    // Not stated yet: before a sidecar has loaded nothing is known, so the
    // whole ladder stays open rather than being narrowed to a guess.
    assert.deepEqual(runtime.lenChoicesForStoredLength(0), [12, 6, 3, 1]);

    const select = elements.originLenSelect;
    runtime.setLenSelectValue("originLenSelect", "6");
    runtime.setLenSelectChoices("originLenSelect", runtime.lenChoicesForStoredLength(3));
    assert.deepEqual(select.options.map((option) => option.value), ["12", "6", "3"]);
    // A length the narrowed list still carries is kept.
    assert.equal(select.value, "6");
    assert.equal(elements.originLenDisplay.valueLabel.textContent, "6");

    // One it no longer carries lands on the stored period itself, which is
    // where the values live.
    runtime.setLenSelectChoices("originLenSelect", runtime.lenChoicesForStoredLength(12));
    assert.deepEqual(select.options.map((option) => option.value), ["12"]);
    assert.equal(select.value, "12");
    assert.equal(elements.originLenDisplay.valueLabel.textContent, "12");

    // Widening again restores the finer lengths without disturbing the value.
    runtime.setLenSelectChoices("originLenSelect", runtime.lenChoicesForStoredLength(1));
    assert.deepEqual(select.options.map((option) => option.value), ["12", "6", "3", "1"]);
    assert.equal(select.value, "12");

    // The dropdown list the user actually sees is repainted from the select,
    // so it can never offer a length the select no longer holds.
    runtime.setLenSelectChoices("originLenSelect", runtime.lenChoicesForStoredLength(6));
    assert.deepEqual(
      elements.originLenDropdown.children.map((option) => option.textContent),
      ["12", "6"],
    );
  } finally {
    restore();
  }
});

test("the offered lengths follow the open dataset's stored period", () => {
  // The stored pair comes from the sidecar, on both the load and the save, and
  // is cleared when there is no sidecar to read it from.
  assert.match(persistenceControllerSource, /function applyStoredLengthsFromResponse\(payload\)/u);
  assert.match(persistenceControllerSource, /runtime\.currentDatasetStoredOriginLength = Number\(source\.stored_origin_length\) \|\| 0;/u);
  assert.match(persistenceControllerSource, /runtime\.currentDatasetStoredDevelopmentLength = Number\(source\.stored_development_length\) \|\| 0;/u);
  assert.match(persistenceControllerSource, /applyStoredLengthsFromResponse\(data\.exists \? data : null\);/u);
  assert.match(persistenceControllerSource, /applyStoredLengthsFromResponse\(resp\.data\);/u);
  // A hand-entered dataset that still holds nothing has no stored period to
  // protect, so the whole ladder stays open until its first real save.
  assert.match(
    persistenceControllerSource,
    /function storedLengthIsPending\(\) \{\s*return currentDatasetIsManualTriangleOrVector\(\) && datasetValuesAreAllZero\(\);/u,
  );
  assert.match(persistenceControllerSource, /applyStoredLengthChoices\(\);/u);
  // Narrowing runs before the saved display shape is written into the control,
  // so the length the window reopens at is never dropped for want of an option.
  assert.match(
    persistenceControllerSource,
    /applyStoredLengthChoices\(\);\s*setLenSelectValue\("originLenSelect", String\(normalized\.origin_length\)\);/u,
  );
});

test("the stored period is shown beside each length control, never as a control", () => {
  assert.match(datasetViewerViewSource, /<span id="originLenStoredNote" class="lenStoredNote" hidden><\/span>/u);
  assert.match(datasetViewerViewSource, /<span id="devLenStoredNote" class="lenStoredNote" hidden><\/span>/u);
  assert.match(datasetViewerCss, /#datasetTopBar \.lenStoredNote \{/u);
  // Static wording once the dataset holds values, and a promise of the shape
  // the first save will fix while it is still empty.
  assert.match(persistenceControllerSource, /`stored \$\{value\}`/u);
  assert.match(persistenceControllerSource, /`will be stored at \$\{value\} on first save`/u);
  // A vector has no development dimension, so it shows no development caption.
  assert.match(persistenceControllerSource, /currentDatasetIsVector\(\) \? 0 : source\.development_length/u);
});

test("a coarser view of a dataset is read-only and says why", () => {
  // A display coarser than the stored period is a roll-up, so it joins the
  // reasons the grid, the Links tab and the patch save refuse an edit.
  assert.match(preferencesControllerSource, /\|\| datasetDisplayIsCoarserThanStored\(\);/u);
  assert.match(
    persistenceControllerSource,
    /Values can be entered only at the stored period \(Origin \$\{stored\.origin_length\}, Development \$\{stored\.development_length\}\)\. Set the lengths back to edit\./u,
  );
  // One place decides the wording, so every refusal names the rule that
  // stopped it rather than blaming a generated dataset.
  assert.match(preferencesControllerSource, /function getDatasetReadOnlyMessage\(\)/u);
  assert.doesNotMatch(gridInteractionsSource, /setStatus\("Generated datasets are read-only\."\)/u);
  assert.match(gridInteractionsSource, /readOnlyMessage = \(\) => "Generated datasets are read-only\.",/u);
  assert.doesNotMatch(runControllerSource, /setStatus\("Generated datasets are read-only\."\)/u);
  // The Links tab already inherits the same rule.
  assert.match(persistenceControllerSource, /isDatasetReadOnly\(\) \|\| isDfmDataTabHost\(\)/u);
});

test("a length change is a display setting the save keeps, not a value edit", () => {
  // Changing a length dirties the settings and Save stays available: the
  // display shape is persisted even though no value may be written at it.
  assert.match(persistenceControllerSource, /left\.origin_length === right\.origin_length/u);
  assert.match(
    persistenceControllerSource,
    /saveBlocked: isTemporaryDatasetView \|\| runtime\.datasetInstanceNameConflict \|\| !hasContext \|\| isDraftGridUnavailable\(\)/u,
  );
  // Going back down to the stored period is always allowed, so an edit is
  // never one save away from being locked out: the floor is the stored pair.
  assert.match(persistenceControllerSource, /function getManualDatasetLengthBaseline\(\) \{\s*const stored = getStoredLengthPair\(\);/u);
});
