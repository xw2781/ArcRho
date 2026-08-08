import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL("../ui/shared/tabs/links/links_tab.js", import.meta.url);
const componentSource = await readFile(componentUrl, "utf8");
const stylesheetUrl = new URL("../ui/shared/tabs/links/links_tab.css", import.meta.url);
const stylesheetSource = await readFile(stylesheetUrl, "utf8");
const spreadsheetStylesheetSource = await readFile(
  new URL("../ui/shared/components/spreadsheet/spreadsheet_table.css", import.meta.url),
  "utf8",
);
const tooltipStubSource = `
  export function attachArcrhoTooltip(target, text) {
    if (target && text) target.setAttribute("aria-description", String(text));
  }
`;
const tooltipStubUrl = `data:text/javascript;base64,${Buffer.from(tooltipStubSource).toString("base64")}`;
// The real positioner needs a layout engine; record the placement request instead.
const contextMenuStubSource = `
  export const openedMenus = [];
  export function openContextMenu(menu, opts = {}) {
    if (!menu) return;
    menu.style.display = "block";
    openedMenus.push({ menu, opts });
  }
`;
const contextMenuStubUrl = `data:text/javascript;base64,${Buffer.from(contextMenuStubSource).toString("base64")}`;
const testableComponentSource = componentSource
  .replace(
    '"/ui/shared/components/tooltip/tooltip.js?v=20260715a"',
    JSON.stringify(tooltipStubUrl),
  )
  .replace(
    '"/ui/shared/components/context_menu/context_menu.js"',
    JSON.stringify(contextMenuStubUrl),
  );
const linksTab = await import(
  `data:text/javascript;base64,${Buffer.from(testableComponentSource).toString("base64")}`
);

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  tokens() {
    return new Set(String(this.owner.className || "").split(/\s+/u).filter(Boolean));
  }

  write(tokens) {
    this.owner.className = Array.from(tokens).join(" ");
  }

  add(...names) {
    const tokens = this.tokens();
    names.forEach((name) => tokens.add(name));
    this.write(tokens);
  }

  remove(...names) {
    const tokens = this.tokens();
    names.forEach((name) => tokens.delete(name));
    this.write(tokens);
  }

  contains(name) {
    return this.tokens().has(name);
  }

  toggle(name, force) {
    const tokens = this.tokens();
    const enabled = force === undefined ? !tokens.has(name) : Boolean(force);
    if (enabled) tokens.add(name);
    else tokens.delete(name);
    this.write(tokens);
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
    this.style = {};
    this.dataset = {};
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.tabIndex = -1;
    this.offsetWidth = 0;
    this.clientWidth = 0;
    this.offsetHeight = 0;
    this.clientHeight = 0;
    this.scrollWidth = 0;
    this.scrollHeight = 0;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }

  getAttribute(name) {
    if (this.attributes.has(name)) return this.attributes.get(name);
    if (name === "href" && this.href !== undefined) return String(this.href);
    return null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (enabled) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return enabled;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect() {
    return { right: 0, bottom: 0 };
  }

  async dispatch(type, eventInit = {}) {
    const event = {
      type,
      currentTarget: this,
      target: this,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      ...eventInit,
    };
    const results = Array.from(this.listeners.get(type) || []).map((listener) => listener(event));
    await Promise.all(results);
  }

  async click(eventInit = {}) {
    if (this.disabled) return;
    await this.dispatch("click", eventInit);
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }
}

class FakeDocument {
  constructor() {
    this.defaultView = globalThis;
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName);
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
}

function descendants(root) {
  const elements = [];
  const visit = (element) => {
    elements.push(element);
    element.children.forEach(visit);
  };
  visit(root);
  return elements;
}

function byTag(root, tagName) {
  const normalized = String(tagName).toUpperCase();
  return descendants(root).filter((element) => element.tagName === normalized);
}

function byClass(root, className) {
  return descendants(root).filter((element) => element.classList.contains(className));
}

function renderedText(element) {
  return [element.textContent, ...element.children.map(renderedText)].join("");
}

function menuOf(documentRef) {
  return byClass(documentRef.body, "arExternalLinksMenu")[0];
}

function menuItem(documentRef, action) {
  return descendants(menuOf(documentRef)).find((element) => element.dataset?.action === action);
}

function isMenuOpen(documentRef) {
  return menuOf(documentRef).style.display === "block";
}

function visibleMenuLabels(documentRef) {
  return descendants(menuOf(documentRef))
    .filter((element) => element.classList.contains("ctx-item") && !element.hidden)
    .map(renderedText);
}

