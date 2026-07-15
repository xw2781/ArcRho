// Shared Dataset/Data-tab view state.

export const state = {
  model: null,
  dirty: new Map(),
  fileMtime: null,
  showBlanks: true,
  datasetTypeSourceByKey: new Map(),
  datasetTypeFormulaByKey: new Map(),

  activeCell: null, // { r, c } or null
  chartMode: "byCol", // "byRow" = one line per origin, "byCol" = one line per dev period
};
