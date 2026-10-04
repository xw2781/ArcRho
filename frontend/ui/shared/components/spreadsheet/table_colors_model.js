/*
===============================================================================
Table Appearance - table colours and section typography,
the named colours offered for them, and how a stored preference becomes the
CSS that paints them.

The preference is one local-user object shared by every method page:

  { version: 1, components: { "<component id>": { font?, fill?, border?: "#rrggbb", width?: 1-3 } },
    fonts?: { "<group id>": { family?: string, size?: number, bold?: boolean, italic?: boolean } } }

`font` remains the text colour. `fonts` holds optional section typography;
absent properties keep the stylesheet defaults. Size and border width use pixels.

A component with no entry keeps the look the theme and table style give it.
For each value that is set, the root carries the token `<id>-<property>` in
`data-ar-table-colors` and a custom property holding the colour. The parts
every table has (the "All Tables" group) name the shared spreadsheet variable
the part already reads, so setting it on the root repaints every page's tables
at once; a page rule switched on by the token is needed only where a theme
fixes that part's colour outright. A part only one page has belongs to a group
naming that `page` and sets `--ar-table-color-<id>-<font|fill>`, which that
page's own rules read once the token switches them on. Either way an unset
colour leaves the stylesheets untouched.

No DOM and no imports, so the node tests can load it directly.
===============================================================================
*/

export const TABLE_COLORS_VERSION = 1;
export const TABLE_APPEARANCE_TITLE = "Table Appearance";
export const TABLE_APPEARANCE_MENU_LABEL = `${TABLE_APPEARANCE_TITLE}…`;
export const TABLE_COLORS_ATTRIBUTE = "data-ar-table-colors";
export const TABLE_COLOR_PROPERTIES = ["font", "fill", "border", "width"];
export const TABLE_BORDER_WIDTHS = [1, 2, 3];

// A group with a `page` is shown only on that page; the rest are on every page.
// Page groups come first, so the parts every table shares close the list.
export const TABLE_COLOR_GROUPS = [
  { id: "dfm-triangle", label: "Ratio Triangle", page: "dfm", fontSelector: "#ratioWrap .ratioMainTable" },
  { id: "dfm-averages", label: "Average Formulas", page: "dfm", fontSelector: "#ratioWrap .ratioSummaryTable" },
  { id: "dfm-selected", label: "Selected Table", page: "dfm", fontSelector: "#ratioWrap .ratioSelectedTable" },
  { id: "dfm-ratios", label: "All Ratios Tables", page: "dfm", fontSelector: "#ratioWrap table" },
  { id: "tables", label: "All Tables", fontSelector: "table.arSpreadsheetTable" },
];

export const TABLE_FONT_SIZE_MIN = 8;
export const TABLE_FONT_SIZE_MAX = 32;

/** Optional typography per section; omitted fields keep the existing style. */
function normalizeTableFonts(raw) {
  const fonts = {};
  for (const group of TABLE_COLOR_GROUPS) {
    const source = raw?.[group.id];
    if (!source || typeof source !== "object") continue;
    const font = {};
    const family = String(source.family || "").trim();
    if (/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,79}$/u.test(family)) font.family = family;
    const size = Number(source.size);
    if (Number.isInteger(size) && size >= TABLE_FONT_SIZE_MIN && size <= TABLE_FONT_SIZE_MAX) font.size = size;
    for (const key of ["bold", "italic"]) if (typeof source[key] === "boolean") font[key] = source[key];
    if (Object.keys(font).length) fonts[group.id] = font;
  }
  return fonts;
}

export function setTableFont(prefs, group, property, value) {
  const next = normalizeTableColors(prefs);
  const font = { ...next.fonts?.[group], [property]: value };
  return normalizeTableColors({ ...next, fonts: { ...next.fonts, [group]: font } });
}

