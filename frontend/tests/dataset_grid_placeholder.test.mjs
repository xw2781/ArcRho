import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const stateSource = await readFile(
  new URL("../ui/shared/dataset/dataset_state.js", import.meta.url),
  "utf8",
);
const stateModuleUrl = dataUrl(stateSource);
const originLabelsSource = await readFile(
  new URL("../ui/shared/dataset/dataset_origin_labels.js", import.meta.url),
  "utf8",
);
const originLabelsModuleUrl = dataUrl(originLabelsSource);
const placeholderSource = (await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_placeholder.js", import.meta.url),
  "utf8",
))
  .replace('"/ui/shared/dataset/dataset_state.js"', JSON.stringify(stateModuleUrl))
  .replace(
    /"\/ui\/shared\/dataset\/dataset_origin_labels\.js"/,
    JSON.stringify(originLabelsModuleUrl),
  );

const { state } = await import(stateModuleUrl);
const placeholder = await import(dataUrl(placeholderSource));

// Minimal element/document stubs: the module only needs element creation,
// parent/child links, class and dataset bags, and a class-selector query.
function createElement(tag) {
  const classes = new Set();
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: null,
    dataset: {},
    style: {},
    attributes: {},
    textContent: "",
    isConnected: true,
    classes,
    get className() {
      return Array.from(classes).join(" ");
    },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/u).filter(Boolean).forEach((name) => classes.add(name));
    },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children.forEach((node) => { node.parentElement = null; });
      this.children = nodes;
      nodes.forEach((node) => { node.parentElement = this; });
    },
  };
  return element;
}

const mountedHosts = [];

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function installDocument() {
  mountedHosts.length = 0;
  globalThis.document = {
    createElement,
    getElementById: () => null,
    querySelectorAll: (selector) => {
      const name = String(selector).replace(/^\./u, "");
      return mountedHosts
        .flatMap((host) => descendants(host))
        .filter((node) => node.classes.has(name));
    },
  };
  globalThis.requestAnimationFrame = () => 0;
}

function newHost() {
  const host = createElement("div");
  mountedHosts.push(host);
  return host;
}

function resetPlaceholderState() {
  state.model = null;
  state.headerLabels = [];
  state.devHeaderLabels = [];
  state.gridPlaceholder = null;
}

function allText(element) {
  return [element, ...descendants(element)].map((node) => node.textContent).join(" ");
}

function findByClass(element, className) {
  return descendants(element).filter((node) => node.classes.has(className));
}

test.beforeEach(() => {
  installDocument();
  resetPlaceholderState();
});

test("a running load paints a skeleton grid instead of an empty-state claim", () => {
  const token = placeholder.beginDatasetGridLoading({ message: 'Loading "Gross Loss--Paid"' });
  const host = newHost();
  const root = placeholder.renderDatasetGridPlaceholder(host);

  assert.equal(root.dataset.phase, "loading");
  assert.equal(findByClass(root, "dsGridSkeleton").length, 1);
  assert.ok(findByClass(root, "dsGridSkeletonBar").length > 0);
  assert.match(allText(root), /Loading "Gross Loss--Paid"\.\.\./u);
  assert.doesNotMatch(allText(root), /No Dataset Loaded/u);

  placeholder.endDatasetGridLoading(token);
});

test("the skeleton previews a triangle: each newer origin row is one column shorter", () => {
  const token = placeholder.beginDatasetGridLoading();
  const host = newHost();
  const root = placeholder.renderDatasetGridPlaceholder(host, { rows: 4, columns: 4 });

  const bodyRows = descendants(root).filter((node) => node.tagName === "TR").slice(1);
  const filledPerRow = bodyRows.map((row) => (
    row.children.filter((cell) => cell.tagName === "TD" && !cell.classes.has("dsGridSkeletonCellBlank")).length
  ));
  assert.deepEqual(filledPerRow, [4, 3, 2, 1]);

  placeholder.endDatasetGridLoading(token);
});

test("known origin labels are reused so the live grid replaces the same geometry", () => {
  state.headerLabels = ["2019", "2020", "2021"];
  state.devHeaderLabels = ["12", "24", "36"];
  const token = placeholder.beginDatasetGridLoading();
  const host = newHost();
  const root = placeholder.renderDatasetGridPlaceholder(host);

  const text = allText(root);
  assert.match(text, /2019/u);
  assert.match(text, /2021/u);
  assert.match(text, /36/u);

  placeholder.endDatasetGridLoading(token);
});

test("overlapping loads keep the skeleton until the last one settles", () => {
  const first = placeholder.beginDatasetGridLoading();
  const second = placeholder.beginDatasetGridLoading();
  const host = newHost();
  placeholder.renderDatasetGridPlaceholder(host);

  placeholder.endDatasetGridLoading(first);
  assert.equal(host.children[0].dataset.phase, "loading");

  placeholder.endDatasetGridLoading(second);
  assert.equal(host.children[0].dataset.phase, "empty");
});

test("a settled load repaints a mounted skeleton as the empty state", () => {
  const token = placeholder.beginDatasetGridLoading();
  const host = newHost();
  placeholder.renderDatasetGridPlaceholder(host);
  assert.equal(host.children[0].dataset.phase, "loading");

  placeholder.endDatasetGridLoading(token);

  const root = host.children[0];
  assert.equal(root.dataset.phase, "empty");
  assert.equal(findByClass(root, "dsGridSkeleton").length, 0);
  assert.match(allText(root), /No Dataset Loaded/u);
  assert.match(allText(root), /Select a project, reserving class, and dataset/u);
});

test("a grid that never registered a load shows the empty state, not a skeleton", () => {
  const host = newHost();
  const root = placeholder.renderDatasetGridPlaceholder(host);

  assert.equal(root.dataset.phase, "empty");
  assert.equal(findByClass(root, "dsGridSkeleton").length, 0);
});

test("a derived grid supplies its own empty wording", () => {
  placeholder.setDatasetGridEmpty();
  const host = newHost();
  const root = placeholder.renderDatasetGridPlaceholder(host, {
    emptyTitle: "No Ratios Yet",
    emptyHint: "Load a dataset in the Data tab to compute ratios.",
  });

  assert.match(allText(root), /No Ratios Yet/u);
  assert.match(allText(root), /compute ratios/u);
});

test("a failed load reports the failure instead of an empty grid", () => {
  const token = placeholder.beginDatasetGridLoading();
  placeholder.setDatasetGridError("Origin Start Date is missing or invalid.");
  placeholder.endDatasetGridLoading(token);

  const host = newHost();
  const root = placeholder.renderDatasetGridPlaceholder(host);
  assert.equal(root.dataset.phase, "error");
  assert.match(allText(root), /Load Failed/u);
  assert.match(allText(root), /Origin Start Date is missing or invalid\./u);
});

test("a new attempt drops the previous conclusion", () => {
  placeholder.setDatasetGridError("Dataset request failed (500).");
  const token = placeholder.beginDatasetGridLoading();
  const host = newHost();
  assert.equal(placeholder.getDatasetGridPlaceholderPhase(), "loading");

  placeholder.endDatasetGridLoading(token);
  const root = placeholder.renderDatasetGridPlaceholder(host);
  assert.equal(root.dataset.phase, "empty");
  assert.doesNotMatch(allText(root), /Dataset request failed/u);
});
