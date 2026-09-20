import { dependencyGraphIsolatedKeys, dependencyGraphKey, pruneDependencyGraph } from "./dependency_graph_layout.js?v=20260920c";
import { STATUS_CURRENT, STATUS_REVIEW_NEEDED, statusNeedsReview } from "../shared/dataset/review_status.js";
import { berquistShermanDisplayLabel } from "../shared/dataset/berquist_sherman_contract.js";

export const DEPENDENCY_FILTER_FIELDS = Object.freeze([
  { key: "status", label: "Status", help: "Saved review status. Excel-link freshness is separate." },
  { key: "category", label: "Category", help: "Any selected category. No selection means All." },
  { key: "methodType", label: "Method Type", help: "Any selected method type. No selection means All." },
]);

export function createDependencyFilters() {
  return Object.fromEntries(DEPENDENCY_FILTER_FIELDS.map(({ key }) => [key, new Set()]));
}

export function dependencyFiltersActive(filters) {
  return DEPENDENCY_FILTER_FIELDS.some(({ key }) => filters[key]?.size);
}

function nodeValue(node, field) {
  if (field === "status") return String(statusNeedsReview(node.status) ? STATUS_REVIEW_NEEDED : STATUS_CURRENT);
  return dependencyGraphKey(node[field]);
}

function valueLabel(node, field) {
  if (field === "status") return statusNeedsReview(node.status) ? "Needs Review" : "Updated";
  if (field === "methodType") return berquistShermanDisplayLabel(node.methodType) || "None";
  return node.category || "Uncategorized";
}

/** Counts describe connected indexed nodes, independent of selections. */
export function dependencyFilterOptions(graph, filters, previous = {}) {
  const isolated = dependencyGraphIsolatedKeys(graph);
  return Object.fromEntries(DEPENDENCY_FILTER_FIELDS.map(({ key }) => {
    const values = new Map();
    for (const node of graph.nodes) {
      if (isolated.has(node.key)) continue;
      const value = nodeValue(node, key);
      if (!values.has(value)) values.set(value, { value, label: valueLabel(node, key), count: 0 });
      values.get(value).count++;
    }
    for (const value of filters[key]) {
      if (!values.has(value)) {
        const old = previous[key]?.find(option => option.value === value);
        values.set(value, { value, label: old?.label ?? value, count: 0 });
      }
    }
    return [key, [...values.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }))];
  }));
}

/** Connect matches through hidden nodes, stopping at the next visible match. */
function connectHiddenPaths(fullGraph, graph) {
  for (const source of graph.nodes) {
    const reached = new Set([source.key]);
    const stack = fullGraph.byKey.get(source.key).dependents.filter(key => !graph.byKey.has(key));
    while (stack.length) {
      const key = stack.pop();
      if (reached.has(key)) continue;
      reached.add(key);
      if (graph.byKey.has(key)) {
        if (!source.dependents.includes(key)) {
          graph.edges.push({ source: source.key, target: key, indirect: true });
          source.dependents.push(key);
          graph.byKey.get(key).precedents.push(source.key);
        }
      } else stack.push(...fullGraph.byKey.get(key).dependents);
    }
  }
  return graph;
}

/** Same-node AND across fields; OR within a field, with optional chain context. */
export function filterDependencyGraph(graph, filters, { matchedOnly = true } = {}) {
  const active = dependencyFiltersActive(filters);
  const matches = new Set();
  let hidden = dependencyGraphIsolatedKeys(graph);
  if (active) {
    for (const node of graph.nodes) {
      if (hidden.has(node.key)) continue;
      if (DEPENDENCY_FILTER_FIELDS.every(({ key }) => !filters[key].size || filters[key].has(nodeValue(node, key)))) matches.add(node.key);
    }
    const visible = new Set(matches);
    // Separate multi-source walks avoid expanding a merge's sibling branches
    // and visit each edge at most once per direction, even for many matches.
    for (const field of matchedOnly ? [] : ["precedents", "dependents"]) {
      const reached = new Set(matches), stack = [...matches];
      while (stack.length) {
        for (const key of graph.byKey.get(stack.pop())[field]) {
          if (reached.has(key)) continue;
          reached.add(key);
          visible.add(key);
          stack.push(key);
        }
      }
    }
    hidden = new Set(graph.nodes.filter(node => !visible.has(node.key)).map(node => node.key));
  }
  const visibleGraph = pruneDependencyGraph(graph, hidden);
  if (active && matchedOnly && hidden.size) connectHiddenPaths(graph, visibleGraph);
  return { active, matches, hiddenCount: hidden.size, graph: visibleGraph };
}

export function dependencyFilterSummary(result) {
  const matches = result.matches.size;
  return `${matches} match${matches === 1 ? "" : "es"}, ${result.graph.nodes.length - matches} context datasets, `
    + `${result.hiddenCount} hidden, ${result.graph.edges.length} links.`;
}

export function hiddenDependencyLinks(node, fullGraph, graph, field) {
  return (fullGraph.byKey.get(node.key)?.[field] || []).filter(key => !graph.byKey.has(key)).length;
}
