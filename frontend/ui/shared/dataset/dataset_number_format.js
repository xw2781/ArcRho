/*
===============================================================================
Dataset number formats - one Excel-compatible pattern engine for every grid.

A pattern is written the way Excel writes one: up to three `;`-separated
sections for positive, negative and zero values, literal text in quotes, a
`[Red]`-style colour, and `#`, `0`, `?`, `.`, `,`, `%` and `E+00` placeholders.

Two deliberate departures from Excel keep the app's own stored patterns
rendering exactly as they always have:

  - The integer part is never zero-padded. Arco's long-standing default
    `0,000` means "grouped thousands", not "four padded digits", so the minimum
    integer width is capped at one digit and `0,000` renders 5 as `5`.
  - Decimal Places is a control of its own on the pages that show one, so an
    explicit decimal count handed to the formatter wins over the pattern - but
    only for a pattern whose fraction is fixed. A pattern with optional `#` or
    `?` fraction digits keeps its own rule.
===============================================================================
*/
export const DEFAULT_DATASET_NUMBER_FORMAT = "0,000";
export const DATASET_NUMBER_FORMAT_PRESETS = ["0,000", "0.0%", "0,000.00", "0"];
// The default pattern carries no decimal point, and the server's shared
// number-format settings default to none either, so a dataset that says
// nothing must not read back with a decimal place it never had.
export const DEFAULT_DATASET_DECIMAL_PLACES = 0;

const MAX_FORMAT_LENGTH = 64;

// Excel's eight named colours, each resolved through a theme token so a red
// negative stays readable on the dark canvas.
const NUMBER_FORMAT_COLORS = {
  black: "var(--ar-number-format-black, #111827)",
  blue: "var(--ar-number-format-blue, #2563eb)",
  cyan: "var(--ar-number-format-cyan, #0891b2)",
  green: "var(--ar-number-format-green, #15803d)",
  magenta: "var(--ar-number-format-magenta, #c026d3)",
  red: "var(--ar-number-format-red, #be123c)",
  white: "var(--ar-number-format-white, #ffffff)",
  yellow: "var(--ar-number-format-yellow, #ca8a04)",
};

