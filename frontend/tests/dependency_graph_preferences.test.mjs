import assert from "node:assert/strict";
import test from "node:test";
import { createDependencyFilters } from "../ui/project_instance/dependency_graph_filters.js";
import { DEPENDENCY_GRAPH_PREFERENCES_KEY, readDependencyGraphPreferences, writeDependencyGraphPreferences } from "../ui/project_instance/dependency_graph_preferences.js";

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
}

test("graph filters and unchecked matched-only survive reopening; clearing replaces saved choices", () => {
  const store = storage(), filters = createDependencyFilters();
  filters.status.add("2"); filters.category.add("loss"); filters.methodType.add("dfm");
  writeDependencyGraphPreferences({ filters, matchedOnly: false }, store);
  const reopened = readDependencyGraphPreferences(store);
  assert.deepEqual(reopened.filters, filters);
  assert.equal(reopened.matchedOnly, false);
  Object.values(reopened.filters).forEach(values => values.clear());
  writeDependencyGraphPreferences(reopened, store);
  assert.deepEqual(readDependencyGraphPreferences(store), { filters: createDependencyFilters(), matchedOnly: false });
});

test("first use and invalid saved data start unrestricted with matched-only checked", () => {
  const store = storage();
  assert.deepEqual(readDependencyGraphPreferences(store), { filters: createDependencyFilters(), matchedOnly: true });
  store.setItem(DEPENDENCY_GRAPH_PREFERENCES_KEY, "invalid json");
  assert.deepEqual(readDependencyGraphPreferences(store), { filters: createDependencyFilters(), matchedOnly: true });
  store.setItem(DEPENDENCY_GRAPH_PREFERENCES_KEY, JSON.stringify({ filters: { status: ["2", "1", null], category: [" Loss ", "loss"], methodType: [""] }, matchedOnly: "false" }));
  const restored = readDependencyGraphPreferences(store);
  assert.deepEqual([...restored.filters.status], ["2"]);
  assert.deepEqual([...restored.filters.category], ["loss"]);
  assert.deepEqual([...restored.filters.methodType], [""]);
  assert.equal(restored.matchedOnly, true);
});

test("unknown current-graph values remain selected and write failures reach the caller", () => {
  const store = storage(), filters = createDependencyFilters();
  filters.category.add("not in this class");
  writeDependencyGraphPreferences({ filters, matchedOnly: true }, store);
  assert.deepEqual(readDependencyGraphPreferences(store).filters.category, filters.category);
  const unavailable = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  assert.equal(readDependencyGraphPreferences(unavailable).matchedOnly, true);
  assert.throws(() => writeDependencyGraphPreferences({ filters, matchedOnly: true }, unavailable), /blocked/);
});