export function resetTableFont(prefs, group) {
  const next = normalizeTableColors(prefs);
  if (next.fonts) delete next.fonts[group];
  return normalizeTableColors(next);
}

/** Broad sections first; individual table settings override them per property. */
export function tableFontCss(prefs) {
  const fonts = normalizeTableFonts(prefs?.fonts);
  return [...TABLE_COLOR_GROUPS].reverse().map(group => {
    const font = fonts[group.id];
    if (!font) return "";
    const rules = [];
    if (font.family) rules.push(`font-family: "${font.family}" !important`);
    if (font.size) rules.push(`font-size: ${font.size}px !important`,
      `--ar-spreadsheet-cell-height: calc(${font.size}px * 1.35)`, "line-height: var(--ar-spreadsheet-cell-height) !important");
    if (typeof font.bold === "boolean") rules.push(`font-weight: ${font.bold ? 700 : 400} !important`);
    if (typeof font.italic === "boolean") rules.push(`font-style: ${font.italic ? "italic" : "normal"} !important`);
    return `:root[data-ar-table-colors~="table-font-${group.id}"] :where(${group.fontSelector}, ${group.fontSelector} *) { ${rules.join("; ")}; }`;
  }).filter(Boolean).join("\n");
}

// `probe` describes a stand-in cell the window builds to read the colours a
// component shows before the user changes them: inside the element whose id is
// `host`, or in the page body when there is none. A part each page draws with
// its own classes has no probe, and the window shows its variables instead.
// `variables` names, for each colour of an every-table part, the shared
// spreadsheet variable it sets.
export const TABLE_COLOR_COMPONENTS = [
  {
    id: "ratio",
    label: "Ratio",
    group: "dfm-triangle",
    properties: ["font", "fill"],
    probe: { host: "ratioWrap", table: "ratioMainTable", classes: "cell ratioCell" },
  },
  {
    id: "excluded-ratio",
    label: "Excluded Ratio",
    group: "dfm-triangle",
    properties: ["font", "fill"],
    probe: { host: "ratioWrap", table: "ratioMainTable", classes: "cell ratioCell strike" },
  },
  {
    id: "data-value",
    label: "Data Value",
    group: "dfm-triangle",
    properties: ["font", "fill"],
    probe: { host: "ratioWrap", table: "ratioMainTable", classes: "cell ratioDataCell" },
  },
  {
    id: "average",
    label: "Average",
    group: "dfm-averages",
    properties: ["font", "fill"],
    probe: { host: "ratioWrap", table: "ratioSummaryTable", classes: "ratioCell summaryCell" },
  },
  {
    id: "user-entry",
    label: "User Entry",
    group: "dfm-averages",
    properties: ["font", "fill"],
    probe: { host: "ratioWrap", table: "ratioSummaryTable", classes: "ratioCell summaryCell userEntryEditable" },
  },
  {
    id: "excel-linked",
    label: "Excel-Linked Value",
    group: "dfm-averages",
    properties: ["font"],
    probe: { host: "ratioWrap", table: "ratioSummaryTable", classes: "ratioCell summaryCell userEntryEditable excelLinked" },
  },
  {
    id: "excel-link-error",
    label: "Excel Link Error",
    group: "dfm-averages",
    properties: ["font"],
    probe: { host: "ratioWrap", table: "ratioSummaryTable", classes: "ratioCell summaryCell userEntryEditable excelLinked excelLinkError" },
  },
  {
    id: "selected-value",
    label: "Value",
    group: "dfm-selected",
    properties: ["font", "fill"],
    probe: { host: "ratioWrap", table: "ratioSelectedTable", classes: "" },
  },
  {
    id: "column-highlight",
    label: "Column Highlight",
    group: "dfm-ratios",
    properties: ["fill"],
    probe: { host: "ratioWrap", table: "ratioMainTable", classes: "cell ratioCell ratioColActive" },
  },
  {
    id: "placeholder",
    label: "Placeholder Ratio",
    group: "dfm-ratios",
    properties: ["font"],
    probe: { host: "ratioWrap", table: "ratioMainTable", classes: "cell ratioCell ratioPlaceholder" },
    sample: "1.0000",
  },
  {
    id: "value",
    label: "Value",
    group: "tables",
    properties: ["font"],
    variables: { font: "--ar-spreadsheet-cell-text" },
    probe: { classes: "" },
  },
  {
    id: "column-header",
    label: "Column Header",
    group: "tables",
    properties: ["font", "fill"],
    variables: { font: "--ar-spreadsheet-header-text", fill: "--ar-spreadsheet-header-fill" },
    probe: { header: "column" },
    sample: "12-24",
  },
  {
    id: "row-label",
    label: "Row Label",
    group: "tables",
    properties: ["font", "fill"],
    variables: { font: "--ar-spreadsheet-row-label-text", fill: "--ar-spreadsheet-label-fill" },
    probe: { header: "row" },
    sample: "2019",
  },
  {
    // The green a method keeps on what it has chosen: DFM selected averages and
    // Curves picks, BF and Result Selection selected sources, Berquist Sherman
    // selections. Pages without a DFM read the preview from the variables.
    id: "selected-cell",
    label: "Selected Cell",
    group: "tables",
    properties: ["font", "fill"],
    variables: { font: "--ar-spreadsheet-source-selection-text", fill: "--ar-spreadsheet-weighted-selection-fill" },
    probe: { host: "ratioWrap", table: "ratioSummaryTable", classes: "ratioCell summaryCell ratioSelectedCell" },
  },
  {
    id: "highlighted-cell",
    label: "Highlighted Cell",
    group: "tables",
    properties: ["font", "fill"],
    variables: { font: "--ar-spreadsheet-selection-text", fill: "--ar-spreadsheet-selection-fill" },
    probe: { classes: "arSpreadsheetSelected", selected: true },
  },
  {
    id: "highlighted-label",
    label: "Highlighted Label",
    group: "tables",
    properties: ["fill"],
    variables: { fill: "--ar-spreadsheet-selected-label-fill" },
    probe: { header: "row", classes: "arSpreadsheetSelectedLabel" },
    sample: "2019",
  },
  {
    // The yellow a method keeps on its results: BF and CC ultimates, Result
    // Selection's selected ultimate, Bootstrap results, the DFM Curves value.
    id: "result-cell",
    label: "Result Column",
    group: "tables",
    properties: ["font", "fill"],
    variables: { font: "--ar-spreadsheet-result-text", fill: "--ar-spreadsheet-result-fill" },
    probe: null,
  },
  {
    id: "highlighted-result",
    label: "Highlighted Result",
    group: "tables",
    properties: ["font", "fill"],
    variables: { font: "--ar-spreadsheet-result-selection-text", fill: "--ar-spreadsheet-result-selection-fill" },
    probe: null,
  },
  {
    id: "cell-border",
    label: "Cell Border",
    group: "tables",
    properties: ["border", "width"],
    variables: { border: "--ar-spreadsheet-grid-border", width: "--ar-spreadsheet-grid-border-width" },
    probe: { classes: "" },
  },
];

