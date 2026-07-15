export const DETAILS_FORM_LABEL_GAP = "1px";
export const DETAILS_FORM_GROUP_SEPARATION = "1px";
export const DETAILS_FORM_ROW_GAP = "10px";
export const DETAILS_FORM_CONTROL_HEIGHT = "30px";
export const DETAILS_FORM_FONT_FAMILY = 'Arial, "Segoe UI", "SegoeUI", Tahoma, sans-serif';
export const DETAILS_FORM_LABEL_FONT_SIZE = "12px";
export const DETAILS_FORM_CONTROL_FONT_SIZE = "12px";
export const DETAILS_FORM_LABEL_COLOR = "#000000";
export const DETAILS_FORM_CONTROL_COLOR = "#000000";
export const DETAILS_FORM_READONLY_COLOR = "#000000";

export const DETAILS_FORM_PROPERTIES = Object.freeze({
  labelWidth: "--ar-details-label-width",
  labelGap: "--ar-details-label-control-gap",
  groupSeparation: "--ar-details-group-separation",
  rowGap: "--ar-details-row-gap",
  controlHeight: "--ar-details-control-height",
  fontFamily: "--ar-details-font-family",
  labelFontSize: "--ar-details-label-font-size",
  controlFontSize: "--ar-details-control-font-size",
  labelColor: "--ar-details-label-color",
  controlColor: "--ar-details-control-color",
  readonlyColor: "--ar-details-readonly-color",
});

export const DETAILS_FORM_CLASS_NAMES = Object.freeze({
  root: "arDetailsRoot",
  group: "arDetailsGroup",
  grid: "arDetailsGrid",
  label: "arDetailsLabel",
  field: "arDetailsField",
  control: "arDetailsControl",
});

export const DETAILS_FORM_DEFAULT_LABEL_SELECTOR = `.${DETAILS_FORM_CLASS_NAMES.label}`;

function resolveDetailsRoot(root, documentRef) {
  if (typeof root !== "string") return root || null;
  return documentRef?.querySelector?.(root) || null;
}

function setProperty(style, propertyName, value) {
  if (!style?.setProperty || value === null || value === undefined) return;
  style.setProperty(propertyName, String(value));
}

/**
 * Applies the shared Details tokens to a root element without imposing a
 * page-level layout. Consumers opt into the corresponding namespaced CSS
 * classes for groups, grids, labels, fields, and ordinary controls.
 */
export function applyDetailsFormTokens(root, {
  labelWidth = "max-content",
  labelGap = DETAILS_FORM_LABEL_GAP,
  groupSeparation = DETAILS_FORM_GROUP_SEPARATION,
  rowGap = DETAILS_FORM_ROW_GAP,
  controlHeight = DETAILS_FORM_CONTROL_HEIGHT,
  fontFamily = DETAILS_FORM_FONT_FAMILY,
  labelFontSize = DETAILS_FORM_LABEL_FONT_SIZE,
  controlFontSize = DETAILS_FORM_CONTROL_FONT_SIZE,
  labelColor = DETAILS_FORM_LABEL_COLOR,
  controlColor = DETAILS_FORM_CONTROL_COLOR,
  readonlyColor = DETAILS_FORM_READONLY_COLOR,
  documentRef = globalThis.document,
} = {}) {
  const container = resolveDetailsRoot(root, documentRef);
  if (!container?.style?.setProperty) return null;

  setProperty(container.style, DETAILS_FORM_PROPERTIES.labelWidth, labelWidth);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.labelGap, labelGap);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.groupSeparation, groupSeparation);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.rowGap, rowGap);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.controlHeight, controlHeight);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.fontFamily, fontFamily);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.labelFontSize, labelFontSize);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.controlFontSize, controlFontSize);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.labelColor, labelColor);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.controlColor, controlColor);
  setProperty(container.style, DETAILS_FORM_PROPERTIES.readonlyColor, readonlyColor);
  return container;
}

/**
 * Returns the literal authored label text used for width measurement.
 * Punctuation is never generated or appended by this helper.
 */
export function getDetailsLabelText(labelOrText) {
  const raw = typeof labelOrText === "string"
    ? labelOrText
    : labelOrText?.textContent;
  return String(raw ?? "").replace(/\s+/gu, " ").trim();
}

function numericCssValue(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveFont(style = {}) {
  const shorthand = String(style.font || "").trim();
  if (shorthand) return shorthand;
  const weight = String(style.fontWeight || "400").trim() || "400";
  const size = String(style.fontSize || DETAILS_FORM_LABEL_FONT_SIZE).trim()
    || DETAILS_FORM_LABEL_FONT_SIZE;
  const family = String(style.fontFamily || DETAILS_FORM_FONT_FAMILY).trim()
    || DETAILS_FORM_FONT_FAMILY;
  return `${weight} ${size} ${family}`;
}

function createCanvasMeasureText(documentRef) {
  const context = documentRef?.createElement?.("canvas")?.getContext?.("2d");
  if (!context) return null;
  return ({ text, font }) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

/**
 * Measures the widest rendered label and returns an integer CSS-pixel width.
 * `getComputedStyle` and `measureText` may be injected for deterministic tests.
 */
export function measureDetailsLabelWidth(labels, {
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  getComputedStyle = windowRef?.getComputedStyle?.bind(windowRef),
  measureText = null,
} = {}) {
  const labelList = Array.from(labels || []);
  if (!labelList.length || typeof getComputedStyle !== "function") return 0;

  const textMeasurer = typeof measureText === "function"
    ? measureText
    : createCanvasMeasureText(documentRef);
  if (!textMeasurer) return 0;

  let widestLabel = 0;
  for (const label of labelList) {
    const style = getComputedStyle(label) || {};
    const text = getDetailsLabelText(label);
    const font = resolveFont(style);
    const measured = textMeasurer({ text, font, label, style });
    const textWidth = typeof measured === "number" ? measured : Number(measured?.width);
    if (!Number.isFinite(textWidth)) continue;

    const letterSpacing = numericCssValue(style.letterSpacing);
    const horizontalPadding = numericCssValue(style.paddingLeft)
      + numericCssValue(style.paddingRight);
    const measuredWidth = textWidth
      + (letterSpacing * Math.max(0, text.length - 1))
      + horizontalPadding;
    widestLabel = Math.max(widestLabel, measuredWidth);
  }

  return widestLabel > 0 ? Math.ceil(widestLabel) : 0;
}

/**
 * Applies the shared tokens, measures every matching literal label across all
 * Details groups, and writes one common label-column width to the root.
 */
export function syncDetailsLabelWidth({
  root,
  labelSelector = DETAILS_FORM_DEFAULT_LABEL_SELECTOR,
  propertyName = DETAILS_FORM_PROPERTIES.labelWidth,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  getComputedStyle = windowRef?.getComputedStyle?.bind(windowRef),
  measureText = null,
  ...tokenOptions
} = {}) {
  const container = applyDetailsFormTokens(root, { ...tokenOptions, documentRef });
  if (!container?.querySelectorAll || !labelSelector || !propertyName) return null;

  const labels = Array.from(container.querySelectorAll(labelSelector));
  const width = measureDetailsLabelWidth(labels, {
    documentRef,
    windowRef,
    getComputedStyle,
    measureText,
  });
  if (width > 0) setProperty(container.style, propertyName, `${width}px`);

  return {
    root: container,
    labelCount: labels.length,
    width,
    propertyName,
  };
}
