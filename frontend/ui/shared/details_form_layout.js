export const DETAILS_FORM_LABEL_GAP = "5px";
export const DETAILS_FORM_FONT_FAMILY = 'Arial, "Segoe UI", "SegoeUI", Tahoma, sans-serif';
export const DETAILS_FORM_LABEL_FONT_SIZE = "12px";
export const DETAILS_FORM_CONTROL_FONT_SIZE = "12px";
export const DETAILS_FORM_LABEL_COLOR = "#000000";
export const DETAILS_FORM_CONTROL_COLOR = "#000000";
export const DETAILS_FORM_READONLY_COLOR = "#000000";

export function applyDetailsFormStyle(root, {
  labelGap = DETAILS_FORM_LABEL_GAP,
  fontFamily = DETAILS_FORM_FONT_FAMILY,
  labelFontSize = DETAILS_FORM_LABEL_FONT_SIZE,
  controlFontSize = DETAILS_FORM_CONTROL_FONT_SIZE,
  labelColor = DETAILS_FORM_LABEL_COLOR,
  controlColor = DETAILS_FORM_CONTROL_COLOR,
  readonlyColor = DETAILS_FORM_READONLY_COLOR,
} = {}) {
  if (typeof document === "undefined") return null;
  const container = typeof root === "string" ? document.querySelector(root) : root;
  if (!container) return null;
  container.style.setProperty("--details-form-label-gap", labelGap);
  container.style.setProperty("--details-form-font-family", fontFamily);
  container.style.setProperty("--details-form-label-font-size", labelFontSize);
  container.style.setProperty("--details-form-control-font-size", controlFontSize);
  container.style.setProperty("--details-form-label-color", labelColor);
  container.style.setProperty("--details-form-control-color", controlColor);
  container.style.setProperty("--details-form-readonly-color", readonlyColor);
  return container;
}

export function applyDetailsFormSpacing(root, labelGap = DETAILS_FORM_LABEL_GAP) {
  return applyDetailsFormStyle(root, { labelGap });
}

export function syncDetailsLabelWidth({
  root,
  labelSelector,
  propertyName,
  labelGap = DETAILS_FORM_LABEL_GAP,
  fontFamily = DETAILS_FORM_FONT_FAMILY,
}) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const container = applyDetailsFormStyle(root, { labelGap, fontFamily });
  if (!container || !labelSelector || !propertyName || typeof window.getComputedStyle !== "function") return;

  const labels = container.querySelectorAll(labelSelector);
  if (!labels.length) return;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;

  let widestLabel = 0;
  labels.forEach((label) => {
    const style = window.getComputedStyle(label);
    const text = label.textContent?.trim() || "";
    context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

    const letterSpacing = Number.parseFloat(style.letterSpacing);
    const horizontalPadding = Number.parseFloat(style.paddingLeft || "0")
      + Number.parseFloat(style.paddingRight || "0");
    const measuredWidth = context.measureText(text).width
      + (Number.isFinite(letterSpacing) ? letterSpacing * Math.max(0, text.length - 1) : 0)
      + horizontalPadding;

    widestLabel = Math.max(widestLabel, measuredWidth);
  });

  if (widestLabel > 0) {
    container.style.setProperty(propertyName, `${Math.ceil(widestLabel)}px`);
  }
}