export function clampDatasetDecimalPlaces(value, fallback = DEFAULT_DATASET_DECIMAL_PLACES) {
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

// Every section is rewritten, so nudging Decimal Places on a two-section
// pattern such as `#,##0;(#,##0)` cannot leave the two halves disagreeing.
// `resq_migration/number_formats.apply_decimal_places_to_number_format` mirrors
// this, and the two must keep producing the same text.
export function applyDecimalPlacesToDatasetNumberFormat(value, decimalPlaces) {
  const places = clampDatasetDecimalPlaces(decimalPlaces);
  const rebuilt = splitDatasetNumberFormatSections(normalizeDatasetNumberFormat(value))
    .map((section) => applyDecimalPlacesToSection(section, places))
    .join(";");
  return normalizeDatasetNumberFormat(rebuilt);
}

function applyDecimalPlacesToSection(section, places) {
  const match = section.match(/[0#,]+(?:\.[0#?]+)?/);
  if (!match) return section;
  const numberPattern = match[0];
  const dotIndex = numberPattern.indexOf(".");
  const integerPattern = (dotIndex >= 0 ? numberPattern.slice(0, dotIndex) : numberPattern) || "0";
  const rebuilt = places > 0 ? `${integerPattern}.${"0".repeat(places)}` : integerPattern;
  return `${section.slice(0, match.index)}${rebuilt}${section.slice(match.index + numberPattern.length)}`;
}

/* --- the pattern engine --------------------------------------------------- */

// Splitting skips quoted text, escapes and bracketed blocks, because each of
// them may legitimately carry a `;`.
export function splitDatasetNumberFormatSections(pattern) {
  const sections = [];
  let current = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "\\") {
      current += ch + (pattern[i + 1] ?? "");
      i += 1;
    } else if (ch === '"' || ch === "[") {
      const end = pattern.indexOf(ch === '"' ? '"' : "]", i + 1);
      const stop = end < 0 ? pattern.length - 1 : end;
      current += pattern.slice(i, stop + 1);
      i = stop;
    } else if (ch === ";") {
      sections.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  sections.push(current);
  return sections;
}

function compileSection(text) {
  const tokens = [];
  let color = "";
  let percentCount = 0;
  let digits = "";
  let scientific = null;
  let numberPlaced = false;

  const pushLiteral = (s) => {
    if (!s) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === "literal") last.text += s;
    else tokens.push({ type: "literal", text: s });
  };
  const pushNumber = () => {
    if (numberPlaced) return;
    numberPlaced = true;
    tokens.push({ type: "number" });
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      pushLiteral(text[i + 1] ?? "");
      i += 1;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      pushLiteral(end < 0 ? text.slice(i + 1) : text.slice(i + 1, end));
      i = end < 0 ? text.length : end;
    } else if (ch === "_") {
      // Reserve the width of the next character; one space is as close as a
      // proportional grid gets.
      pushLiteral(" ");
      i += 1;
    } else if (ch === "*") {
      // Repeat-to-fill has no meaning in a fixed-width cell.
      i += 1;
    } else if (ch === "[") {
      const end = text.indexOf("]", i + 1);
      const body = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end < 0 ? text.length : end;
      const named = NUMBER_FORMAT_COLORS[body.trim().toLowerCase()];
      if (named) color = named;
      else if (body.startsWith("$")) pushLiteral(body.slice(1).split("-")[0]);
    } else if (ch === "%") {
      percentCount += 1;
      pushLiteral("%");
    } else if (ch === "@") {
      tokens.push({ type: "text" });
    } else if (ch === "#" || ch === "0" || ch === "?" || ch === "." || ch === ",") {
      pushNumber();
      digits += ch;
    } else if ((ch === "E" || ch === "e") && (text[i + 1] === "+" || text[i + 1] === "-")) {
      let j = i + 2;
      let count = 0;
      while (j < text.length && (text[j] === "0" || text[j] === "#")) {
        count += 1;
        j += 1;
      }
      if (count > 0) {
        scientific = { sign: text[i + 1], digits: count };
        i = j - 1;
      } else {
        pushLiteral(ch);
      }
    } else {
      pushLiteral(ch);
    }
  }

  return { tokens, color, percentCount, scientific, ...compileDigits(digits) };
}

function compileDigits(raw) {
  let text = raw;
  let scale = 1;
  while (text.endsWith(",")) {
    scale /= 1000;
    text = text.slice(0, -1);
  }
  const dotIndex = text.indexOf(".");
  const integerText = dotIndex >= 0 ? text.slice(0, dotIndex) : text;
  const fractionPart = dotIndex >= 0 ? text.slice(dotIndex + 1).replace(/,/g, "") : "";
  return {
    hasDigits: text.length > 0,
    // Capped at one: ArcRho's own `0,000` must not start padding to four digits.
    minInteger: Math.min(1, (integerText.match(/0/g) || []).length),
    integerPad: (integerText.match(/\?/g) || []).length,
    fractionSpec: fractionPart,
    fractionMin: (fractionPart.match(/[0?]/g) || []).length,
    fractionMax: fractionPart.length,
    useGrouping: integerText.includes(","),
    scale,
  };
}

const compiledFormats = new Map();

function compileFormat(pattern) {
  const cached = compiledFormats.get(pattern);
  if (cached) return cached;
  const isGeneral = pattern.trim().toLowerCase() === "general";
  const compiled = {
    isGeneral,
    sections: isGeneral ? [] : splitDatasetNumberFormatSections(pattern).map(compileSection),
  };
  if (compiledFormats.size > 200) compiledFormats.clear();
  compiledFormats.set(pattern, compiled);
  return compiled;
}

// Sections read positive; negative; zero. With only one section that section
// carries the sign itself; with no zero section the positive one serves.
function pickSection(compiled, value) {
  const sections = compiled.sections;
  if (sections.length <= 1) return { section: sections[0], signed: true };
  if (value < 0) return { section: sections[1], signed: false };
  if (value === 0 && sections[2]) return { section: sections[2], signed: false };
  return { section: sections[0], signed: false };
}

function groupInteger(text, useGrouping) {
  if (!useGrouping) return text;
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Optional fraction digits fall away from the right: `#` disappears and `?`
// leaves the space it reserved.
function trimFraction(fraction, spec, minimum) {
  let text = fraction;
  for (let i = text.length - 1; i >= minimum; i -= 1) {
    if (text[i] !== "0") break;
    text = spec[i] === "?" ? `${text.slice(0, i)} ` : text.slice(0, i);
  }
  return text;
}

function renderDigits(value, section, places) {
  const fixed = Math.abs(value).toFixed(places);
  const dotIndex = fixed.indexOf(".");
  const integer = dotIndex >= 0 ? fixed.slice(0, dotIndex) : fixed;
  const fraction = dotIndex >= 0 ? fixed.slice(dotIndex + 1) : "";
  let head = section.minInteger === 0 && integer === "0" ? "" : integer;
  head = groupInteger(head, section.useGrouping);
  if (section.integerPad > head.length) head = " ".repeat(section.integerPad - head.length) + head;
  const tail = trimFraction(fraction, section.fractionSpec, section.fractionMin);
  return tail ? `${head}.${tail}` : head;
}

function renderScientific(value, section, places) {
  const abs = Math.abs(value);
  let exponent = abs === 0 ? 0 : Math.floor(Math.log10(abs));
  let mantissa = abs === 0 ? 0 : abs / 10 ** exponent;
  if (Number.parseFloat(mantissa.toFixed(places)) >= 10) {
    mantissa /= 10;
    exponent += 1;
  }
  const sign = exponent < 0 ? "-" : (section.scientific.sign === "+" ? "+" : "");
  const exponentText = String(Math.abs(exponent)).padStart(section.scientific.digits, "0");
  return `${mantissa.toFixed(places)}E${sign}${exponentText}`;
}

function generalNumberText(value) {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e11 || abs < 1e-10) return value.toExponential(5).toUpperCase();
  return String(Number(value.toPrecision(11)));
}

// An explicit Decimal Places control owns a fixed fraction and nothing else, so
// `#,##0.##` keeps its own optional digits.
function sectionDecimalPlaces(section, decimalPlaces) {
  const asked = Number(decimalPlaces);
  if (section.fractionMin === section.fractionMax && Number.isFinite(asked)) {
    return clampDatasetDecimalPlaces(asked);
  }
  return section.fractionMax;
}

function renderSection(value, section, decimalPlaces, signed) {
  if (!section) return "";
  const scaled = value * section.scale * 100 ** section.percentCount;
  const places = sectionDecimalPlaces(section, decimalPlaces);
  const body = section.scientific
    ? renderScientific(scaled, section, places)
    : renderDigits(scaled, section, places);
  let out = "";
  for (const token of section.tokens) {
    if (token.type === "literal") out += token.text;
    else if (token.type === "number") out += body;
    else if (token.type === "text") out += generalNumberText(scaled);
  }
  if (!signed || !section.hasDigits) return out;
  // A value that rounds away to zero must not keep a minus sign in front of it.
  const rounded = Number.parseFloat(Math.abs(scaled).toFixed(places));
  return scaled < 0 && (rounded !== 0 || section.scientific) ? `-${out}` : out;
}

export function formatDatasetNumberValue(value, numberFormat, decimalPlaces) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  const compiled = compileFormat(normalizeDatasetNumberFormat(numberFormat));
  if (compiled.isGeneral) return generalNumberText(n);
  const { section, signed } = pickSection(compiled, n);
  return renderSection(n, section, decimalPlaces, signed);
}

// The colour a `[Red]`-style section asks for, or an empty string. It is kept
// apart from the rendered text so a caller that paints cells can use it and one
// that only needs characters can ignore it.
export function datasetNumberValueColor(value, numberFormat) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  const compiled = compileFormat(normalizeDatasetNumberFormat(numberFormat));
  if (compiled.isGeneral) return "";
  return pickSection(compiled, n).section?.color || "";
}
