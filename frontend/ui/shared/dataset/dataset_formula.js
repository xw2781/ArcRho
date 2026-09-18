/*
===============================================================================
Dataset Formula
One grammar for everything a Dataset grid cell accepts after "=": a standalone
Excel link, a standalone Arco dataset link, or a formula with arithmetic,
comparisons, functions, and any mix of references and numbers:

    ='C:\Folder\[Book.xlsx]Sheet1'!A1:A7
    =[C 82 - Prior Qtr Selected][1:7]
    =[C 82 - Prior Qtr Selected][1:7] * 2
    =([Paid Claims][1:6, 2] + 'C:\Folder\[Book.xlsx]Sheet1'!B1:B6) / 1000

Arithmetic follows Excel's array rules: a reference to a range is a matrix, a
scalar combines with every cell of a matrix, and two matrices combine cell by
cell, with a one-row or one-column matrix stretched across the other's shape.

`classifyDatasetFormula` decides which of the three kinds a draft is, so the
grid routes a standalone link to its own controller (whose per-cell mapping and
retargeting must survive) and everything else to the formula-link controller.
`arcrho_api/dataset_link_contract.py` owns the grammar metadata and server
evaluator; generated metadata and cross-runtime tests keep this adapter aligned.
===============================================================================
*/
import {
  formatExcelReference,
  parseExcelReference,
} from "/ui/shared/integrations/excel_reference.js?v=20260715a";
import {
  INTERNAL_REFERENCE_SYNTAX_HINT,
  formatInternalDatasetReference,
  parseInternalDatasetReference,
} from "/ui/shared/dataset/dataset_internal_reference.js?v=20260830a";

export const DATASET_FORMULA_SYNTAX_HINT =
  "Enter an Excel link such as ='C:\\Folder\\[Book.xlsx]Sheet1'!A1:C3, a dataset "
  + "link such as =[Dataset][1:6], or a formula that combines them with + - * / ^, "
  + "or use IF, IFERROR, SUM, MAX, MIN, MEDIAN, AVERAGE, COUNT, ABS, ROUND, TAKE, INDEX, TRANSPOSE, or Arco dataset functions.";