/** Right-clicks the scroll host below the rows, which never changes the selection. */
async function openHostMenu(documentRef, container) {
  const scrollHost = byClass(container.children[0], "arExternalLinksScroll")[0];
  await scrollHost.dispatch("contextmenu", { clientX: 40, clientY: 60 });
  return scrollHost;
}

async function runMenuAction(documentRef, container, action) {
  await openHostMenu(documentRef, container);
  await menuItem(documentRef, action).click();
}

function setup(options = {}) {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement("div");
  documentRef.body.appendChild(container);
  const controller = linksTab.createExternalLinksTab({
    container,
    documentRef,
    ariaLabel: "Dataset external links",
    emptyDescription: "No workbook cells are linked.",
    getLinks: options.getLinks || (() => []),
    onRefreshLinks: options.onRefreshLinks || (() => ({ ok: true })),
    onBreakLinks: options.onBreakLinks || (() => ({ ok: true })),
    onStatus: options.onStatus,
  });
  return { documentRef, container, controller };
}

const sampleLink = {
  id: "link-1",
  workbookPath: "C:\\Claims\\Quarterly Book.xlsx",
  worksheet: "Paid Loss",
  address: "A1:C2",
  destination: "2024 / 12m",
  value: "125.4 ...",
  affectedCellCount: 6,
};

const sampleLinks = [
  sampleLink,
  { ...sampleLink, id: "link-2", address: "D4", destination: "2025 / 12m", value: "90" },
  { ...sampleLink, id: "link-3", address: "E5", destination: "2026 / 12m", value: "80" },
  { ...sampleLink, id: "link-4", address: "F6", destination: "2027 / 12m", value: "70" },
];

test("renders no toolbar and offers the bulk actions through the table context menu", async () => {
  const { documentRef, container, controller } = setup({ getLinks: () => [sampleLink] });

  assert.equal(await controller.refresh(), true);
  assert.equal(documentRef.querySelectorAll('link[rel="stylesheet"]').length, 1);
  assert.equal(container.classList.contains("arExternalLinksMount"), true);

  const root = container.children[0];
  assert.equal(byClass(root, "arExternalLinksToolbar").length, 0);
  assert.equal(byTag(root, "button").length, 0);

  const menu = menuOf(documentRef);
  assert.equal(menu.parentElement, documentRef.body);
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(isMenuOpen(documentRef), false);
  assert.deepEqual(
    byTag(menu, "button").map(renderedText),
    ["Refresh selected", "Break selected", "Refresh all", "Break all"],
  );

  // Nothing selected: only the all-scope entries, and no separator above them.
  await openHostMenu(documentRef, container);
  assert.equal(isMenuOpen(documentRef), true);
  assert.deepEqual(visibleMenuLabels(documentRef), ["Refresh all", "Break all"]);
  assert.equal(byClass(menu, "ctx-sep")[0].hidden, true);

  const table = byTag(root, "table")[0];
  assert.deepEqual(
    byTag(table, "th").map((header) => header.textContent),
    ["Workbook", "Worksheet", "Cell Address", "Destination", "Values"],
  );
  assert.equal(table.getAttribute("role"), "grid");
  assert.equal(table.getAttribute("aria-multiselectable"), "true");
  assert.equal(table.getAttribute("aria-label"), "Dataset external links");

  const row = byTag(table, "tbody")[0].children[0];
  const cells = row.children;
  assert.equal(row.getAttribute("aria-selected"), "false");
  assert.equal(cells[0].textContent, sampleLink.workbookPath);
  assert.equal(cells[0].getAttribute("aria-description"), sampleLink.workbookPath);
  assert.equal(cells[1].textContent, sampleLink.worksheet);
  assert.equal(cells[2].textContent, sampleLink.address);
  assert.match(renderedText(cells[3]), /2024 \/ 12m/u);
  assert.match(renderedText(cells[3]), /6 cells/u);
  assert.equal(cells[4].textContent, "125.4 ...");
  assert.equal(byClass(root, "arExternalLinksState")[0].hidden, true);
});

