import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontendRoot = new URL("../", import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, frontendRoot), "utf8");

const componentUrl = new URL("ui/shared/components/pickers/number_format_field.js", frontendRoot);
const presetsUrl = new URL("ui/shared/dataset/dataset_number_format.js", frontendRoot);
const componentSource = await read("ui/shared/components/pickers/number_format_field.js");

// The component resolves its presets through the app server's absolute `/ui`
// route, which node cannot serve.
const { wireNumberFormatField } = await import(
  `data:text/javascript;base64,${Buffer.from(
    componentSource.replace(
      /"\/ui\/shared\/dataset\/dataset_number_format\.js"/u,
      JSON.stringify(presetsUrl.href),
    ),
  ).toString("base64")}`
);

function fakeElement(tag = "div") {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    tag,
    value: "",
    innerHTML: "",
    dataset: {},
    children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    appendChild: (child) => {
      element.children.push(child);
      return child;
    },
    contains: (node) => node === element || element.children.includes(node),
    focus: () => { element.focused = true; },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler({ preventDefault() {}, stopPropagation() {}, ...event });
    },
    hasListener: (type) => (listeners.get(type) || []).length > 0,
  };
  return element;
}

function fakeDocument() {
  const listeners = new Map();
  return {
    createElement: () => fakeElement(),
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
}

function mount({ presets = ["0,000", "0.0%"] } = {}) {
  const input = fakeElement("input");
  const field = fakeElement();
  const toggle = fakeElement("button");
  const menu = fakeElement();
  field.children.push(input, toggle, menu);
  const applied = [];
  const documentRef = fakeDocument();
  const api = wireNumberFormatField({
    input,
    field,
    toggle,
    menu,
    getPresets: () => presets,
    onApply: (preset) => applied.push(preset),
    documentRef,
  });
  return { api, input, field, toggle, menu, applied, documentRef };
}

test("the caret renders the presets and marks the active one", () => {
  const { api, input, field, menu } = mount();
  input.value = "0.0%";

  api.open();

  assert.equal(api.isOpen(), true);
  assert.equal(menu.children.length, 2);
  assert.deepEqual(menu.children.map((option) => option.dataset.value), ["0,000", "0.0%"]);
  assert.equal(menu.children[1].classList.contains("active"), true);
  assert.equal(menu.children[0].classList.contains("active"), false);
  assert.equal(field.classList.contains("open"), true);
  assert.equal(input.getAttribute("aria-expanded"), "true");
});

test("the toggle opens and closes, and keeps focus in the field", () => {
  const { api, input, toggle, menu } = mount();

  toggle.dispatch("click");
  assert.equal(api.isOpen(), true);
  assert.equal(input.focused, true);

  toggle.dispatch("click");
  assert.equal(api.isOpen(), false);
  assert.equal(menu.classList.contains("open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("choosing a preset closes the menu and hands the value to the host", () => {
  const { api, menu, applied } = mount();
  api.open();
  const option = menu.children[1];

  menu.dispatch("click", { target: { closest: (selector) => (selector === ".arNumberFormatOption" ? option : null) } });

  assert.deepEqual(applied, ["0.0%"]);
  assert.equal(api.isOpen(), false);
});

test("an outside pointer press or Escape dismisses the menu", () => {
  const outside = mount();
  outside.api.open();
  outside.documentRef.dispatch("mousedown", { target: fakeElement() });
  assert.equal(outside.api.isOpen(), false);

  const escaped = mount();
  escaped.api.open();
  escaped.documentRef.dispatch("keydown", { key: "Escape" });
  assert.equal(escaped.api.isOpen(), false);

  const inside = mount();
  inside.api.open();
  inside.documentRef.dispatch("mousedown", { target: inside.toggle });
  assert.equal(inside.api.isOpen(), true);
});

test("the menu suppresses mousedown so a host blur commit cannot race the choice", () => {
  const { menu } = mount();
  assert.equal(menu.hasListener("mousedown"), true);
});

test("the Dataset Viewer and Berquist Sherman drive one Number Format component", async () => {
  const [datasetView, dataControls, bsHtml, bsMain, sharedCss, datasetCss] = await Promise.all([
    read("ui/dataset_viewer/dataset_viewer_view.js"),
    read("ui/shared/tabs/data/data_tab_controls.js"),
    read("ui/method_pages/berquist_sherman/berquist_sherman.html"),
    read("ui/method_pages/berquist_sherman/berquist_sherman_main.js"),
    read("ui/shared/components/pickers/number_format_field.css"),
    read("ui/dataset_viewer/dataset_viewer.css"),
  ]);

  for (const markup of [datasetView, bsHtml]) {
    assert.match(markup, /class="arNumberFormatField"|class="arNumberFormatField" id=/u);
    assert.match(markup, /arNumberFormatToggle/u);
    assert.match(markup, /arNumberFormatCaret/u);
    assert.match(markup, /datasetDropdown arNumberFormatMenu/u);
  }
  for (const runtime of [dataControls, bsMain]) {
    assert.match(runtime, /wireNumberFormatField/u);
    assert.match(runtime, /pickers\/number_format_field\.js/u);
  }

  // The shared sheet owns the look; the Dataset Viewer keeps only the top-bar
  // footprint, so the control cannot drift between the two pages.
  assert.match(sharedCss, /\.arNumberFormatToggle \{/u);
  assert.match(sharedCss, /\.arNumberFormatField\.open \.arNumberFormatCaret \{/u);
  assert.doesNotMatch(datasetCss, /\.arNumberFormatToggle \{/u);
  assert.doesNotMatch(datasetCss, /numberFormatDropdownBtn/u);
});
