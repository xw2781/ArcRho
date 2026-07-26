export function hiddenChartSeriesIdsAfterContextToggle(series = [], targetSeriesId = "", currentHiddenIds = []) {
  const ids = series
    .map((entry) => entry?.id)
    .filter((id) => id !== null && id !== undefined);
  const currentHidden = new Set(currentHiddenIds);
  const visibleIds = ids.filter((id) => !currentHidden.has(id));
  if (visibleIds.length === 1 && visibleIds[0] === targetSeriesId) return new Set();
  return new Set(ids.filter((id) => id !== targetSeriesId));
}

export function canHideChartLegendSeries(series = [], targetSeriesId = "", currentHiddenIds = []) {
  const currentHidden = new Set(currentHiddenIds);
  if (currentHidden.has(targetSeriesId)) return true;
  const visibleCount = series.reduce((count, entry) => (
    entry?.id !== null && entry?.id !== undefined && !currentHidden.has(entry.id)
      ? count + 1
      : count
  ), 0);
  return visibleCount > 1;
}

function updateLegendCount(countElement, series, hiddenIds) {
  if (!countElement) return;
  const visibleCount = series.reduce((count, entry) => (
    !hiddenIds.has(entry.id) ? count + 1 : count
  ), 0);
  countElement.textContent = `${visibleCount} of ${series.length}`;
}

export function renderChartLegend({
  listElement,
  countElement,
  series = [],
  hiddenIds = new Set(),
  onVisibilityChange,
} = {}) {
  if (!listElement) return;
  const normalizedSeries = Array.isArray(series) ? series : [];
  const activeIds = new Set(normalizedSeries.map((entry) => entry.id));
  for (const id of hiddenIds) {
    if (!activeIds.has(id)) hiddenIds.delete(id);
  }

  const rerender = () => renderChartLegend({
    listElement,
    countElement,
    series: normalizedSeries,
    hiddenIds,
    onVisibilityChange,
  });
  const items = normalizedSeries.map((entry) => {
    const item = document.createElement("label");
    item.className = "arChartLegendItem";
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const nextHiddenIds = hiddenChartSeriesIdsAfterContextToggle(
        normalizedSeries,
        entry.id,
        hiddenIds,
      );
      hiddenIds.clear();
      for (const id of nextHiddenIds) hiddenIds.add(id);
      rerender();
      onVisibilityChange?.();
    });

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hiddenIds.has(entry.id);
    checkbox.setAttribute("aria-label", `Show ${entry.label}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        hiddenIds.delete(entry.id);
      } else if (canHideChartLegendSeries(normalizedSeries, entry.id, hiddenIds)) {
        hiddenIds.add(entry.id);
      } else {
        checkbox.checked = true;
        return;
      }
      updateLegendCount(countElement, normalizedSeries, hiddenIds);
      onVisibilityChange?.();
    });

    const swatch = document.createElement("span");
    swatch.className = "arChartLegendSwatch";
    swatch.style.setProperty("--ar-chart-legend-series", entry.color);
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "arChartLegendLabel";
    label.textContent = String(entry.label ?? "");
    item.append(checkbox, swatch, label);
    return item;
  });
  listElement.replaceChildren(...items);
  updateLegendCount(countElement, normalizedSeries, hiddenIds);
}