const EXCEL_TOKEN_RE = /'((?:[^']|'')*)'!\$?[A-Z]+\$?[0-9]+(?::\$?[A-Z]+\$?[0-9]+)?/iy;
const NUMBER_TOKEN_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
// BEGIN GENERATED FORMULA METADATA
// Owner: arcrho_api.dataset_link_contract; generate_dataset_formula_metadata.py --write.
const BINARY_PRECEDENCE = {"=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "+": 2, "-": 2, "*": 3, "/": 3, "^": 4};
export const FORMULA_FUNCTION_ARITY = {"IF": [2, 3], "IFERROR": [2, 2], "SUM": [1, 255], "MAX": [1, 255], "MIN": [1, 255], "MEDIAN": [1, 255], "AVERAGE": [1, 255], "COUNT": [1, 255], "ABS": [1, 1], "ROUND": [1, 2], "TAKE": [2, 3], "INDEX": [2, 3], "TRANSPOSE": [1, 1]};
export const FORMULA_FUNCTION_ARGUMENTS = {"IF": ["logical_test", "value_if_true", "[value_if_false]"], "IFERROR": ["value", "value_if_error"], "SUM": ["number1", "[number2, \u2026]"], "MAX": ["number1", "[number2, \u2026]"], "MIN": ["number1", "[number2, \u2026]"], "MEDIAN": ["number1", "[number2, \u2026]"], "AVERAGE": ["number1", "[number2, \u2026]"], "COUNT": ["number1", "[number2, \u2026]"], "ABS": ["number"], "ROUND": ["number", "[num_digits]"], "TAKE": ["array", "rows", "[columns]"], "INDEX": ["array", "row_num", "[column_num]"], "TRANSPOSE": ["array"]};
export const ARCRHO_FORMULA_FUNCTIONS = {"ARCOTRI": {"name": "ArcoTri", "minimum": 2, "arguments": [{"name": "Path", "optional": false, "default": null}, {"name": "TriangleName", "optional": false, "default": null}, {"name": "Cumulative", "optional": true, "default": true}, {"name": "Transposed", "optional": true, "default": false}, {"name": "Calendar", "optional": true, "default": false}, {"name": "ProjectName", "optional": true, "default": "Default"}, {"name": "OriginLength", "optional": true, "default": 12}, {"name": "DevelopmentLength", "optional": true, "default": 12}, {"name": "ByTypeName", "optional": true, "default": null}, {"name": "SuppressWarnings", "optional": true, "default": null}]}, "ARCOTRIDIAG": {"name": "ArcoTriDiag", "minimum": 2, "arguments": [{"name": "Path", "optional": false, "default": null}, {"name": "TriangleName", "optional": false, "default": null}, {"name": "DiagonalIndex", "optional": true, "default": 0}, {"name": "Cumulative", "optional": true, "default": true}, {"name": "Transposed", "optional": true, "default": false}, {"name": "ProjectName", "optional": true, "default": "Default"}, {"name": "OriginLength", "optional": true, "default": 12}, {"name": "DevelopmentLength", "optional": true, "default": 12}, {"name": "ByTypeName", "optional": true, "default": null}, {"name": "SuppressWarnings", "optional": true, "default": null}]}, "ARCOTRICELL": {"name": "ArcoTriCell", "minimum": 4, "arguments": [{"name": "Path", "optional": false, "default": null}, {"name": "TriangleName", "optional": false, "default": null}, {"name": "OriginPeriod", "optional": false, "default": null}, {"name": "DevelopmentPeriod", "optional": false, "default": null}, {"name": "Cumulative", "optional": true, "default": true}, {"name": "ProjectName", "optional": true, "default": "Default"}, {"name": "OriginLength", "optional": true, "default": 12}, {"name": "DevelopmentLength", "optional": true, "default": 12}, {"name": "ByTypeName", "optional": true, "default": null}, {"name": "SuppressWarnings", "optional": true, "default": null}]}, "ARCOTRIORIGIN": {"name": "ArcoTriOrigin", "minimum": 3, "arguments": [{"name": "Path", "optional": false, "default": null}, {"name": "TriangleName", "optional": false, "default": null}, {"name": "OriginPeriod", "optional": false, "default": null}, {"name": "Cumulative", "optional": true, "default": true}, {"name": "Transposed", "optional": true, "default": false}, {"name": "ProjectName", "optional": true, "default": "Default"}, {"name": "OriginLength", "optional": true, "default": 12}, {"name": "DevelopmentLength", "optional": true, "default": 12}, {"name": "ByTypeName", "optional": true, "default": null}, {"name": "SuppressWarnings", "optional": true, "default": null}]}, "ARCOVEC": {"name": "ArcoVec", "minimum": 2, "arguments": [{"name": "Path", "optional": false, "default": null}, {"name": "VectorName", "optional": false, "default": null}, {"name": "Transposed", "optional": true, "default": false}, {"name": "ProjectName", "optional": true, "default": "Default"}, {"name": "PeriodLength", "optional": true, "default": 12}, {"name": "ByTypeName", "optional": true, "default": null}, {"name": "SuppressWarnings", "optional": true, "default": null}]}, "ARCOVECCELL": {"name": "ArcoVecCell", "minimum": 3, "arguments": [{"name": "Path", "optional": false, "default": null}, {"name": "VectorName", "optional": false, "default": null}, {"name": "Index", "optional": false, "default": null}, {"name": "ProjectName", "optional": true, "default": "Default"}, {"name": "PeriodLength", "optional": true, "default": 12}, {"name": "ByTypeName", "optional": true, "default": null}, {"name": "SuppressWarnings", "optional": true, "default": null}]}};
// END GENERATED FORMULA METADATA

function invalid(error) {
  return { ok: false, error };
}

/** Excel add-in calls are source references; their arguments are literal inputs. */
export function findArcRhoFormulaReferences(text) {
  const references = [];
  let quote = "";
  for (let start = 0; start < text.length; start += 1) {
    const char = text[start];
    if (quote) {
      if (char === quote) {
        if (text[start + 1] === quote) start += 1;
        else quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "[") { const end = text.indexOf("]", start); if (end < 0) break; start = end; continue; }
    if (start && /[\w]/.test(text[start - 1])) continue;
    const call = /^([A-Za-z_][A-Za-z_0-9]*)\s*\(/.exec(text.slice(start));
    const spec = call && ARCRHO_FORMULA_FUNCTIONS[call[1].toUpperCase()];
    if (!spec) continue;
    let cursor = start + call[0].length, quoted = false, current = "";
    const parts = [];
    for (; cursor < text.length; cursor += 1) {
      const ch = text[cursor];
      if (ch === '"') {
        current += ch;
        if (quoted && text[cursor + 1] === '"') { current += '"'; cursor += 1; }
        else quoted = !quoted;
      } else if (!quoted && [",", ")"].includes(ch)) {
        parts.push(current.trim()); current = "";
        if (ch === ")") break;
      } else current += ch;
    }
    if (cursor === text.length) throw new Error("Arco dataset function is missing its closing quote or parenthesis.");
    if (parts.length < spec.minimum || parts.length > spec.arguments.length) throw new Error(`Wrong number of arguments for ${spec.name}.`);
    const args = {};
    spec.arguments.forEach((arg, i) => {
      const raw = parts[i] || "";
      let value = arg.default;
      if (!raw && !arg.optional && arg.name !== "Path") throw new Error(`${arg.name} is required.`);
      if (/^"(?:[^"]|"")*"$/.test(raw)) value = raw.slice(1, -1).replaceAll('""', '"');
      else if (/^(TRUE|FALSE)$/i.test(raw)) value = raw.toUpperCase() === "TRUE";
      else if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) value = Number(raw);
      else if (raw) throw new Error(`${arg.name} needs quoted text, a number, TRUE or FALSE.`);
      args[arg.name] = value;
    });
    const datasetName = String(args.TriangleName ?? args.VectorName ?? "").trim().replace(/\s+/g, " ");
    if (!datasetName) throw new Error("Dataset name is required.");
    references.push({ name: call[1].toUpperCase(), arguments: args, datasetName, canonical: `${spec.name}(${parts.join(", ")})`, match: text.slice(start, cursor + 1), start, end: cursor + 1 });
    start = cursor;
  }
  return references;
}

/** End index (exclusive) of the `[name][coords]` reference starting at `start`, or -1. */
function scanInternalReference(text, start) {
  const nameEnd = text.indexOf("]", start + 1);
  if (nameEnd < 0) return -1;
  let cursor = nameEnd + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  if (text[cursor] !== "[") return -1;
  let quote = "";
  for (let index = cursor + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "]") return index + 1;
  }
  return -1;
}

