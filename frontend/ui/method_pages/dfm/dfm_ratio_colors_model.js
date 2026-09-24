/*
===============================================================================
DFM Ratios Custom Colors - the pieces of the Ratios tables a user can recolour,
the named colours offered for them, and how a stored preference becomes the
CSS that paints them.

The preference is one local-user object shared by every DFM window:

  { version: 1, components: { "<component id>": { font?: "#rrggbb", fill?: "#rrggbb" } } }

A component with no entry keeps the look the theme and table style give it.
For each colour that is set, the document root carries the token
`<id>-<font|fill>` in `data-dfm-ratio-colors` and the custom property
`--dfm-ratio-color-<id>-<font|fill>`; the rules in dfm.css that read them are
switched on by the token, so an unset colour leaves the stylesheet untouched.

No DOM and no imports, so the node tests can load it directly.
===============================================================================
*/

export const DFM_RATIO_COLORS_VERSION = 1;
export const DFM_RATIO_COLORS_ATTRIBUTE = "data-dfm-ratio-colors";
export const DFM_RATIO_COLOR_PROPERTIES = ["font", "fill"];

export const DFM_RATIO_COLOR_GROUPS = [
  { id: "triangle", label: "Ratio Triangle" },
  { id: "averages", label: "Average Formulas" },
  { id: "selected", label: "Selected Table" },
  { id: "tables", label: "All Tables" },
];

// `probe` describes a stand-in cell the window builds inside the live tables to
// read the colours a component shows before the user changes them.
export const DFM_RATIO_COLOR_COMPONENTS = [
  {
    id: "ratio",
    label: "Ratio",
    group: "triangle",
    properties: ["font", "fill"],
    probe: { table: "ratioMainTable", classes: "cell ratioCell" },
  },
  {
    id: "excluded-ratio",
    label: "Excluded Ratio",
    group: "triangle",
    properties: ["font", "fill"],
    probe: { table: "ratioMainTable", classes: "cell ratioCell strike" },
  },
  {
    id: "data-value",
    label: "Data Value",
    group: "triangle",
    properties: ["font", "fill"],
    probe: { table: "ratioMainTable", classes: "cell ratioDataCell" },
  },
  {
    id: "average",
    label: "Average",
    group: "averages",
    properties: ["font", "fill"],
    probe: { table: "ratioSummaryTable", classes: "ratioCell summaryCell" },
  },
  {
    id: "selected-average",
    label: "Selected Average",
    group: "averages",
    properties: ["font", "fill"],
    probe: { table: "ratioSummaryTable", classes: "ratioCell summaryCell ratioSelectedCell" },
  },
  {
    id: "user-entry",
    label: "User Entry",
    group: "averages",
    properties: ["font", "fill"],
    probe: { table: "ratioSummaryTable", classes: "ratioCell summaryCell userEntryEditable" },
  },
  {
    id: "excel-linked",
    label: "Excel-Linked Value",
    group: "averages",
    properties: ["font"],
    probe: { table: "ratioSummaryTable", classes: "ratioCell summaryCell userEntryEditable excelLinked" },
  },
  {
    id: "excel-link-error",
    label: "Excel Link Error",
    group: "averages",
    properties: ["font"],
    probe: { table: "ratioSummaryTable", classes: "ratioCell summaryCell userEntryEditable excelLinked excelLinkError" },
  },
  {
    id: "selected-value",
    label: "Value",
    group: "selected",
    properties: ["font", "fill"],
    probe: { table: "ratioSelectedTable", classes: "" },
  },
  {
    id: "column-highlight",
    label: "Column Highlight",
    group: "tables",
    properties: ["fill"],
    probe: { table: "ratioMainTable", classes: "cell ratioCell ratioColActive" },
  },
  {
    id: "placeholder",
    label: "Placeholder Ratio",
    group: "tables",
    properties: ["font"],
    probe: { table: "ratioMainTable", classes: "cell ratioCell ratioPlaceholder" },
    sample: "1.0000",
  },
  {
    id: "column-header",
    label: "Column Header",
    group: "tables",
    properties: ["font", "fill"],
    probe: { table: "ratioMainTable", header: "column" },
    sample: "12-24",
  },
  {
    id: "row-label",
    label: "Row Label",
    group: "tables",
    properties: ["font", "fill"],
    probe: { table: "ratioMainTable", header: "row" },
    sample: "2019",
  },
];

