export const DEFAULT_DATASET_NUMBER_FORMAT = "0,000";
export const DATASET_NUMBER_FORMAT_PRESETS = ["0,000", "0.0%", "0,000.00", "0"];

const MAX_FORMAT_LENGTH = 64;

export function clampDatasetDecimalPlaces(value, fallback = 1) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(6, n));
}

export function normalizeDatasetNumberFormat(value, fallback = DEFAULT_DATASET_NUMBER_FORMAT) {
  const text = String(value || "").replace(/[\r\n\t]/g, " ").trim().slice(0, MAX_FORMAT_LENGTH);
  return text || fallback;
}

export function parseDatasetNumberFormat(value) {
  const pattern = normalizeDatasetNumberFormat(value);
  const match = pattern.match(/[0#,]+(?:\.[0#]+)?/);
  if (!match) {
    return {
      pattern: DEFAULT_DATASET_NUMBER_FORMAT,
      prefix: "",
      numberPattern: DEFAULT_DATASET_NUMBER_FORMAT,
      integerPattern: DEFAULT_DATASET_NUMBER_FORMAT,
      fractionPattern: "",
      suffix: "",
      useGrouping: true,
      isPercent: false,
    };
  }
  const numberPattern = match[0];
  const dotIndex = numberPattern.indexOf(".");
  const integerPattern = dotIndex >= 0 ? numberPattern.slice(0, dotIndex) : numberPattern;
  const fractionPattern = dotIndex >= 0 ? numberPattern.slice(dotIndex + 1) : "";
  return {
    pattern,
    prefix: pattern.slice(0, match.index),
    numberPattern,
    integerPattern: integerPattern || "0",
    fractionPattern,
    suffix: pattern.slice(match.index + numberPattern.length),
    useGrouping: integerPattern.includes(","),
    isPercent: pattern.includes("%"),
  };
}

export function getDatasetNumberFormatDecimalPlaces(value) {
  return parseDatasetNumberFormat(value).fractionPattern.length;
}

export function applyDecimalPlacesToDatasetNumberFormat(value, decimalPlaces) {
  const parsed = parseDatasetNumberFormat(value);
  const places = clampDatasetDecimalPlaces(decimalPlaces);
  const numberPattern = places > 0
    ? `${parsed.integerPattern}.${"0".repeat(places)}`
    : parsed.integerPattern;
  return normalizeDatasetNumberFormat(`${parsed.prefix}${numberPattern}${parsed.suffix}`);
}

export function formatDatasetNumberValue(value, numberFormat, decimalPlaces) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  const parsed = parseDatasetNumberFormat(numberFormat);
  const places = clampDatasetDecimalPlaces(decimalPlaces);
  const scaled = parsed.isPercent ? n * 100 : n;
  const formatter = new Intl.NumberFormat("en-US", {
    useGrouping: parsed.useGrouping,
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
  return `${parsed.prefix}${formatter.format(scaled)}${parsed.suffix}`;
}
