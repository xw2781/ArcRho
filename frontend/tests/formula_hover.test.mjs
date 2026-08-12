import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../ui/shared/components/formula_hover/formula_hover.js", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../ui/shared/components/formula_hover/formula_hover.css", import.meta.url),
  "utf8",
);
const formulaHover = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  values() {
    return new Set(String(this.owner.className || "").split(/\s+/u).filter(Boolean));
  }

  write(values) {
    this.owner.className = Array.from(values).join(" ");
  }

  add(...names) {
    const values = this.values();
    names.forEach((name) => values.add(name));
    this.write(values);
  }

  remove(...names) {
    const values = this.values();
    names.forEach((name) => values.delete(name));
    this.write(values);
  }

  contains(name) {
    return this.values().has(name);
  }

  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : !!force;
    if (enabled) values.add(name);
    else values.delete(name);
    this.write(values);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.readOnly = false;
    this.textContent = "";
    this.value = "";
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current === this.ownerDocument.documentElement) return true;
      current = current.parentElement;
    }
    return false;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (this.attributes.has(name)) return this.attributes.get(name);
    if (name === "href" && this.href !== undefined) return String(this.href);
    return null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...properties,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  focus() {
    this.ownerDocument.activeElement = this;
    this.dispatch("focus");
  }

  select() {
    this.selected = true;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  getBoundingClientRect() {
    return this._rect;
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
}

class FakeDocument {
  constructor(windowRef) {
    this.defaultView = windowRef;
    this.listeners = new Map();
    this.activeElement = null;
    this.documentElement = new FakeElement("html", this);
    this.documentElement.clientWidth = windowRef.innerWidth;
    this.documentElement.clientHeight = windowRef.innerHeight;
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  allElements() {
    const elements = [];
    const visit = (element) => {
      elements.push(element);
      element.children.forEach(visit);
    };
    visit(this.documentElement);
    return elements;
  }

  getElementById(id) {
    return this.allElements().find((element) => element.id === id) || null;
  }

  querySelectorAll(selector) {
    if (selector !== 'link[rel="stylesheet"]') return [];
    return this.allElements().filter(
      (element) => element.tagName === "LINK" && element.rel === "stylesheet",
    );
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
}

function byClass(documentRef, className) {
  return documentRef.allElements().find((element) => element.classList.contains(className));
}

function setup(options = {}) {
  const windowListeners = new Map();
  const windowRef = {
    innerWidth: 800,
    innerHeight: 600,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener);
    },
  };
  const documentRef = new FakeDocument(windowRef);
  const anchor = documentRef.createElement("td");
  anchor._rect = { left: 40, top: 100, right: 140, bottom: 128, width: 100, height: 28 };
  documentRef.body.appendChild(anchor);
  const commits = [];
  const dismisses = [];
  const editStarts = [];
  const statuses = [];
  const controller = formulaHover.createFormulaHoverEditor({
    documentRef,
    windowRef,
    hideDelayMs: options.hideDelayMs ?? 5,
    onDismiss: (context) => dismisses.push(context),
    onEditStart: (context) => editStarts.push(context),
    onStatus: (message) => statuses.push(message),
    onCommit: async (request) => {
      commits.push(request);
      return options.commitResult || { ok: true };
    },
  });
  return { anchor, commits, controller, dismisses, documentRef, editStarts, statuses };
}

const LINK_CONTEXT = {
  reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B2",
  anchorDisplayRow: 1,
  anchorDisplayColumn: 2,
};

test("formula hover width cap increases another 30 percent and remains viewport-clamped", () => {
  assert.match(styles, /width:\s*min\(879px,\s*calc\(100vw - 16px\)\)/u);
  assert.match(source, /formula_hover\.css\?v=20260811c/u);
});

test("array formula positioning uses the complete range and never overlaps it", () => {
  const context = setup();
  const rangeRect = { left: 40, top: 10, right: 240, bottom: 120, width: 200, height: 110 };
  context.controller.open(context.anchor, LINK_CONTEXT, { positionRect: rangeRect });
  const root = byClass(context.documentRef, "arFormulaHover");
  root._rect = { left: 0, top: 0, right: 300, bottom: 30, width: 300, height: 30 };
  context.controller.reposition();

  assert.equal(root.dataset.placement, "below");
  assert.equal(root.style.top, "125px");
  assert.ok(Number.parseInt(root.style.top, 10) > rangeRect.bottom);
});

test("moving across one array keeps the canonical anchor and formula-bar position", () => {
  const context = setup();
  const secondCell = context.documentRef.createElement("td");
  secondCell._rect = { left: 140, top: 128, right: 240, bottom: 156, width: 100, height: 28 };
  context.documentRef.body.appendChild(secondCell);
  const rangeRect = { left: 40, top: 100, right: 240, bottom: 156, width: 200, height: 56 };
  const options = {
    resolveAnchor: () => context.anchor,
    positionRect: () => rangeRect,
  };
  context.controller.attach(context.anchor, LINK_CONTEXT, options);
  context.controller.attach(secondCell, LINK_CONTEXT, options);

  context.anchor.dispatch("mouseenter");
  const root = byClass(context.documentRef, "arFormulaHover");
  root._rect = { left: 0, top: 0, right: 300, bottom: 30, width: 300, height: 30 };
  context.controller.reposition();
  const firstPosition = { left: root.style.left, top: root.style.top, placement: root.dataset.placement };

  secondCell.dispatch("mouseenter");
  assert.deepEqual(
    { left: root.style.left, top: root.style.top, placement: root.dataset.placement },
    firstPosition,
  );
});

test("formula hover positioning prefers above the cell and flips below near the viewport top", () => {
  assert.deepEqual(
    formulaHover.calculateFormulaHoverPosition(
      { left: 40, top: 100, bottom: 125 },
      { width: 300, height: 30 },
      { width: 800, height: 600 },
    ),
    { left: 40, top: 65, placement: "above" },
  );
  assert.deepEqual(
    formulaHover.calculateFormulaHoverPosition(
      { left: 40, top: 10, bottom: 35 },
      { width: 300, height: 30 },
      { width: 800, height: 600 },
    ),
    { left: 40, top: 40, placement: "below" },
  );
});

test("linked-cell hover shows the full formula and delays hiding while entering the bar", async () => {
  const context = setup();
  context.controller.attach(context.anchor, LINK_CONTEXT);
  context.anchor.dispatch("mouseenter");

  const root = byClass(context.documentRef, "arFormulaHover");
  const input = byClass(context.documentRef, "arFormulaHoverInput");
  assert.equal(root.classList.contains("is-open"), true);
  assert.equal(root.dataset.placement, "above");
  assert.equal(input.value, LINK_CONTEXT.reference);
  assert.match(context.anchor.getAttribute("aria-description"), /press F2/u);

  context.anchor.dispatch("mouseleave");
  root.dispatch("mouseenter");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(root.classList.contains("is-open"), true);

  root.dispatch("mouseleave");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(root.classList.contains("is-open"), false);
});

test("Enter commits the edited formula and Escape cancels without a commit", async () => {
  const context = setup();
  context.controller.open(context.anchor, LINK_CONTEXT, { focus: true });
  const root = byClass(context.documentRef, "arFormulaHover");
  const input = byClass(context.documentRef, "arFormulaHoverInput");
  assert.equal(context.documentRef.activeElement, input);
  assert.equal(input.selected, true);
  assert.deepEqual(context.editStarts, [{ ...LINK_CONTEXT, formula: LINK_CONTEXT.reference }]);

  const nextFormula = "='C:\\Data\\[Book.xlsx]Sheet 1'!C3:D4";
  input.value = nextFormula;
  let prevented = false;
  input.dispatch("keydown", {
    key: "Enter",
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.deepEqual(context.commits, [{ formula: nextFormula, context: { ...LINK_CONTEXT, formula: LINK_CONTEXT.reference } }]);
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.equal(root.classList.contains("is-open"), false);

  context.controller.open(context.anchor, LINK_CONTEXT, { focus: true });
  input.value = "changed but canceled";
  input.dispatch("keydown", { key: "Escape" });
  assert.equal(input.value, LINK_CONTEXT.reference);
  assert.equal(root.classList.contains("is-open"), false);
  assert.equal(context.commits.length, 1);
  assert.equal(context.dismisses.length, 2);
});

test("failed formula commits retain the editor with an accessible error", async () => {
  const context = setup({ commitResult: { ok: false, error: "Workbook unavailable." } });
  context.controller.open(context.anchor, LINK_CONTEXT, { focus: true });
  const root = byClass(context.documentRef, "arFormulaHover");
  const input = byClass(context.documentRef, "arFormulaHoverInput");
  input.value = "='C:\\Missing\\[Book.xlsx]Sheet 1'!A1";

  assert.equal(await context.controller.commit(), false);
  assert.equal(root.classList.contains("is-open"), true);
  assert.equal(root.classList.contains("has-error"), true);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(byClass(context.documentRef, "arFormulaHoverError").textContent, "Workbook unavailable.");
  assert.equal(context.documentRef.activeElement, input);
  assert.equal(context.statuses.at(-1), "Workbook unavailable.");
});
