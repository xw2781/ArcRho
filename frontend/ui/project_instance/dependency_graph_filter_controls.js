import { createDependencyFilters, dependencyFilterOptions, dependencyFiltersActive, DEPENDENCY_FILTER_FIELDS } from "./dependency_graph_filters.js?v=20260920e";

import { renderValueFilterMenu } from "../shared/components/value_filter_menu/value_filter_menu.js?v=20260920a";

/** Graph checkbox filters. The graph owner decides when to redraw. */
export function createDependencyGraphFilterControls(root, { filters = createDependencyFilters(), onChange, onOpen }) {
  const buttons = new Map();
  let options = {}, openField = "", disabled = true;
  const panel = document.createElement("div");
  panel.className = "pi-table-filter-popover dg-filter-popover";
  panel.id = "dependencyGraphFilterPopover";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  document.body.append(panel);

  function close({ restoreFocus = false } = {}) {
    if (!openField) return false;
    const button = buttons.get(openField);
    openField = "";
    panel.hidden = true;
    panel.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
    return true;
  }

  function position() {
    if (!openField) return;
    const rect = buttons.get(openField).getBoundingClientRect();
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const width = window.innerWidth / zoom, height = window.innerHeight / zoom;
    const size = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left / zoom, width - size.width / zoom - 8));
    const top = Math.max(8, Math.min(rect.bottom / zoom + 6, height - size.height / zoom - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function sync() {
    for (const { key, label } of DEPENDENCY_FILTER_FIELDS) {
      const button = buttons.get(key), selected = filters[key];
      const labels = (options[key] || []).filter(option => selected.has(option.value)).map(option => option.label);
      const value = labels.length === 1 ? labels[0] : labels.length ? `${labels.length} selected` : "All";
      button.querySelector(".dg-filter-value").textContent = value;
      button.classList.toggle("is-active", !!selected.size);
      button.setAttribute("aria-label", `${label}: ${labels.join(", ") || "All"}`);
      button.disabled = disabled;
    }
    clearButton.disabled = disabled || !dependencyFiltersActive(filters);
    if (openField) {
      position();
    }
  }

  function changed() { sync(); onChange(); }

  function open(field) {
    const wasOpen = field.key === openField;
    close();
    if (wasOpen || disabled) return;
    onOpen();
    openField = field.key;
    const button = buttons.get(field.key);
    button.setAttribute("aria-expanded", "true");
    panel.setAttribute("aria-label", `${field.label} filter`);
    const { search } = renderValueFilterMenu(panel, {
      label: field.label,
      options: (options[field.key] || []).map(option => ({ key: option.value, label: option.label })),
      selected: filters[field.key],
      onChange({ allSelected }) {
        if (allSelected) filters[field.key].clear();
        changed();
        search.focus({ preventScroll: true });
      },
    });
    panel.hidden = false;
    panel.classList.add("open");
    position();
    search.focus({ preventScroll: true });
  }

  for (const field of DEPENDENCY_FILTER_FIELDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dg-filter-trigger";
    button.dataset.field = field.key;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panel.id);
    const label = document.createElement("span"), value = document.createElement("span");
    label.textContent = `${field.label}:`;
    value.className = "dg-filter-value";
    button.append(label, value);
    button.addEventListener("click", () => open(field));
    root.append(button);
    buttons.set(field.key, button);
  }
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "dg-filter-clear";
  clearButton.textContent = "Clear filters";
  function clear() {
    close();
    Object.values(filters).forEach(values => values.clear());
    changed();
  }
  clearButton.addEventListener("click", clear);
  root.append(clearButton);

  document.addEventListener("pointerdown", event => {
    if (!root.contains(event.target) && !panel.contains(event.target)) close();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && close({ restoreFocus: true })) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  document.addEventListener("focusin", event => {
    if (!root.contains(event.target) && !panel.contains(event.target)) close();
  });
  window.addEventListener("blur", () => close());
  window.addEventListener("resize", position);
  sync();
  return {
    filters, clear, close,
    setGraph(graph) { options = dependencyFilterOptions(graph, filters, options); sync(); },
    setDisabled(value) { disabled = value; if (value) close(); sync(); },
  };
}
