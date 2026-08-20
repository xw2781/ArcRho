// Shared Dataset/Data-tab view state.

export const state = {
  model: null,
  dirty: new Map(),
  fileMtime: null,
  // `updated_at` of the sidecar this window currently has in view, as the
  // payload recorded it. The open-window change watch treats any write no
  // newer than this as its own, so a stale share read cannot raise the alert.
  sidecarUpdatedAt: "",
  showBlanks: true,
  datasetTypeSourceByKey: new Map(),
  datasetTypeFormulaByKey: new Map(),

  activeCell: null, // { r, c } or null
  chartMode: "byCol", // "byRow" = one line per origin, "byCol" = one line per dev period
};