// Soft fills first, then strong text colours, so the grid reads as two rows of
// intent. The fills are the Revolutionary table style's own selection fills.
export const DFM_RATIO_COLOR_PRESETS = [
  { name: "White", hex: "#ffffff" },
  { name: "Pale Grey", hex: "#f2f4f7" },
  { name: "Pale Yellow", hex: "#fdf8dc" },
  { name: "Gold", hex: "#f8e59a" },
  { name: "Pale Lime", hex: "#ecf8af" },
  { name: "Lime", hex: "#b5e222" },
  { name: "Pale Cyan", hex: "#ecf8f8" },
  { name: "Aqua", hex: "#cdeeee" },
  { name: "Pale Blue", hex: "#dae4f5" },
  { name: "Sky", hex: "#94bcf8" },
  { name: "Pale Rose", hex: "#fde2e4" },
  { name: "Lavender", hex: "#ede4fb" },
  { name: "Black", hex: "#000000" },
  { name: "Slate", hex: "#475569" },
  { name: "Grey", hex: "#94a3b8" },
  { name: "Excel Green", hex: "#217346" },
  { name: "Forest", hex: "#166534" },
  { name: "Teal", hex: "#0d6470" },
  { name: "Blue", hex: "#2b6df6" },
  { name: "Navy", hex: "#1e3a8a" },
  { name: "Purple", hex: "#7c3aed" },
  { name: "Magenta", hex: "#b000c2" },
  { name: "Red", hex: "#b91c1c" },
  { name: "Orange", hex: "#c2410c" },
];

const COMPONENTS_BY_ID = new Map(DFM_RATIO_COLOR_COMPONENTS.map((component) => [component.id, component]));

export function getDfmRatioColorComponent(id) {
  return COMPONENTS_BY_ID.get(String(id || "")) || null;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (the `#` optional) as lower-case long form; "" for anything else. */
export function normalizeDfmRatioColorHex(value) {
  const text = String(value ?? "").trim().replace(/^#/u, "").toLowerCase();
  if (/^[0-9a-f]{3}$/u.test(text)) return `#${text.replace(/./gu, "$&$&")}`;
  if (/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/u.test(text)) return `#${text}`;
  return "";
}

export function findDfmRatioColorPreset(hex) {
  const normalized = normalizeDfmRatioColorHex(hex);
  return DFM_RATIO_COLOR_PRESETS.find((preset) => preset.hex === normalized) || null;
}

/** A clean preference: known components and properties only, valid colours only. */
export function normalizeDfmRatioColors(raw) {
  const components = {};
  const source = raw && typeof raw === "object" ? raw.components : null;
  for (const component of DFM_RATIO_COLOR_COMPONENTS) {
    const entry = source && typeof source === "object" ? source[component.id] : null;
    if (!entry || typeof entry !== "object") continue;
    const colors = {};
    for (const property of component.properties) {
      const hex = normalizeDfmRatioColorHex(entry[property]);
      if (hex) colors[property] = hex;
    }
    if (Object.keys(colors).length) components[component.id] = colors;
  }
  return { version: DFM_RATIO_COLORS_VERSION, components };
}

/** The preference with one colour set, or cleared when `hex` is empty. */
export function setDfmRatioColor(prefs, id, property, hex) {
  const next = normalizeDfmRatioColors(prefs);
  const component = getDfmRatioColorComponent(id);
  if (!component || !component.properties.includes(property)) return next;
  const colors = { ...(next.components[id] || {}) };
  const normalized = normalizeDfmRatioColorHex(hex);
  if (normalized) colors[property] = normalized;
  else delete colors[property];
  next.components = { ...next.components, [id]: colors };
  return normalizeDfmRatioColors(next);
}

export function resetDfmRatioColorComponent(prefs, id) {
  const next = normalizeDfmRatioColors(prefs);
  delete next.components[id];
  return next;
}

export function dfmRatioColorToken(id, property) {
  return `${id}-${property}`;
}

export function dfmRatioColorPropertyName(id, property) {
  return `--dfm-ratio-color-${dfmRatioColorToken(id, property)}`;
}

/** The root attribute tokens and custom properties that paint `prefs`. */
export function dfmRatioColorCssState(prefs) {
  const normalized = normalizeDfmRatioColors(prefs);
  const tokens = [];
  const properties = {};
  for (const component of DFM_RATIO_COLOR_COMPONENTS) {
    const colors = normalized.components[component.id];
    if (!colors) continue;
    for (const property of component.properties) {
      if (!colors[property]) continue;
      tokens.push(dfmRatioColorToken(component.id, property));
      properties[dfmRatioColorPropertyName(component.id, property)] = colors[property];
    }
  }
  return { tokens, properties };
}