/**
 * Split formula text into typed tokens. Returns `{ok: true, tokens}` or
 * `{ok: false, error}`; the grammar is checked by `parseDatasetFormula`.
 */
export function tokenizeDatasetFormula(rawText) {
  let text = String(rawText ?? "").trim();
  if (text.startsWith("=")) text = text.slice(1);
  const tokens = [];
  let calls;
  try { calls = new Map(findArcRhoFormulaReferences(text).map(call => [call.start, call])); }
  catch (error) { return invalid(error.message); }
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (calls.has(cursor)) {
      const parsed = calls.get(cursor);
      tokens.push({ type: "reference", kind: "arcrho", text: parsed.match, canonical: parsed.canonical, parsed });
      cursor = parsed.end;
      continue;
    }
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "[") {
      const end = scanInternalReference(text, cursor);
      if (end < 0) {
        return invalid(`Dataset reference is missing its coordinates. ${INTERNAL_REFERENCE_SYNTAX_HINT}`);
      }
      const referenceText = text.slice(cursor, end);
      const parsed = parseInternalDatasetReference(referenceText);
      if (!parsed.ok) return invalid(parsed.error);
      tokens.push({
        type: "reference",
        kind: "internal",
        text: referenceText,
        canonical: formatInternalDatasetReference(parsed).slice(1),
        parsed,
      });
      cursor = end;
      continue;
    }
    if (character === "'") {
      EXCEL_TOKEN_RE.lastIndex = cursor;
      const match = EXCEL_TOKEN_RE.exec(text);
      const parsed = match ? parseExcelReference(match[0]) : null;
      if (!parsed) {
        return invalid(
          "Excel reference must be written as 'C:\\Folder\\[Book.xlsx]Sheet1'!A1 or a range such as !A1:C3.",
        );
      }
      tokens.push({
        type: "reference",
        kind: "excel",
        text: match[0],
        canonical: formatExcelReference(parsed.bookPath, parsed.sheet, parsed.cell, parsed.endCell).slice(1),
        parsed,
      });
      cursor = EXCEL_TOKEN_RE.lastIndex;
      continue;
    }
    NUMBER_TOKEN_RE.lastIndex = cursor;
    const number = NUMBER_TOKEN_RE.exec(text);
    if (number) {
      tokens.push({ type: "number", text: number[0], value: Number(number[0]) });
      cursor = NUMBER_TOKEN_RE.lastIndex;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(cursor));
    if (identifier) {
      const name = identifier[0].toUpperCase();
      tokens.push(name === "TRUE" || name === "FALSE"
        ? { type: "number", text: name, value: name === "TRUE" ? 1 : 0 }
        : { type: "function", text: name });
      cursor += identifier[0].length;
      continue;
    }
    if (text.slice(cursor, cursor + 2) === '""') {
      tokens.push({ type: "blank", text: '""' });
      cursor += 2;
      continue;
    }
    if (character === ",") {
      tokens.push({ type: "comma", text: character });
      cursor += 1;
      continue;
    }
    if ("{};".includes(character)) {
      tokens.push({ type: "array", text: character });
      cursor += 1;
      continue;
    }
    const comparison = /^(<=|>=|<>|=|<|>)/.exec(text.slice(cursor));
    if (comparison) {
      tokens.push({ type: "operator", text: comparison[0] });
      cursor += comparison[0].length;
      continue;
    }
    if ("+-*/^".includes(character)) {
      tokens.push({ type: "operator", text: character });
      cursor += 1;
      continue;
    }
    if (character === "(" || character === ")") {
      tokens.push({ type: "paren", text: character });
      cursor += 1;
      continue;
    }
    return invalid(`Unexpected "${character}" in the formula. ${DATASET_FORMULA_SYNTAX_HINT}`);
  }
  if (!tokens.length) return invalid(DATASET_FORMULA_SYNTAX_HINT);
  return { ok: true, tokens };
}

