import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../ui/project_instance/project_instance_dependency_graph.js", import.meta.url), "utf8");
const tooltip = `data:text/javascript,export function attachArcrhoTooltip(){}`;
const moduleSource = source
  .replace(/"\/ui\/shared\/components\/tooltip\/tooltip.js[^\"]*"/, JSON.stringify(tooltip))
  .replace(/"\.\/([^\"]+)"/g, (_, path) => JSON.stringify(new URL(`../ui/project_instance/${path}`, import.meta.url).href));
const { installProjectInstanceDependencyGraph } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
const { DEPENDENCY_GRAPH_ACTION_MESSAGE } = await import("../ui/project_instance/dependency_graph_contract.js");

function harness() {
  const calls = [], replies = [];
  const source = { postMessage: message => replies.push(message) };
  const frame = { dataset: { windowKind: "dependency_graph" } };
  const state = { selectedPath: "Other Class", cachedDatasetFilter: { error: "" } };
  const api = {
    normalizePath: value => String(value || "").trim(),
    findWindowByMessageSource: value => value === source ? frame : null,
    getWindowPath: () => "Pinned Class",
    setStatus: message => calls.push(["status", message]),
    setDatasetRowsReviewStatus: async (...args) => { calls.push(["review", ...args]); return { ok: true, message: "Reviewed" }; },
    isTemporaryDatasetView: () => false,
    isReservingClassBusy: () => false,
    hasCachedDatasetSnapshotForSelectedPath: () => true,
    setSelectedPath: async path => { calls.push(["path", path]); state.selectedPath = path; },
    selectDatasetRecordByName: (...args) => { calls.push(["select", ...args]); return true; },
    hideDatasetWindow: async value => calls.push(["hide", value]),
    focusProjectInstancePage: () => calls.push(["focus-page"]),
    focusDatasetTableSurface: () => calls.push(["focus-table"]),
    revealPathTreeSelection: async path => calls.push(["reveal-path", path]),
  };
  globalThis.window = { addEventListener() {} };
  installProjectInstanceDependencyGraph({ api, state, els: {}, projectName: "Project" });
  const act = (action, extra = {}) => api.handleDependencyGraphAction({ source, data: {
    type: DEPENDENCY_GRAPH_ACTION_MESSAGE, action, datasetName: "Named Output", methodType: "DFM", reservingClass: "Untrusted Class", ...extra,
  } });
  return { api, act, calls, replies, state };
}

test("Set Reviewed uses the graph frame's class and exact output name", async () => {
  const h = harness();
  await h.act("set-reviewed");
  assert.deepEqual(h.calls[0], ["review", [{ datasetName: "Named Output", values: { methodType: "DFM" } }], false, { reservingClass: "Pinned Class" }]);
  assert.equal(h.state.selectedPath, "Other Class");
  assert.equal(h.replies[0].ok, true);
});

test("View in Dataset Table awaits the pinned class then reveals and selects the exact row", async () => {
  const h = harness();
  await h.act("view-in-table");
  assert.deepEqual(h.calls.slice(0, 2), [["path", "Pinned Class"], ["select", "Named Output", { reveal: true }]]);
  assert.deepEqual(h.calls.slice(2, 5).map(c => c[0]), ["hide", "focus-page", "focus-table"]);
  assert.equal(h.replies[0].ok, true);
});

test("a missing row reports failure and keeps the graph open", async () => {
  const h = harness(); h.api.selectDatasetRecordByName = () => false;
  await h.act("view-in-table");
  assert.equal(h.replies[0].ok, false);
  assert.match(h.replies[0].message, /no longer/);
  assert.equal(h.calls.some(c => c[0] === "hide"), false);
});

test("a refused temporary-view exit prevents path and selection changes", async () => {
  const h = harness();
  h.api.isTemporaryDatasetView = () => true;
  h.api.toggleDatasetViewMode = async () => false;
  await h.act("view-in-table");
  assert.equal(h.state.selectedPath, "Other Class");
  assert.equal(h.replies[0].ok, false);
});

test("busy review and transport failures are returned to the graph", async () => {
  const h = harness(); h.state.selectedPath = "Pinned Class";
  h.api.isReservingClassBusy = () => true;
  await h.act("set-reviewed");
  assert.equal(h.calls.some(c => c[0] === "review"), false);
  assert.equal(h.replies[0].ok, false);
  h.api.isReservingClassBusy = () => false;
  h.api.setDatasetRowsReviewStatus = async () => ({ ok: false, message: "Gateway unavailable" });
  await h.act("set-reviewed");
  assert.equal(h.replies[1].message, "Gateway unavailable");
});

test("actions from windows other than an owned graph are ignored", async () => {
  const h = harness();
  h.api.findWindowByMessageSource = () => ({ dataset: { windowKind: "dataset" } });
  await h.act("set-reviewed");
  assert.deepEqual(h.calls, []); assert.deepEqual(h.replies, []);
});
