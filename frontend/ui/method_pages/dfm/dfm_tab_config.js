export const DFM_TAB_DEFS = Object.freeze([
  { id: "details", label: "Details" },
  { id: "data", label: "Data" },
  { id: "ratios", label: "Ratios" },
  { id: "results", label: "Results" },
  { id: "notes", label: "Notes" },
  { id: "audit", label: "Audit Log" },
]);

export const ALLOWED_DFM_TABS = new Set(DFM_TAB_DEFS.map(({ id }) => id));