// Soft fills first, then strong text colours, so the grid reads as two rows of
// intent. The fills are the Revolutionary table style's own selection fills.
export const TABLE_COLOR_PRESETS = [
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

const COMPONENTS_BY_ID = new Map(TABLE_COLOR_COMPONENTS.map((component) => [component.id, component]));

export function getTableColorComponent(id) {
  return COMPONENTS_BY_ID.get(String(id || "")) || null;
}

/** The groups shown on `page`: its own, then the ones every table shares. */
export function tableColorGroupsFor(page) {
  return TABLE_COLOR_GROUPS.filter((group) => !group.page || group.page === page);
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (the `#` optional) as lower-case long form; "" for anything else. */
export function normalizeTableColorHex(value) {
  const text = String(value ?? "").trim().replace(/^#/u, "").toLowerCase();
  if (/^[0-9a-f]{3}$/u.test(text)) return `#${text.replace(/./gu, "$&$&")}`;
  if (/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/u.test(text)) return `#${text}`;
  return "";
}

/** A width offered in TABLE_BORDER_WIDTHS as a number; 0 for anything else. */
export function normalizeTableBorderWidth(value) {
  const width = Number.parseInt(String(value ?? ""), 10);
  return TABLE_BORDER_WIDTHS.includes(width) ? width : 0;
}

function normalizeTableColorValue(property, value) {
  return property === "width" ? normalizeTableBorderWidth(value) : normalizeTableColorHex(value);
}

export function findTableColorPreset(hex) {
  const normalized = normalizeTableColorHex(hex);
  return TABLE_COLOR_PRESETS.find((preset) => preset.hex === normalized) || null;
}

/** A clean preference: known components and properties only, valid values only. */
export function normalizeTableColors(raw) {
  const components = {};
  const source = raw && typeof raw === "object" ? raw.components : null;
  for (const component of TABLE_COLOR_COMPONENTS) {
    const entry = source && typeof source === "object" ? source[component.id] : null;
    if (!entry || typeof entry !== "object") continue;
    const colors = {};
    for (const property of component.properties) {
      const value = normalizeTableColorValue(property, entry[property]);
      if (value) colors[property] = value;
    }
    if (Object.keys(colors).length) components[component.id] = colors;
  }
  const fonts = normalizeTableFonts(raw?.fonts);
  return { version: TABLE_COLORS_VERSION, components, ...(Object.keys(fonts).length ? { fonts } : {}) };
}

/** The preference with one value set, or cleared when `value` is empty. */
export function setTableColor(prefs, id, property, value) {
  const next = normalizeTableColors(prefs);
  const component = getTableColorComponent(id);
  if (!component || !component.properties.includes(property)) return next;
  const colors = { ...(next.components[id] || {}) };
  const normalized = normalizeTableColorValue(property, value);
  if (normalized) colors[property] = normalized;
  else delete colors[property];
  next.components = { ...next.components, [id]: colors };
  return normalizeTableColors(next);
}

export function resetTableColorComponent(prefs, id) {
  const next = normalizeTableColors(prefs);
  delete next.components[id];
  return next;
}

/** Resets the components shown on `page`, keeping another page's own colours. */
export function resetTableColorsFor(prefs, page) {
  const shown = new Set(tableColorGroupsFor(page).map((group) => group.id));
  let next = normalizeTableColors(prefs);
  for (const component of TABLE_COLOR_COMPONENTS) {
    if (shown.has(component.group)) next = resetTableColorComponent(next, component.id);
  }
  for (const group of shown) next = resetTableFont(next, group);
  return next;
}

export function tableColorToken(id, property) {
  return `${id}-${property}`;
}

/** The custom property that carries a component's value. */
export function tableColorPropertyName(id, property) {
  return getTableColorComponent(id)?.variables?.[property] || `--ar-table-color-${tableColorToken(id, property)}`;
}

/** The root attribute tokens and custom properties that paint `prefs`. */
export function tableColorCssState(prefs) {
  const normalized = normalizeTableColors(prefs);
  const tokens = [];
  const properties = {};
  for (const component of TABLE_COLOR_COMPONENTS) {
    const colors = normalized.components[component.id];
    if (!colors) continue;
    for (const property of component.properties) {
      if (!colors[property]) continue;
      tokens.push(tableColorToken(component.id, property));
      const value = colors[property];
      properties[tableColorPropertyName(component.id, property)] = property === "width" ? `${value}px` : value;
    }
  }
  for (const group of Object.keys(normalized.fonts || {})) tokens.push(`table-font-${group}`);
  return { tokens, properties };
}