/**
 * Parse tokens into an expression tree, marking each unary minus token so the
 * canonical text can print it without surrounding spaces.
 */
function parseExpression(tokens) {
  let position = 0;
  const peek = () => tokens[position];
  const fail = (error) => {
    throw new Error(error);
  };

  function parseBinary(minPrecedence) {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token?.type !== "operator") break;
      const precedence = BINARY_PRECEDENCE[token.text];
      if (precedence < minPrecedence) break;
      position += 1;
      // "^" binds to the right, as it does in Excel.
      const right = parseBinary(token.text === "^" ? precedence : precedence + 1);
      left = { kind: "binary", operator: token.text, left, right };
    }
    return left;
  }

  function parseUnary() {
    const token = peek();
    if (token?.type === "operator" && (token.text === "-" || token.text === "+")) {
      token.unary = true;
      position += 1;
      const operand = parseUnary();
      return token.text === "-" ? { kind: "unary", operator: "-", operand } : operand;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (!token) fail("The formula ends before its last operand.");
    if (token.type === "number") {
      position += 1;
      return { kind: "number", value: token.value };
    }
    if (token.type === "blank") {
      position += 1;
      return { kind: "number", value: null };
    }
    if (token.text === "{") {
      position += 1;
      const rows = [[]];
      for (;;) {
        rows.at(-1).push(parseBinary(1));
        if (![",", ";"].includes(peek()?.text)) break;
        if (peek().text === ";") rows.push([]);
        position += 1;
      }
      if (peek()?.text !== "}") fail("Array is missing its closing brace.");
      position += 1;
      if (rows.some(row => row.length !== rows[0].length)) fail("Array rows must have the same length.");
      return { kind: "array", rows };
    }
    if (token.type === "function") {
      const limits = FORMULA_FUNCTION_ARITY[token.text];
      if (!limits) fail(`Unknown function "${token.text}".`);
      position += 1;
      if (peek()?.text !== "(") fail(`Expected ( after ${token.text}.`);
      position += 1;
      const args = [];
      if (peek()?.text !== ")") {
        for (;;) {
          args.push([",", ")"].includes(peek()?.text) ? { kind: "omitted" } : parseBinary(1));
          if (peek()?.type !== "comma") break;
          position += 1;
        }
      }
      if (peek()?.text !== ")") fail("The function is missing a closing parenthesis.");
      position += 1;
      if (args.length < limits[0] || args.length > limits[1]) fail(`Wrong number of arguments for ${token.text}.`);
      if (!["TAKE", "INDEX"].includes(token.text) && args.some(arg => arg.kind === "omitted")) fail(`Missing argument for ${token.text}.`);
      return { kind: "function", name: token.text, args };
    }
    if (token.type === "reference") {
      position += 1;
      return { kind: "reference", token };
    }
    if (token.type === "paren" && token.text === "(") {
      position += 1;
      const inner = parseBinary(1);
      if (peek()?.type !== "paren" || peek().text !== ")") fail("The formula is missing a closing parenthesis.");
      position += 1;
      return inner;
    }
    fail(`Unexpected "${token.text}" in the formula.`);
    return null;
  }

  const tree = parseBinary(1);
  if (position < tokens.length) fail(`Unexpected "${tokens[position].text}" in the formula.`);
  return tree;
}