test("plain, Ctrl, Meta, and Shift clicks provide accessible multi-row selection", async () => {
  let refreshedRecords = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => sampleLinks,
    onRefreshLinks: (records) => {
      refreshedRecords = records;
      return { ok: true };
    },
  });
  await controller.refresh();

  const root = container.children[0];
  const rows = byTag(root, "tbody")[0].children;

  await rows[0].click();
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-selected")), ["true", "false", "false", "false"]);
  await openHostMenu(documentRef, container);
  assert.deepEqual(
    visibleMenuLabels(documentRef),
    ["Refresh selected", "Break selected", "Refresh all", "Break all"],
  );
  assert.equal(byClass(menuOf(documentRef), "ctx-sep")[0].hidden, false);

  await rows[2].click({ ctrlKey: true });
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-selected")), ["true", "false", "true", "false"]);

  await rows[3].click({ shiftKey: true });
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-selected")), ["false", "false", "true", "true"]);

  await rows[1].click({ metaKey: true });
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-selected")), ["false", "true", "true", "true"]);
  await runMenuAction(documentRef, container, "refresh-selected");
  assert.deepEqual(refreshedRecords.map((record) => record.id), ["link-2", "link-3", "link-4"]);
});

test("the all-scope entries stay available and ignore the current selection", async () => {
  let refreshedRecords = [];
  let brokenRecords = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => sampleLinks,
    onRefreshLinks: (links) => {
      refreshedRecords = links;
      return { ok: true };
    },
    onBreakLinks: (links) => {
      brokenRecords = links;
      return { ok: true };
    },
  });
  await controller.refresh();

  const rows = byTag(container.children[0], "tbody")[0].children;
  await rows[1].click();

  await runMenuAction(documentRef, container, "refresh-all");
  assert.deepEqual(refreshedRecords.map((record) => record.id), sampleLinks.map((record) => record.id));

  await runMenuAction(documentRef, container, "break-all");
  assert.deepEqual(brokenRecords.map((record) => record.id), sampleLinks.map((record) => record.id));

  // The selection survives an all-scope action.
  const rerenderedRows = byTag(container.children[0], "tbody")[0].children;
  assert.deepEqual(
    rerenderedRows.map((row) => row.getAttribute("aria-selected")),
    ["false", "true", "false", "false"],
  );
});

test("right-clicking a row keeps an existing selection but claims an unselected row", async () => {
  let refreshedRecords = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => sampleLinks,
    onRefreshLinks: (records) => {
      refreshedRecords = records;
      return { ok: true };
    },
  });
  await controller.refresh();

  const rows = byTag(container.children[0], "tbody")[0].children;
  await rows[0].click();
  await rows[1].click({ ctrlKey: true });

  // Inside the selection: the selection survives and the action stays scoped to it.
  await rows[1].dispatch("contextmenu", { clientX: 12, clientY: 24 });
  assert.equal(isMenuOpen(documentRef), true);
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-selected")), ["true", "true", "false", "false"]);
  assert.equal(menuItem(documentRef, "break-selected").hidden, false);
  await menuItem(documentRef, "refresh-selected").click();
  assert.deepEqual(refreshedRecords.map((record) => record.id), ["link-1", "link-2"]);
  assert.equal(isMenuOpen(documentRef), false);

  // Outside the selection: the target row becomes the whole selection first.
  const refreshedRows = byTag(container.children[0], "tbody")[0].children;
  await refreshedRows[3].dispatch("contextmenu", { clientX: 12, clientY: 24 });
  assert.deepEqual(
    refreshedRows.map((row) => row.getAttribute("aria-selected")),
    ["false", "false", "false", "true"],
  );
  await menuItem(documentRef, "refresh-selected").click();
  assert.deepEqual(refreshedRecords.map((record) => record.id), ["link-4"]);
});

test("selection is retained by link id and pruned when records disappear", async () => {
  let records = sampleLinks;
  const { documentRef, container, controller } = setup({ getLinks: () => records });
  await controller.refresh();
  let rows = byTag(container.children[0], "tbody")[0].children;
  await rows[0].click();
  await rows[2].click({ ctrlKey: true });

  records = [sampleLinks[0], sampleLinks[1]];
  await controller.refresh();

  rows = byTag(container.children[0], "tbody")[0].children;
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-selected")), ["true", "false"]);
  await openHostMenu(documentRef, container);
  assert.equal(menuItem(documentRef, "refresh-selected").hidden, false);

  records = [sampleLinks[1]];
  await controller.refresh();
  rows = byTag(container.children[0], "tbody")[0].children;
  assert.equal(rows[0].getAttribute("aria-selected"), "false");
  await openHostMenu(documentRef, container);
  assert.deepEqual(visibleMenuLabels(documentRef), ["Refresh all", "Break all"]);
});

