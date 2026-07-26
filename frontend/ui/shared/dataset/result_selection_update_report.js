function cleanName(value) {
  return String(value ?? "").trim();
}

function collectNamedItems(target, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const name = cleanName(
      item?.dataset_name
      ?? item?.dataset_type_name
      ?? item?.method_name
      ?? item?.name,
    );
    if (name) target.add(name);
  }
}

export function resultSelectionUpdateNames(report) {
  const names = new Set();
  const seen = new Set();

  function visit(value, resultSelectionScope = false) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (resultSelectionScope) {
      collectNamedItems(names, value.updated);
      collectNamedItems(names, value.status_refreshed);
      collectNamedItems(names, value.errors);
    }
    visit(value.result_selection_updates, true);
    visit(value.calculated_updates, false);
    visit(value.propagation, false);
    for (const step of Array.isArray(value.steps) ? value.steps : []) visit(step, false);
  }

  visit(report, false);
  return names;
}

export function hasResultSelectionUpdates(report) {
  return resultSelectionUpdateNames(report).size > 0;
}

export function resultSelectionUpdateContexts(report) {
  const contexts = [];
  const contextKeys = new Set();
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const project = cleanName(value.project_name ?? value.project);
    const reservingClass = cleanName(value.reserving_class ?? value.reservingClass);
    if (project || reservingClass) {
      const key = `${project.toLowerCase()}::${reservingClass.toLowerCase()}`;
      if (!contextKeys.has(key)) {
        contextKeys.add(key);
        contexts.push({ project, reservingClass });
      }
    }
    visit(value.result_selection_updates);
    visit(value.calculated_updates);
    visit(value.propagation);
    for (const step of Array.isArray(value.steps) ? value.steps : []) visit(step);
  }

  visit(report);
  return contexts;
}
