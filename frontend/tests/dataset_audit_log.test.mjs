import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewUrl = new URL("../ui/shared/tabs/audit_log/audit_log_view.js", import.meta.url);
const viewSource = await readFile(viewUrl, "utf8");
const sidecarAdapterUrl = new URL(
  "../ui/shared/tabs/audit_log/sidecar_audit_entries.js",
  import.meta.url,
);
const sidecarAdapterSource = await readFile(sidecarAdapterUrl, "utf8");
const stylesheetUrl = new URL("../ui/shared/tabs/audit_log/audit_log.css", import.meta.url);
const stylesheetSource = await readFile(stylesheetUrl, "utf8");
const auditLogView = await import(
  `data:text/javascript;base64,${Buffer.from(viewSource).toString("base64")}`
);
const sidecarAuditEntries = await import(
  `data:text/javascript;base64,${Buffer.from(sidecarAdapterSource).toString("base64")}`
);

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  getTokens() {
    return new Set(String(this.owner.className || "").split(/\s+/u).filter(Boolean));
  }

  write(tokens) {
    this.owner.className = Array.from(tokens).join(" ");
  }

  add(...names) {
    const tokens = this.getTokens();
    names.forEach((name) => tokens.add(name));
    this.write(tokens);
  }

  remove(...names) {
    const tokens = this.getTokens();
    names.forEach((name) => tokens.delete(name));
    this.write(tokens);
  }

  toggle(name, force) {
    const tokens = this.getTokens();
    const shouldAdd = force === undefined ? !tokens.has(name) : Boolean(force);
    if (shouldAdd) tokens.add(name);
    else tokens.delete(name);
    this.write(tokens);
    return shouldAdd;
  }

  contains(name) {
    return this.getTokens().has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
    this.hidden = false;
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
  }

  getAttribute(name) {
    if (this.attributes.has(name)) return this.attributes.get(name);
    return this[name] === undefined ? null : String(this[name]);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  getBoundingClientRect() {
    return { right: 0, bottom: 0 };
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
    this.documentElement = new FakeElement("html");
    this.head = new FakeElement("head");
    this.documentElement.appendChild(this.head);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
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

test("normalizes canonical and title-case dataset audit entries", () => {
  const entries = sidecarAuditEntries.normalizeSidecarAuditEntries([
    {
      event_date: " 2026-07-14T09:15:30 ",
      action: " Saved ",
      change_info: " Updated values ",
      user: " analyst ",
    },
    {
      "Event Date": "2026-07-14T10:00:00",
      Action: "Created",
      "Change Info": "Initial save",
      User: "owner",
    },
    null,
    {},
  ]);

  assert.deepEqual(entries, [
    {
      eventDate: "2026-07-14T09:15:30",
      action: "Saved",
      changeInfo: "Updated values",
      user: "analyst",
    },
    {
      eventDate: "2026-07-14T10:00:00",
      action: "Created",
      changeInfo: "Initial save",
      user: "owner",
    },
  ]);
});

test("does not normalize the separate project audit-log schema", () => {
  assert.deepEqual(
    sidecarAuditEntries.normalizeSidecarAuditEntries([
      {
        timestamp: "2026-07-14T09:15:30",
        action: "Saved",
        details: "Project setting changed",
        user: "analyst",
      },
    ]),
    [],
  );
});

test("keeps only the latest 50 normalized entries in source order", () => {
  const source = Array.from({ length: 55 }, (_, index) => ({
    event_date: `event-${index}`,
    action: `action-${index}`,
  }));
  const entries = sidecarAuditEntries.normalizeSidecarAuditEntries(source);

  assert.equal(entries.length, 50);
  assert.equal(entries[0].eventDate, "event-5");
  assert.equal(entries.at(-1).eventDate, "event-54");
});

test("formats valid dates in the existing DSV local 12-hour style", () => {
  assert.equal(
    sidecarAuditEntries.formatSidecarAuditEventDate("2026-07-14T00:05:09"),
    "7/14/2026 12:05:09 AM",
  );
  assert.equal(
    sidecarAuditEntries.formatSidecarAuditEventDate("2026-07-14T13:05:09"),
    "7/14/2026 1:05:09 PM",
  );
});

test("preserves invalid date text and clears blank values", () => {
  assert.equal(sidecarAuditEntries.formatSidecarAuditEventDate(" not-a-date "), "not-a-date");
  assert.equal(sidecarAuditEntries.formatSidecarAuditEventDate("  "), "");
  assert.equal(sidecarAuditEntries.formatSidecarAuditEventDate(null), "");
});

test("generic audit view renders newest first and destroys its lifecycle cleanly", () => {
  const documentRef = new FakeDocument();
  const container = documentRef.createElement("div");
  documentRef.documentElement.appendChild(container);
  const view = auditLogView.createAuditLogView({
    container,
    documentRef,
    normalizeEntries: sidecarAuditEntries.normalizeSidecarAuditEntries,
    formatEventDate: sidecarAuditEntries.formatSidecarAuditEventDate,
  });

  assert.equal(documentRef.querySelectorAll('link[rel="stylesheet"]').length, 1);
  assert.equal(container.classList.contains("arAuditLogMount"), true);
  assert.equal(view.elements.scrollHost.listenerCount("scroll"), 1);
  assert.equal(view.elements.scrollHost.listenerCount("pointermove"), 1);
  assert.equal(view.elements.scrollHost.listenerCount("pointerleave"), 1);

  view.setLoading();
  assert.equal(view.elements.root.getAttribute("aria-busy"), "true");
  assert.equal(view.elements.state.classList.contains("isLoading"), true);

  view.setError("Sidecar unavailable.");
  assert.equal(view.elements.state.getAttribute("role"), "alert");
  assert.equal(view.elements.stateDescription.textContent, "Sidecar unavailable.");

  view.render([
    { event_date: "older", action: "Older action" },
    { event_date: "newer", action: "Newest action" },
  ]);
  assert.equal(view.elements.body.children.length, 2);
  assert.equal(view.elements.body.children[0].children[0].textContent, "newer");
  assert.equal(view.elements.body.children[0].children[1].textContent, "Newest action");
  assert.equal(view.elements.state.hidden, true);

  view.clear();
  assert.equal(view.elements.body.children.length, 0);
  assert.equal(view.elements.state.classList.contains("isEmpty"), true);

  view.destroy();
  assert.equal(view.elements.root.parentElement, null);
  assert.equal(container.classList.contains("arAuditLogMount"), false);
  assert.equal(view.elements.scrollHost.listenerCount("scroll"), 0);
  assert.equal(view.elements.scrollHost.listenerCount("pointermove"), 0);
  assert.equal(view.elements.scrollHost.listenerCount("pointerleave"), 0);
});

test("does not reserve a vertical scrollbar gutter when scrolling is unnecessary", () => {
  assert.match(stylesheetSource, /scrollbar-gutter:\s*auto;/u);
  assert.doesNotMatch(stylesheetSource, /scrollbar-gutter:\s*stable;/u);
});