test("Refresh all uses the bulk callback, exposes busy state, and reports success", async () => {
  let resolveRefresh;
  let refreshCount = 0;
  let received = [];
  const statuses = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => {
      refreshCount += 1;
      return sampleLinks;
    },
    onRefreshLinks: (records) => {
      received = records;
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
    onStatus: (message, tone) => statuses.push({ message, tone }),
  });
  await controller.refresh();

  const root = container.children[0];
  await openHostMenu(documentRef, container);
  const pendingClick = menuItem(documentRef, "refresh-all").click();
  assert.equal(isMenuOpen(documentRef), false);
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.match(renderedText(byClass(root, "arExternalLinksState")[0]), /Refreshing external links/u);
  assert.deepEqual(received.map((record) => record.id), sampleLinks.map((record) => record.id));

  // A right-click while an action runs must not reopen the menu.
  await openHostMenu(documentRef, container);
  assert.equal(isMenuOpen(documentRef), false);

  resolveRefresh({ ok: true, message: "Workbook values refreshed." });
  await pendingClick;

  assert.equal(refreshCount, 2);
  assert.equal(root.getAttribute("aria-busy"), "false");
  await openHostMenu(documentRef, container);
  assert.equal(isMenuOpen(documentRef), true);
  assert.deepEqual(visibleMenuLabels(documentRef), ["Refresh all", "Break all"]);
  assert.deepEqual(statuses.at(-1), { message: "Workbook values refreshed.", tone: "success" });
});

test("Break all excludes read-only records and hides the break action when none remain", async () => {
  const readOnlyLink = { ...sampleLinks[3], readOnly: true };
  let records = [...sampleLinks.slice(0, 2), readOnlyLink];
  let received = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => records,
    onBreakLinks: (links) => {
      received = links;
      records = [readOnlyLink];
      return { ok: true, message: "Link values are now hard-coded." };
    },
  });
  await controller.refresh();

  const root = container.children[0];
  await runMenuAction(documentRef, container, "break-all");

  assert.deepEqual(received.map((record) => record.id), ["link-1", "link-2"]);
  assert.equal(byTag(root, "tbody")[0].children.length, 1);

  await openHostMenu(documentRef, container);
  assert.equal(isMenuOpen(documentRef), true);
  assert.deepEqual(visibleMenuLabels(documentRef), ["Refresh all"]);
});

test("failed bulk actions retain rows, selection, and restored controls", async () => {
  let resolveBreak;
  const statuses = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => sampleLinks,
    onBreakLinks: () => new Promise((resolve) => {
      resolveBreak = resolve;
    }),
    onStatus: (message, tone) => statuses.push({ message, tone }),
  });
  await controller.refresh();

  const root = container.children[0];
  const rows = byTag(root, "tbody")[0].children;
  await rows[1].click();
  await openHostMenu(documentRef, container);
  const pendingClick = menuItem(documentRef, "break-selected").click();
  assert.equal(isMenuOpen(documentRef), false);
  assert.match(renderedText(byClass(root, "arExternalLinksState")[0]), /Breaking external links/u);

  resolveBreak({ ok: false, error: "Workbook is locked." });
  await pendingClick;

  assert.equal(byTag(root, "tbody")[0].children.length, 4);
  assert.equal(rows[1].getAttribute("aria-selected"), "true");
  assert.equal(root.getAttribute("aria-busy"), "false");
  await openHostMenu(documentRef, container);
  assert.equal(menuItem(documentRef, "break-selected").hidden, false);
  const state = byClass(root, "arExternalLinksState")[0];
  assert.equal(state.hidden, false);
  assert.equal(state.getAttribute("role"), "alert");
  assert.equal(state.classList.contains("hasRows"), true);
  assert.match(renderedText(state), /Workbook is locked\./u);
  assert.deepEqual(statuses.at(-1), { message: "Workbook is locked.", tone: "error" });
});

test("partial refresh failures are reported instead of shown as success", async () => {
  const statuses = [];
  const { documentRef, container, controller } = setup({
    getLinks: () => [sampleLink],
    onRefreshLinks: () => ({ linkedCellCount: 2, failedCount: 2 }),
    onStatus: (message, tone) => statuses.push({ message, tone }),
  });
  await controller.refresh();

  const root = container.children[0];
  await runMenuAction(documentRef, container, "refresh-all");

  assert.match(renderedText(byClass(root, "arExternalLinksState")[0]), /2 linked values could not be refreshed/u);
  assert.deepEqual(statuses.at(-1), {
    message: "2 linked values could not be refreshed.",
    tone: "error",
  });
});

