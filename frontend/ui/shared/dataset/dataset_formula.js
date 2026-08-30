/*
===============================================================================
Dataset Formula
One grammar for everything a Dataset grid cell accepts after "=": a standalone
Excel link, a standalone ArcRho dataset link, or an arithmetic formula whose
operands are any mix of the two plus numbers:

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
`app_server/services/dataset_formula_link_service.py` mirrors the tokenizer and
the canonical text so a saved formula round-trips byte for byte.
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
  + "for example =[Dataset][1:6] * 1.05.";

const EXCEL_TOKEN_RE = /'((?:[^']|'')*)'!\$?[A-Z]+\$?[0-9]+(?::\$?[A-Z]+\$?[0-9]+)?/iy;
const NUMBER_TOKEN_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const BINARY_PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };

function invalid(error) {
  return { ok: false, error };
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
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];
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
 * link, `formula` for an expression holding at least one reference, or
 * `invalid` with the message to show.
 */
export function classifyDatasetFormula(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return { kind: "invalid", error: DATASET_FORMULA_SYNTAX_HINT };
  if (parseExcelReference(text)) return { kind: "excel", reference: text };
  if (parseInternalDatasetReference(text).ok) return { kind: "internal", reference: text };
  const parsed = parseDatasetFormula(text);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  if (!parsed.references.length) {
    return {
      kind: "invalid",
      error: `A formula needs at least one dataset or Excel reference. ${DATASET_FORMULA_SYNTAX_HINT}`,
    };
  }
  return { kind: "formula", ...parsed };
}

function scalarMatrix(value) {
  return { rows: 1, cols: 1, values: [[value]] };
}

function cellAt(matrix, row, col) {
  const value = matrix.values[matrix.rows === 1 ? 0 : row][matrix.cols === 1 ? 0 : col];
  // Excel arithmetic reads a blank cell as zero.
  return value === null || value === undefined || value === "" ? 0 : Number(value);
}

function combine(left, right, operator) {
  const rows = left.rows === right.rows ? left.rows : (left.rows === 1 ? right.rows : (right.rows === 1 ? left.rows : -1));
  const cols = left.cols === right.cols ? left.cols : (left.cols === 1 ? right.cols : (right.cols === 1 ? left.cols : -1));
  if (rows < 0 || cols < 0) {
    throw new Error(`Array sizes do not match (${left.rows}x${left.cols} and ${right.rows}x${right.cols}).`);
  }
  const values = [];
  for (let row = 0; row < rows; row += 1) {
    const line = [];
    for (let col = 0; col < cols; col += 1) {
      const a = cellAt(left, row, col);
      const b = cellAt(right, row, col);
      let result;
      if (operator === "+") result = a + b;
      else if (operator === "-") result = a - b;
      else if (operator === "*") result = a * b;
      else if (operator === "/") {
        if (b === 0) throw new Error("The formula divides by zero.");
        result = a / b;
      } else result = a ** b;
      if (!Number.isFinite(result)) throw new Error("The formula produced a value that is not a finite number.");
      line.push(result);
    }
    values.push(line);
  }
  return { rows, cols, values };
}

/**
 * Evaluate a parsed tree. `lookup(token)` returns the matrix
 * `{rows, cols, values}` a reference token stands for. Returns
 * `{ok: true, rows, cols, values}` or `{ok: false, error}`.
 */
export function evaluateDatasetFormula(tree, lookup) {
  function visit(node) {
    if (node.kind === "number") return scalarMatrix(node.value);
    if (node.kind === "reference") {
      const matrix = lookup(node.token);
      if (!matrix || !(matrix.rows > 0) || !(matrix.cols > 0)) {
        throw new Error(`${node.token.text} has no values to calculate with.`);
      }
      return matrix;
    }
    if (node.kind === "unary") return combine(scalarMatrix(0), visit(node.operand), "-");
    return combine(visit(node.left), visit(node.right), node.operator);
  }
  try {
    return { ok: true, ...visit(tree) };
  } catch (error) {
    return invalid(String(error?.message || error));
  }
}
