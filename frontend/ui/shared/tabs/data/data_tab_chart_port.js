let renderChartHandler = () => {};
let redrawChartHandler = () => {};

export function configureDataTabChart({ renderChart, redrawChartSafely } = {}) {
  renderChartHandler = typeof renderChart === "function" ? renderChart : () => {};
  redrawChartHandler = typeof redrawChartSafely === "function" ? redrawChartSafely : renderChartHandler;
}

export function renderDataTabChart() {
  return renderChartHandler();
}

export function redrawDataTabChartSafely() {
  return redrawChartHandler();
}
