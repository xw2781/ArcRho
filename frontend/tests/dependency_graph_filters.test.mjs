import assert from "node:assert/strict";
import test from "node:test";
import { buildDependencyGraph } from "../ui/project_instance/dependency_graph_layout.js";
import { createDependencyFilters, dependencyFilterOptions, filterDependencyGraph, hiddenDependencyLinks } from "../ui/project_instance/dependency_graph_filters.js";
import { datasetInstanceCategory } from "../ui/shared/dataset/dataset_category.js";

function fixture() {
  return buildDependencyGraph({
    nodes: [
      { name: "Input", dataset_category: "Loss" },
      { name: "Paid", method_type: "DFM", status: 2, dataset_category: "Loss" },
      { name: "Sibling", method_type: "DFM", status: 0, dataset_category: "Loss" },
      { name: "Ultimate", method_type: "Result Selection", dataset_category: "Loss" },
      { name: "Expense", method_type: "DFM", status: 2, dataset_category: "Expense" },
      { name: "Unused", dataset_type_category: "Premium" },
      { name: "Blank" },
      { name: "Gone", in_index: false, status: 2, method_type: "DFM" },
    ],
    edges: [
      { source: "Input", target: "Paid" },
      { source: "Paid", target: "Ultimate" },
      { source: "Sibling", target: "Ultimate" },
      { source: "Expense", target: "Ultimate" },
      { source: "Gone", target: "Paid" },
    ],
  });
}

test("same-node AND keeps directional chain context without sibling branches", () => {
  const graph = fixture(), filters = createDependencyFilters();
  filters.status.add("2"); filters.category.add("loss"); filters.methodType.add("dfm");
  const result = filterDependencyGraph(graph, filters, { matchedOnly: false });
  assert.deepEqual([...result.matches], ["paid"]);
  assert.deepEqual(result.graph.nodes.map(node => node.key), ["input", "paid", "ultimate"]);
  assert.equal(result.graph.edges.length, 2);
  assert.equal(hiddenDependencyLinks(result.graph.byKey.get("ultimate"), graph, result.graph, "precedents"), 2);
  assert.equal(result.hiddenCount, 4);
  filters.methodType = new Set(["result selection"]);
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 0, "different nodes cannot jointly satisfy the filters");
});

test("OR values merge chains without duplicate nodes or links", () => {
  const filters = createDependencyFilters();
  filters.status.add("2"); filters.category = new Set(["loss", "expense"]);
  const result = filterDependencyGraph(fixture(), filters, { matchedOnly: false });
  assert.deepEqual([...result.matches], ["paid", "expense"]);
  assert.equal(result.graph.nodes.length, 4);
  assert.equal(result.graph.edges.length, 3);
});

test("matched-only defaults on, collapses hidden paths, and restores normal chain context when off", () => {
  const graph = buildDependencyGraph({ nodes: [
    { name: "A", status: 2 }, { name: "Hidden" }, { name: "B", status: 2 },
    { name: "Hidden 2" }, { name: "C", status: 2 }, { name: "Sibling", status: 2 },
    { name: "Isolated", status: 2 },
  ], edges: [
    { source: "A", target: "Hidden" }, { source: "Hidden", target: "B" },
    { source: "B", target: "Hidden 2" }, { source: "Hidden 2", target: "C" },
    { source: "Sibling", target: "Hidden" },
  ] });
  const snapshot = JSON.stringify(graph), filters = createDependencyFilters();
  filters.status.add("2");
  const focused = filterDependencyGraph(graph, filters);
  assert.deepEqual(focused.graph.nodes.map(node => node.key), ["a", "b", "c", "sibling"]);
  assert.deepEqual(focused.graph.edges, [
    { source: "a", target: "b", indirect: true },
    { source: "b", target: "c", indirect: true },
    { source: "sibling", target: "b", indirect: true },
  ]);
  assert.deepEqual(focused.graph.byKey.get("b").precedents, ["a", "sibling"]);
  assert.deepEqual(focused.graph.byKey.get("a").dependents, ["b"]);
  assert.equal(focused.hiddenCount, 3);
  const expanded = filterDependencyGraph(graph, filters, { matchedOnly: false });
  assert.equal(expanded.graph.nodes.length, 6);
  assert.equal(expanded.graph.edges.length, 5);
  assert.ok(expanded.graph.edges.every(edge => !edge.indirect));
  assert.equal(JSON.stringify(graph), snapshot, "projection leaves the source graph unchanged");
  filters.status.clear();
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 6);
  filters.category.add("missing");
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 0);
});

test("indirect links prefer direct edges, deduplicate paths, and terminate on hidden cycles", () => {
  const graph = buildDependencyGraph({ nodes: [
    { name: "A", status: 2 }, { name: "B", status: 2 }, { name: "X" }, { name: "Y" },
  ], edges: [
    { source: "A", target: "B" }, { source: "A", target: "X" },
    { source: "A", target: "Y" }, { source: "X", target: "Y" },
    { source: "Y", target: "X" }, { source: "X", target: "A" },
    { source: "Y", target: "B" }, { source: "B", target: "Y" },
  ] });
  const filters = createDependencyFilters(); filters.status.add("2");
  const result = filterDependencyGraph(graph, filters);
  assert.deepEqual(result.graph.edges, [
    { source: "a", target: "b" }, { source: "b", target: "a", indirect: true },
  ]);
  assert.deepEqual(result.graph.byKey.get("a").dependents, ["b"]);
});