test("explicit loading and error states retain rendered rows and destroy cleanly", async () => {
  const { documentRef, container, controller } = setup({ getLinks: () => [sampleLink] });
  await controller.refresh();
  const root = container.children[0];
  const body = byTag(root, "tbody")[0];
  const menu = menuOf(documentRef);

  controller.setLoading("Refreshing workbook values...");
  assert.equal(root.getAttribute("aria-busy"), "true");
  await openHostMenu(documentRef, container);
  assert.equal(isMenuOpen(documentRef), false);
  assert.equal(body.children.length, 1);
  assert.match(renderedText(byClass(root, "arExternalLinksState")[0]), /Refreshing workbook values/u);

  controller.setError("Excel is unavailable.");
  assert.equal(root.getAttribute("aria-busy"), "false");
  await openHostMenu(documentRef, container);
  assert.equal(isMenuOpen(documentRef), true);
  assert.equal(body.children.length, 1);
  assert.match(renderedText(byClass(root, "arExternalLinksState")[0]), /Excel is unavailable\./u);

  controller.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(container.classList.contains("arExternalLinksMount"), false);
  assert.equal(menu.parentElement, null);
  assert.equal(menu.style.display, "none");
  assert.equal(await controller.refresh(), false);
});

test("persistent warnings survive link refreshes until explicitly cleared", async () => {
  const { container, controller } = setup({ getLinks: () => [sampleLink] });
  await controller.refresh();
  const root = container.children[0];
  const state = byClass(root, "arExternalLinksState")[0];

  controller.setWarning(
    "Saved Excel values may be out of date",
    "2 stale linked values. Stored values remain active.",
  );
  assert.equal(state.classList.contains("isWarning"), true);
  assert.match(renderedText(state), /2 stale linked values/u);

  await controller.refresh();
  assert.equal(state.classList.contains("isWarning"), true);
  assert.match(renderedText(state), /Saved Excel values may be out of date/u);

  controller.clearWarning();
  assert.equal(state.hidden, true);
});

test("shared styling drops the toolbar, keeps every row border, and separates link text from array outlines", () => {
  assert.doesNotMatch(stylesheetSource, /arExternalLinksToolbar/u);
  // The last row must keep its bottom rule so the table does not look unfinished
  // when the rows are shorter than the framed scroll host.
  assert.doesNotMatch(stylesheetSource, /tbody tr:last-child td\s*\{[^}]*border-bottom:\s*0;/su);
  const cellRule = stylesheetSource.match(
    /\.arExternalLinksTable th,\s*\.arExternalLinksTable td\s*\{([^}]*)\}/u,
  )?.[1] || "";
  assert.match(cellRule, /border-bottom:\s*1px solid #e2e8f0;/u);
  assert.match(stylesheetSource, /border-collapse:\s*separate;/u);
  assert.match(stylesheetSource, /position:\s*sticky;/u);
  assert.match(stylesheetSource, /height:\s*31px;/u);
  assert.match(stylesheetSource, /tbody tr\[aria-selected="true"\]/u);
  const linkedCellRule = stylesheetSource.match(/td\.arExternalLinkCell\s*\{([^}]*)\}/u)?.[1] || "";
  assert.match(linkedCellRule, /color:\s*#166534;/u);
  assert.match(linkedCellRule, /font-weight:\s*700;/u);
  assert.doesNotMatch(linkedCellRule, /box-shadow|background|border|position/u);
  assert.doesNotMatch(stylesheetSource, /td\.arExternalLinkAnchor::after/u);
  const arrayRule = spreadsheetStylesheetSource.match(
    /\.arSpreadsheetTable td\.arArrayFormulaCell\s*\{([^}]*)\}/u,
  )?.[1] || "";
  assert.match(arrayRule, /box-shadow:/u);
  assert.match(arrayRule, /transition:\s*box-shadow 150ms ease;/u);
  for (const edge of ["Top", "Right", "Bottom", "Left"]) {
    assert.match(
      spreadsheetStylesheetSource,
      new RegExp(`td\\.arArrayFormulaEdge${edge}\\s*\\{`, "u"),
    );
  }
  assert.match(spreadsheetStylesheetSource, /#2b6df6/u);
  assert.match(spreadsheetStylesheetSource, /rgba\(43, 109, 246, 0\.28\)/u);
  assert.match(stylesheetSource, /\.arExternalLinksState\.isWarning/u);
  assert.match(stylesheetSource, /color:\s*#b45309;/u);
});