/**
 * Parse a formula. Returns `{ok: true, tokens, tree, references, canonical}`
 * where `references` lists each distinct reference token once in formula
 * order, or `{ok: false, error}`.
 */
export function parseDatasetFormula(rawText) {
  const tokenized = tokenizeDatasetFormula(rawText);
  if (!tokenized.ok) return tokenized;
  const { tokens } = tokenized;
  let tree;
  try {
    tree = parseExpression(tokens);
  } catch (error) {
    return invalid(`${error.message} ${DATASET_FORMULA_SYNTAX_HINT}`);
  }
  const references = [];
  const seen = new Set();
  for (const token of tokens) {
    if (token.type !== "reference") continue;
    const key = `${token.kind}\u001f${token.canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(token);
  }
  return { ok: true, tokens, tree, references, canonical: formatDatasetFormula(tokens) };
}

/** Canonical stored text: `=` plus every token in its normalized spelling. */
export function formatDatasetFormula(tokens) {
  let out = "";
  for (const token of tokens) {
    if (token.type === "operator") {
      if (token.unary) out += token.text;
      else out = `${out.trimEnd()} ${token.text} `;
    } else if (token.type === "paren") {
      out = token.text === "(" ? `${out}(` : `${out.trimEnd()})`;
    } else if (token.type === "comma") {
      out = `${out.trimEnd()}, `;
    } else if (token.type === "reference") {
      out += token.canonical;
    } else {
      out += token.text;
    }
  }
  return `=${out.trimEnd()}`;
}

/**
 * Which of the three kinds a draft is: `excel` or `internal` for one standalone
 * link, `formula` for a supported expression, or
 * `invalid` with the message to show.
 */
export function classifyDatasetFormula(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return { kind: "invalid", error: DATASET_FORMULA_SYNTAX_HINT };
  if (parseExcelReference(text)) return { kind: "excel", reference: text };
  if (parseInternalDatasetReference(text).ok) return { kind: "internal", reference: text };
  const parsed = parseDatasetFormula(text);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  return { kind: "formula", ...parsed };
}

function scalarMatrix(value) {
  return { rows: 1, cols: 1, values: [[value]] };
}

function cellAt(matrix, row, col) {
  return matrix.values[matrix.rows === 1 ? 0 : row][matrix.cols === 1 ? 0 : col];
}

function numeric(value) {
  if (value instanceof Error) throw value;
  const number = value == null || value === "" ? 0 : Number(value);
  if (!Number.isFinite(number)) throw new Error("The formula produced a value that is not a finite number.");
  return number;
}

function mapMatrices(matrices, calculate) {
  let rows = 1;
  let cols = 1;
  for (const matrix of matrices) {
    if ((rows !== matrix.rows && rows !== 1 && matrix.rows !== 1)
      || (cols !== matrix.cols && cols !== 1 && matrix.cols !== 1)) {
      throw new Error(`Array sizes do not match (${rows}x${cols} and ${matrix.rows}x${matrix.cols}).`);
    }
    rows = Math.max(rows, matrix.rows);
    cols = Math.max(cols, matrix.cols);
  }
  const values = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    try {
      return calculate(...matrices.map((matrix) => cellAt(matrix, r, c)));
    } catch (error) {
      return error;
    }
  }));
  return { rows, cols, values };
}

function combine(left, right, operator) {
  return mapMatrices([left, right], (rawA, rawB) => {
    const a = numeric(rawA);
    const b = numeric(rawB);
    let result;
    if (operator === "+") result = a + b;
    else if (operator === "-") result = a - b;
    else if (operator === "*") result = a * b;
    else if (operator === "/") {
      if (b === 0) throw new Error("The formula divides by zero.");
      result = a / b;
    } else if (operator === "=") result = Number(a === b);
    else if (operator === "<>") result = Number(a !== b);
    else if (operator === "<") result = Number(a < b);
    else if (operator === ">") result = Number(a > b);
    else if (operator === "<=") result = Number(a <= b);
    else if (operator === ">=") result = Number(a >= b);
    else result = a ** b;
    return numeric(result);
  });
}

/** Evaluate numeric formulas with per-cell errors, so IF/IFERROR can select safe results. */
export function evaluateDatasetFormula(tree, lookup, { round } = {}) {
  function call(node) {
    const args = node.args;
    if (node.name === "IFERROR") {
      const value = visit(args[0]);
      if (!value.values.some((row) => row.some((cell) => cell instanceof Error))) return value;
      return mapMatrices([value, visit(args[1])], (cell, fallback) => cell instanceof Error ? fallback : cell);
    }
    if (node.name === "IF") {
      const condition = visit(args[0]);
      const cells = condition.values.flat();
      const choose = (yes) => yes ? visit(args[1]) : (args[2] ? visit(args[2]) : scalarMatrix(0));
      if (cells.every((cell) => !(cell instanceof Error) && numeric(cell) !== 0)) {
        return mapMatrices([condition, choose(true)], (_test, value) => value);
      }
      if (cells.every((cell) => !(cell instanceof Error) && numeric(cell) === 0)) {
        return mapMatrices([condition, choose(false)], (_test, value) => value);
      }
      return mapMatrices([condition, choose(true), choose(false)], (test, yes, no) => numeric(test) ? yes : no);
    }
    const matrices = args.map(visit);
    if (["TAKE", "INDEX", "TRANSPOSE"].includes(node.name)) {
      const { rows, cols, values } = matrices[0];
      let result;
      const index = (i, fallback) => {
        if (!matrices[i] || args[i].kind === "omitted") return fallback;
        if (matrices[i].rows !== 1 || matrices[i].cols !== 1) throw new Error(`${node.name} indices must be scalar numbers.`);
        return Math.trunc(numeric(matrices[i].values[0][0]));
      };
      if (node.name === "TRANSPOSE") {
        result = Array.from({ length: cols }, (_, c) => values.map(row => row[c]));
      } else if (node.name === "TAKE") {
        const nr = index(1, rows), nc = index(2, cols);
        if (!nr || !nc) throw new Error("TAKE cannot return an empty array (zero rows or columns).");
        const r = nr < 0 ? Math.max(0, rows + nr) : 0;
        const c = nc < 0 ? Math.max(0, cols + nc) : 0;
        result = values.slice(r, r + Math.abs(nr)).map(row => row.slice(c, c + Math.abs(nc)));
      } else {
        let r = index(1, 0), c = index(2, cols > 1 && rows > 1 ? 0 : 1);
        if (matrices.length === 2 && rows === 1) [r, c] = [1, r];
        if (r < 0 || c < 0 || r > rows || c > cols) throw new Error("INDEX is outside the array.");
        result = (r === 0 ? values : [values[r - 1]]).map(row => c === 0 ? [...row] : [row[c - 1]]);
      }
      return { rows: result.length, cols: result[0].length, values: result };
    }
    if (node.name === "ABS") return mapMatrices(matrices, (value) => Math.abs(numeric(value)));
    if (node.name === "ROUND" && matrices.length === 1) matrices.push(scalarMatrix(0));
    if (node.name === "ROUND") return mapMatrices(matrices, (value, digits) => {
      const number = numeric(value);
      if (round) {
        const value = round(number, Math.trunc(numeric(digits)));
        if (value == null) throw new Error("ROUND result is not finite.");
        return numeric(value);
      }
      const factor = 10 ** Math.trunc(numeric(digits));
      return numeric(Math.sign(number) * Math.floor(Math.abs(number) * factor + 0.5) / factor);
    });
    const numbers = matrices.flatMap((matrix) => matrix.values.flat())
      .filter((value) => value != null && value !== "").map(numeric);
    if (node.name === "COUNT") return scalarMatrix(numbers.length);
    if (!numbers.length && ["AVERAGE", "MEDIAN"].includes(node.name)) throw new Error(`${node.name} needs at least one numeric value.`);
    const sum = numbers.reduce((total, number) => total + number, 0);
    if (node.name === "SUM") return scalarMatrix(numeric(sum));
    if (node.name === "AVERAGE") return scalarMatrix(numeric(sum / numbers.length));
    if (node.name === "MIN") return scalarMatrix(numbers.length ? numbers.reduce((a, b) => Math.min(a, b)) : 0);
    if (node.name === "MAX") return scalarMatrix(numbers.length ? numbers.reduce((a, b) => Math.max(a, b)) : 0);
    numbers.sort((a, b) => a - b);
    const middle = Math.floor(numbers.length / 2);
    return scalarMatrix(numeric(numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2));
  }
  function visit(node) {
    try {
      if (node.kind === "number") return scalarMatrix(node.value);
      if (node.kind === "omitted") return scalarMatrix(0);
      if (node.kind === "array") {
        const values = node.rows.map(row => row.map(item => {
          const cell = visit(item);
          if (cell.rows !== 1 || cell.cols !== 1) throw new Error("Array constant items must be scalar values.");
          return cell.values[0][0];
        }));
        return { rows: values.length, cols: values[0].length, values };
      }
      if (node.kind === "function") return call(node);
      if (node.kind === "reference") {
        const matrix = lookup(node.token);
        if (!matrix || !(matrix.rows > 0) || !(matrix.cols > 0)) throw new Error(`${node.token.text} has no values to calculate with.`);
        return matrix;
      }
      if (node.kind === "unary") return combine(scalarMatrix(0), visit(node.operand), "-");
      return combine(visit(node.left), visit(node.right), node.operator);
    } catch (error) {
      return scalarMatrix(error);
    }
  }
  try {
    const result = visit(tree);
    for (const row of result.values) for (const value of row) if (value != null) numeric(value);
    return { ok: true, ...result };
  } catch (error) {
    return invalid(String(error?.message || error));
  }
}