test("isolated datasets stay hidden when filters are applied or cleared", () => {
  const graph = fixture(), filters = createDependencyFilters();
  filters.category.add("premium"); filters.methodType.add("");
  assert.equal(filterDependencyGraph(graph, filters).matches.size, 0);
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 0);
  filters.category = new Set([""]);
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 0);
  filters.category.clear(); filters.methodType.clear();
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 5);
  assert.equal(filterDependencyGraph(graph, filters).hiddenCount, 2);
});

test("review and method filters cannot reveal isolated methods or invalid connections", () => {
  const graph = buildDependencyGraph({ nodes: [
    { name: "Input" }, { name: "Terminal", source_kind: "calculated", status: 2 },
    { name: "Isolated DFM", method_type: "DFM", status: 2 },
    { name: "Unindexed", in_index: false },
  ], edges: [
    { source: "Input", target: "Terminal" },
    { source: "Isolated DFM", target: "Isolated DFM" },
    { source: "Unindexed", target: "Isolated DFM" },
    { source: "Isolated DFM", target: "Missing" },
  ] });
  const filters = createDependencyFilters();
  assert.deepEqual(filterDependencyGraph(graph, filters).graph.nodes.map(node => node.key), ["input", "terminal"]);
  filters.status.add("2");
  assert.deepEqual([...filterDependencyGraph(graph, filters).matches], ["terminal"]);
  filters.methodType.add("dfm");
  assert.equal(filterDependencyGraph(graph, filters).graph.nodes.length, 0);
});

test("cyclic and overlapping chains terminate and preserve original edges", () => {
  const graph = buildDependencyGraph({ nodes: [{ name: "A", status: 2 }, { name: "B" }, { name: "C", status: 2 }], edges: [
    { source: "A", target: "B" }, { source: "B", target: "C" }, { source: "C", target: "A" },
  ] });
  const filters = createDependencyFilters(); filters.status.add("2");
  const result = filterDependencyGraph(graph, filters, { matchedOnly: false });
  assert.equal(result.graph.nodes.length, 3); assert.equal(result.graph.edges.length, 3);
});

test("option counts exclude isolated nodes and retain selections at zero after connections disappear", () => {
  const filters = createDependencyFilters(); filters.category.add("loss");
  const original = dependencyFilterOptions(fixture(), filters);
  assert.deepEqual(original.category.find(option => option.value === "loss"), { value: "loss", label: "Loss", count: 4 });
  assert.equal(original.methodType.find(option => option.value === "dfm").count, 3);
  assert.equal(original.category.some(option => option.value === "premium"), false);
  const refreshed = buildDependencyGraph({ nodes: [{ name: "Paid", dataset_category: "Loss", method_type: "DFM" }] });
  const options = dependencyFilterOptions(refreshed, filters, original);
  assert.deepEqual(options.category.find(option => option.value === "loss"), { value: "loss", label: "Loss", count: 0 });
  assert.equal(filterDependencyGraph(refreshed, filters).graph.nodes.length, 0);
});

test("category projection matches the PI table's existing instance then type rule", () => {
  assert.equal(datasetInstanceCategory({ dataset_category: " Stored " }, "Type"), "Stored");
  assert.equal(datasetInstanceCategory({ category: " Alias " }, "Type"), "Alias");
  assert.equal(datasetInstanceCategory({ dataset_category: " " }, " Type "), "Type");
  assert.equal(datasetInstanceCategory(null), "");
  const graph = buildDependencyGraph({ nodes: [{ name: "A", dataset_category: "Stored", dataset_type_category: "Type" }, { name: "B", dataset_type_category: "Type" }] });
  assert.deepEqual(graph.nodes.map(node => node.category), ["Stored", "Type"]);
});

test("method options retain routing identity and show the shared Berquist-Sherman label", () => {
  const graph = buildDependencyGraph({ nodes: [{ name: "Input" }, { name: "Adjustment", method_type: "B&S Settlement Rate Adjustment" }], edges: [{ source: "Input", target: "Adjustment" }] });
  const filters = createDependencyFilters();
  const option = dependencyFilterOptions(graph, filters).methodType.find(option => option.value);
  assert.equal(option.label, "Berquist Sherman SR");
  filters.methodType.add(option.value);
  assert.equal(filterDependencyGraph(graph, filters).matches.size, 1);
});

test("a retained status selection keeps its name when no node carries the code", () => {
  const filters = createDependencyFilters(); filters.status.add("2");
  const graph = buildDependencyGraph({ nodes: [{ name: "Paid", status: 0 }, { name: "Ultimate", status: 0 }], edges: [{ source: "Paid", target: "Ultimate" }] });
  assert.deepEqual(dependencyFilterOptions(graph, filters).status.find(option => option.value === "2"), { value: "2", label: "Needs Review", count: 0 });
  assert.deepEqual(dependencyFilterOptions(buildDependencyGraph({ nodes: [] }), filters).status, [{ value: "2", label: "Needs Review", count: 0 }]);
});
