/*
===============================================================================
Notes Expressions - `{...}` placeholders in a note

A note may hold Python-like expressions in braces, `{development_label(1)}`
or `{ratio_value(1, 2) * 100:.2f}`. Editing shows the raw text; leaving edit
mode renders each expression as its value. The names an expression may use
come from a context the hosting page supplies:

  {
    values: { name: value, ... },          // constants
    functions: { name: (...args) => value } // callables, positional args
    catalog: [{ snippet, description }]     // what the Insert Value menu lists
  }

The grammar is the arithmetic and logic subset of Python: numbers, strings,
True/False/None, + - * / // % **, comparisons, and/or/not, `a if c else b`,
parentheses, calls, and dotted properties. An optional format spec follows a
colon, as in `{x:,.2f}`, `{x:.1%}`, `{x:d}`.

A context may also expose *nodes* built from a JSON document (see
`jsonToNotesValue`): an object becomes a node whose properties are reached
with a dot, `{ratio_triangle.development_labels(1)}`, and an array becomes a
list that is called with a 1-based position (negative counts from the end,
two positions reach into a nested array). An array property whose key ends
in `s` is also reachable by the singular key, `development_label(1)`.
===============================================================================
*/

const KEYWORDS = new Set(["and", "or", "not", "if", "else", "True", "False", "None"]);
const TWO_CHAR_OPERATORS = new Set(["**", "//", "==", "!=", "<=", ">="]);
const ONE_CHAR_OPERATORS = new Set(["+", "-", "*", "/", "%", "(", ")", ",", "<", ">", "."]);
const STRING_ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
const NODE_MARK = Symbol("notes-node");
const LIST_MARK = Symbol("notes-list");
const PREVIEW_ITEMS = 3;

export class NotesExpressionError extends Error {}

function fail(message) {
  throw new NotesExpressionError(message);
}

// -----------------------------------------------------------------------------
// Nodes and lists: values that mirror a JSON document
// -----------------------------------------------------------------------------

export function isNotesNode(value) {
  return !!value && typeof value === "object" && value[NODE_MARK] === true;
}

export function isNotesList(value) {
  return typeof value === "function" && value[LIST_MARK] === true;
}

/** A node: `properties` is name -> value, `label` names it in messages. */
export function makeNotesNode(properties, label = "") {
  return { [NODE_MARK]: true, properties: { ...properties }, label: String(label || "") };
}

function resolvePosition(position, count, label) {
  const number = Number(position);
  if (!Number.isInteger(number) || number === 0) {
    fail(`${label} position must be a whole number, not ${String(position)}`);
  }
  const index = number > 0 ? number - 1 : count + number;
  if (index < 0 || index >= count) fail(`${label} position ${number} is out of range (1-${count})`);
  return index;
}

/** A list: called with a 1-based position; two positions reach a nested array. */
export function makeNotesList(items, label = "list") {
  const list = (...positions) => {
    if (!positions.length) fail(`${label} needs a position, as in ${label}(1)`);
    let current = list;
    for (const position of positions) {
      if (!isNotesList(current)) fail(`${label} has no second level at that position`);
      const item = current.items[resolvePosition(position, current.items.length, current.label)];
      current = Array.isArray(item) ? makeNotesList(item, current.label) : item;
    }
    return current === undefined ? null : current;
  };
  list[LIST_MARK] = true;
  list.items = Array.isArray(items) ? items : [];
  list.label = String(label || "list");
  return list;
}

/**
 * Turns a JSON value into a notes value: objects become nodes, arrays become
 * lists (an array key ending in `s` also gets its singular alias), scalars
 * stay as they are.
 */
export function jsonToNotesValue(value, label = "") {
  if (Array.isArray(value)) return makeNotesList(value, label);
  if (value && typeof value === "object") {
    const properties = {};
    for (const [key, child] of Object.entries(value)) {
      properties[key] = jsonToNotesValue(child, key);
    }
    for (const [key, child] of Object.entries(value)) {
      const singular = key.endsWith("s") ? key.slice(0, -1) : "";
      if (Array.isArray(child) && singular && !(singular in properties)) properties[singular] = properties[key];
    }
    return makeNotesNode(properties, label);
  }
  return value === undefined ? null : value;
}

/** Attaches the signature and description the completion popup shows. */
export function describeNotesFunction(fn, signature, description) {
  fn.signature = String(signature || "");
  fn.description = String(description || "");
  return fn;
}

// -----------------------------------------------------------------------------
// Scanning `{...}` spans out of the note text
// -----------------------------------------------------------------------------

function closingBraceIndex(source, openIndex) {
  let depth = 0;
  let quote = "";
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "}" && depth <= 0) return index;
    else if (char === "\n") return -1;
  }
  return -1;
}

function splitFormatSpec(body) {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === ":" && depth === 0) {
      return { expression: body.slice(0, index), spec: body.slice(index + 1).trim() };
    }
  }
  return { expression: body, spec: "" };
}

/**
 * Finds every `{...}` placeholder. `{{` and `}}` are literal braces, as in a
 * Python f-string, and an unclosed brace is ordinary text.
 *
 * @returns {Array<{start:number,end:number,expression:string,spec:string}>}
 */
export function findNotesExpressionMatches(source) {
  const text = String(source ?? "");
  const matches = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "{" && text[index + 1] === "{") {
      matches.push({ start: index, end: index + 2, literal: "{" });
      index += 2;
      continue;
    }
    if (char === "}" && text[index + 1] === "}") {
      matches.push({ start: index, end: index + 2, literal: "}" });
      index += 2;
      continue;
    }
    if (char !== "{") {
      index += 1;
      continue;
    }
    const close = closingBraceIndex(text, index);
    if (close < 0) {
      index += 1;
      continue;
    }
    const { expression, spec } = splitFormatSpec(text.slice(index + 1, close));
    matches.push({ start: index, end: close + 1, expression, spec });
    index = close + 1;
  }
  return matches;
}

// -----------------------------------------------------------------------------
// Tokenizer
// -----------------------------------------------------------------------------

function tokenize(expression) {
  const tokens = [];
  let index = 0;
  const text = String(expression ?? "");
  while (index < text.length) {
    const char = text[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    const numberMatch = text.slice(index).match(/^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/u);
    if (numberMatch) {
      tokens.push({ type: "number", value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }
    if (char === "'" || char === '"') {
      let value = "";
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== char) {
        if (text[cursor] === "\\") {
          cursor += 1;
          value += STRING_ESCAPES[text[cursor]] ?? text[cursor] ?? "";
        } else {
          value += text[cursor];
        }
        cursor += 1;
      }
      if (cursor >= text.length) fail("unterminated string");
      tokens.push({ type: "string", value });
      index = cursor + 1;
      continue;
    }
    const nameMatch = text.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
    if (nameMatch) {
      const word = nameMatch[0];
      tokens.push(KEYWORDS.has(word) ? { type: "keyword", value: word } : { type: "name", value: word });
      index += word.length;
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (TWO_CHAR_OPERATORS.has(pair)) {
      tokens.push({ type: "op", value: pair });
      index += 2;
      continue;
    }
    if (ONE_CHAR_OPERATORS.has(char)) {
      tokens.push({ type: "op", value: char });
      index += 1;
      continue;
    }
    fail(`unexpected character '${char}'`);
  }
  tokens.push({ type: "end" });
  return tokens;
}

// -----------------------------------------------------------------------------
// Parser: builds a small tree so `and`/`or`/`if` can short-circuit
// -----------------------------------------------------------------------------

function parse(expression) {
  const tokens = tokenize(expression);
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const isOp = (value) => peek().type === "op" && peek().value === value;
  const isKeyword = (value) => peek().type === "keyword" && peek().value === value;
  const expectOp = (value) => {
    if (!isOp(value)) fail(`expected '${value}'`);
    next();
  };

  const parseTernary = () => {
    const body = parseOr();
    if (!isKeyword("if")) return body;
    next();
    const condition = parseOr();
    if (!isKeyword("else")) fail("expected 'else'");
    next();
    const otherwise = parseTernary();
    return { type: "ternary", condition, body, otherwise };
  };

  const parseOr = () => {
    let left = parseAnd();
    while (isKeyword("or")) {
      next();
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  };

  const parseAnd = () => {
    let left = parseNot();
    while (isKeyword("and")) {
      next();
      left = { type: "and", left, right: parseNot() };
    }
    return left;
  };

  const parseNot = () => {
    if (isKeyword("not")) {
      next();
      return { type: "not", operand: parseNot() };
    }
    return parseComparison();
  };

  const parseComparison = () => {
    const left = parseArithmetic();
    const token = peek();
    if (token.type === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(token.value)) {
      next();
      return { type: "compare", operator: token.value, left, right: parseArithmetic() };
    }
    return left;
  };

  const parseArithmetic = () => {
    let left = parseTerm();
    while (isOp("+") || isOp("-")) {
      const operator = next().value;
      left = { type: "binary", operator, left, right: parseTerm() };
    }
    return left;
  };

  const parseTerm = () => {
    let left = parseFactor();
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const operator = next().value;
      left = { type: "binary", operator, left, right: parseFactor() };
    }
    return left;
  };

  const parseFactor = () => {
    if (isOp("-") || isOp("+")) {
      const operator = next().value;
      return { type: "unary", operator, operand: parseFactor() };
    }
    return parsePower();
  };

  const parsePower = () => {
    const base = parseCall();
    if (isOp("**")) {
      next();
      return { type: "binary", operator: "**", left: base, right: parseFactor() };
    }
    return base;
  };

  const parseCall = () => {
    let node = parsePrimary();
    while (isOp("(") || isOp(".")) {
      if (isOp(".")) {
        next();
        const property = next();
        if (property.type !== "name") fail("expected a property name after '.'");
        node = { type: "attr", object: node, name: property.value };
        continue;
      }
      next();
      const args = [];
      if (!isOp(")")) {
        args.push(parseTernary());
        while (isOp(",")) {
          next();
          if (isOp(")")) break;
          args.push(parseTernary());
        }
      }
      expectOp(")");
      node = { type: "call", callee: node, args };
    }
    return node;
  };

  const parsePrimary = () => {
    const token = next();
    if (token.type === "number" || token.type === "string") return { type: "literal", value: token.value };
    if (token.type === "keyword") {
      if (token.value === "True") return { type: "literal", value: true };
      if (token.value === "False") return { type: "literal", value: false };
      if (token.value === "None") return { type: "literal", value: null };
      fail(`unexpected '${token.value}'`);
    }
    if (token.type === "name") return { type: "name", name: token.value };
    if (token.type === "op" && token.value === "(") {
      const inner = parseTernary();
      expectOp(")");
      return inner;
    }
    if (token.type === "end") fail("expression is incomplete");
    fail(`unexpected '${token.value}'`);
    return null;
  };

  if (!expression.trim()) fail("empty expression");
  const tree = parseTernary();
  if (peek().type !== "end") fail(`unexpected '${peek().value}'`);
  return tree;
}

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

function isNumber(value) {
  return typeof value === "number" || typeof value === "boolean";
}

function toNumber(value, what) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  fail(`${what} needs a number`);
  return 0;
}

function truthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  return !!value;
}

function typeName(value) {
  if (value === null || value === undefined) return "None";
  if (isNotesList(value)) return "list";
  if (isNotesNode(value)) return "object";
  if (typeof value === "function") return "function";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  return "text";
}

function pythonRound(value, digits) {
  const scale = 10 ** digits;
  const scaled = Math.abs(value) * scale;
  const rounded = Math.round(scaled);
  // Round half to even, the way Python's round() does, when exactly on .5.
  const half = Math.abs(scaled - Math.trunc(scaled) - 0.5) < 1e-9;
  const result = half && rounded % 2 !== 0 ? rounded - 1 : rounded;
  return Math.sign(value) * result / scale;
}

function applyBinary(operator, left, right) {
  if (operator === "+" && typeof left === "string" && typeof right === "string") return left + right;
  if ((operator === "+" || operator === "*") && (typeof left === "string" || typeof right === "string")) {
    fail(`cannot ${operator === "+" ? "add" : "multiply"} ${typeName(left)} and ${typeName(right)}`);
  }
  const a = toNumber(left, `'${operator}'`);
  const b = toNumber(right, `'${operator}'`);
  switch (operator) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
      if (b === 0) fail("division by zero");
      return a / b;
    case "//":
      if (b === 0) fail("division by zero");
      return Math.floor(a / b);
    case "%":
      if (b === 0) fail("division by zero");
      return ((a % b) + b) % b;
    case "**": return a ** b;
    default:
      fail(`unknown operator '${operator}'`);
      return 0;
  }
}

function applyComparison(operator, left, right) {
  if (operator === "==") return left === right || (isNumber(left) && isNumber(right) && Number(left) === Number(right));
  if (operator === "!=") return !applyComparison("==", left, right);
  const comparable = (typeof left === "string" && typeof right === "string") || (isNumber(left) && isNumber(right));
  if (!comparable) fail(`cannot compare ${typeName(left)} and ${typeName(right)}`);
  const a = isNumber(left) ? Number(left) : left;
  const b = isNumber(right) ? Number(right) : right;
  switch (operator) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    default:
      fail(`unknown comparison '${operator}'`);
      return false;
  }
}

// A list given as the only argument of min/max/sum is spread over its
// non-empty items, as `min(origin_labels)` reads.
function spreadListArgument(values, what) {
  if (values.length === 1 && isNotesList(values[0])) {
    return values[0].items.filter((item) => item !== null && item !== undefined);
  }
  if (!values.length) fail(`${what} needs at least one value`);
  return values;
}

const BUILTIN_FUNCTIONS = {
  abs: describeNotesFunction((value) => Math.abs(toNumber(value, "abs()")), "abs(x)", "Absolute value"),
  round: describeNotesFunction(
    (value, digits = 0) => pythonRound(toNumber(value, "round()"), Math.trunc(toNumber(digits, "round()"))),
    "round(x, digits)",
    "Round to a number of decimals",
  ),
  min: describeNotesFunction(
    (...values) => spreadListArgument(values, "min()").reduce((best, value) => (applyComparison("<", value, best) ? value : best)),
    "min(a, b, ...)",
    "Smallest of the values, or of a list",
  ),
  max: describeNotesFunction(
    (...values) => spreadListArgument(values, "max()").reduce((best, value) => (applyComparison(">", value, best) ? value : best)),
    "max(a, b, ...)",
    "Largest of the values, or of a list",
  ),
  sum: describeNotesFunction(
    (...values) => spreadListArgument(values, "sum()").reduce((total, value) => total + toNumber(value, "sum()"), 0),
    "sum(list)",
    "Total of the values, or of a list",
  ),
  int: describeNotesFunction((value) => Math.trunc(typeof value === "string" ? Number(value) : toNumber(value, "int()")), "int(x)", "Whole number part"),
  float: describeNotesFunction((value) => (typeof value === "string" ? Number(value) : toNumber(value, "float()")), "float(x)", "Number from text"),
  str: describeNotesFunction((value) => formatNotesExpressionValue(value, ""), "str(x)", "Text of a value"),
  len: describeNotesFunction((value) => {
    if (isNotesList(value)) return value.items.length;
    if (typeof value !== "string") fail("len() needs text or a list");
    return value.length;
  }, "len(x)", "Length of text or a list"),
};

function lookupName(name, context) {
  const functions = context?.functions || {};
  const values = context?.values || {};
  if (Object.prototype.hasOwnProperty.call(functions, name)) return functions[name];
  if (Object.prototype.hasOwnProperty.call(values, name)) {
    const value = values[name];
    return typeof value === "function" ? value() : value;
  }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_FUNCTIONS, name)) return BUILTIN_FUNCTIONS[name];
  fail(`unknown name '${name}'`);
  return null;
}

function evaluateNode(node, context) {
  switch (node.type) {
    case "literal": return node.value;
    case "name": return lookupName(node.name, context);
    case "attr": {
      const target = evaluateNode(node.object, context);
      if (!isNotesNode(target)) fail(`${typeName(target)} has no properties; '.${node.name}' needs an object`);
      if (!Object.prototype.hasOwnProperty.call(target.properties, node.name)) {
        fail(`'${target.label || "object"}' has no property '${node.name}'`);
      }
      return target.properties[node.name];
    }
    case "unary": {
      const operand = toNumber(evaluateNode(node.operand, context), `'${node.operator}'`);
      return node.operator === "-" ? -operand : operand;
    }
    case "binary": return applyBinary(node.operator, evaluateNode(node.left, context), evaluateNode(node.right, context));
    case "compare": return applyComparison(node.operator, evaluateNode(node.left, context), evaluateNode(node.right, context));
    case "not": return !truthy(evaluateNode(node.operand, context));
    case "and": {
      const left = evaluateNode(node.left, context);
      return truthy(left) ? evaluateNode(node.right, context) : left;
    }
    case "or": {
      const left = evaluateNode(node.left, context);
      return truthy(left) ? left : evaluateNode(node.right, context);
    }
    case "ternary":
      return truthy(evaluateNode(node.condition, context))
        ? evaluateNode(node.body, context)
        : evaluateNode(node.otherwise, context);
    case "call": {
      const callee = evaluateNode(node.callee, context);
      if (typeof callee !== "function") {
        fail(`${node.callee.type === "name" ? `'${node.callee.name}'` : "value"} is not a function`);
      }
      const args = node.args.map((arg) => evaluateNode(arg, context));
      const result = callee(...args);
      return result === undefined ? null : result;
    }
    default:
      fail(`unsupported expression`);
      return null;
  }
}

/**
 * Evaluates one expression (the text between the braces, without a format
 * spec) against a context. Throws NotesExpressionError with a short reason.
 */
export function evaluateNotesExpression(expression, context) {
  return evaluateNode(parse(String(expression ?? "")), context);
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatNumber(value, spec) {
  if (!Number.isFinite(value)) return String(value);
  const match = String(spec || "").match(/^(,)?(?:\.(\d+))?([fd%e])?$/u);
  if (!match) fail(`unsupported format '${spec}'`);
  const grouping = !!match[1];
  const precision = match[2] === undefined ? null : Number(match[2]);
  const kind = match[3] || "";
  let number = value;
  let suffix = "";
  let text;
  if (kind === "%") {
    number = value * 100;
    suffix = "%";
  }
  if (kind === "d") {
    if (precision !== null) fail("'d' takes no precision");
    text = String(Math.trunc(number));
  } else if (kind === "e") {
    text = number.toExponential(precision ?? 6);
  } else if (precision !== null || kind === "f" || kind === "%") {
    text = number.toFixed(precision ?? (kind ? 6 : 0));
  } else {
    text = String(number);
  }
  if (grouping) {
    const sign = text.startsWith("-") ? "-" : "";
    const [whole, fraction] = text.replace(/^-/u, "").split(".");
    text = sign + groupThousands(whole) + (fraction !== undefined ? `.${fraction}` : "");
  }
  return text + suffix;
}

/**
 * Renders a value the way the note shows it: numbers by the spec, None as
 * nothing, booleans as True/False.
 */
export function formatNotesExpressionValue(value, spec = "") {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return formatNumber(value, spec);
  if (isNotesList(value)) {
    return value.items.map((item) => (
      Array.isArray(item)
        ? "[" + formatNotesExpressionValue(makeNotesList(item), spec) + "]"
        : formatNotesExpressionValue(item, spec)
    )).join(", ");
  }
  if (isNotesNode(value)) fail(`'${value.label || "object"}' is an object; pick one of its properties`);
  if (typeof value === "function") fail("a function is not a value");
  if (spec) fail(`text cannot use format '${spec}'`);
  return String(value);
}

// -----------------------------------------------------------------------------
// Rendering a whole note
// -----------------------------------------------------------------------------

/**
 * Splits a note into rendered segments. Text segments carry the note text
 * unchanged; expression segments carry the rendered value, or the raw
 * placeholder plus an `error` when it could not be rendered. Every segment
 * keeps its `start`/`end` in the raw note so a click on the rendered view can
 * be mapped back to a caret position.
 *
 * @returns {Array<{kind:"text"|"expression",start:number,end:number,text:string,source?:string,error?:string}>}
 */
export function renderNotesExpressions(source, context) {
  const text = String(source ?? "");
  const segments = [];
  let cursor = 0;
  const pushText = (start, end, rendered = null) => {
    if (end <= start) return;
    segments.push({ kind: "text", start, end, text: rendered ?? text.slice(start, end) });
  };
  for (const match of findNotesExpressionMatches(text)) {
    pushText(cursor, match.start);
    if (match.literal !== undefined) {
      pushText(match.start, match.end, match.literal);
      cursor = match.end;
      continue;
    }
    const raw = text.slice(match.start, match.end);
    const segment = { kind: "expression", start: match.start, end: match.end, text: raw, source: raw };
    try {
      segment.text = formatNotesExpressionValue(evaluateNotesExpression(match.expression, context), match.spec);
    } catch (error) {
      segment.error = String(error?.message || error);
    }
    segments.push(segment);
    cursor = match.end;
  }
  pushText(cursor, text.length);
  return segments;
}

/**
 * The note as plain text with every placeholder replaced by its rendered
 * value; a placeholder that cannot be rendered keeps its raw text. This is
 * what a save stores for readers that cannot render, such as the ResQ export.
 */
export function renderNotesExpressionText(source, context) {
  return renderNotesExpressions(source, context).map((segment) => segment.text).join("");
}

// -----------------------------------------------------------------------------
// Completions while typing inside `{...}`
// -----------------------------------------------------------------------------

/**
 * Finds what the caret is typing inside an open placeholder: the dotted
 * `path` before the last dot, the `partial` name being typed, and where that
 * name starts. Null when the caret is not inside `{...}`, sits in a string,
 * or is not on a name.
 */
export function findNotesCompletionQuery(textBeforeCaret) {
  const text = String(textBeforeCaret ?? "");
  let open = -1;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "}" || char === "\n") return null;
    if (char === "{") {
      if (text[index - 1] === "{") return null;
      open = index;
      break;
    }
  }
  if (open < 0) return null;
  const expression = text.slice(open + 1);
  const quotes = expression.replace(/\\./gu, "").match(/['"]/gu);
  if (quotes && quotes.length % 2 === 1) return null;
  const match = expression.match(/(?:([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.)?([A-Za-z_]\w*)?$/u);
  const path = match?.[1] ? match[1].split(".") : [];
  const partial = match?.[2] || "";
  const tokenStart = expression.length - (match?.[0]?.length || 0);
  const prefix = expression.slice(0, tokenStart).trimEnd();
  const before = prefix.slice(-1);
  if (/[\w.)'"]/u.test(before) && !/\b(?:and|or|not|if|else)$/u.test(prefix)) return null;
  // Right after `(` or `,` a position is usually typed; offer names once a
  // letter has been.
  if (!partial && /[(,]/u.test(before)) return null;
  return { path, partial, start: open + 1 + tokenStart + (match?.[1] ? match[1].length + 1 : 0) };
}

function previewOf(value) {
  if (isNotesList(value)) {
    const items = value.items.slice(0, PREVIEW_ITEMS).map((item) => (
      Array.isArray(item) ? "[...]" : formatNotesExpressionValue(item, "")
    ));
    const more = value.items.length - items.length;
    return items.join(", ") + (more > 0 ? `, ... (${value.items.length})` : "");
  }
  if (isNotesNode(value)) {
    const names = Object.keys(value.properties);
    return names.slice(0, 4).join(", ") + (names.length > 4 ? ", ..." : "");
  }
  if (typeof value === "function") return value.signature || "";
  return formatNotesExpressionValue(value, "");
}

function completionEntry(name, value) {
  const kind = isNotesList(value)
    ? "list"
    : isNotesNode(value)
      ? "object"
      : typeof value === "function"
        ? "function"
        : "value";
  return {
    name,
    kind,
    preview: previewOf(value),
    description: typeof value === "function" && !isNotesList(value) ? value.description || "" : "",
    insert: kind === "object" ? name + "." : kind === "value" ? name : name + "(",
  };
}

/**
 * Lists what can follow the dotted `path` in a context: at the root, every
 * value, function, and built-in; inside an object, its properties.
 */
export function listNotesCompletions(context, path = []) {
  if (!path.length) {
    const entries = [];
    const seen = new Set();
    const add = (source, resolve) => {
      for (const name of Object.keys(source || {})) {
        if (seen.has(name)) continue;
        seen.add(name);
        entries.push(completionEntry(name, resolve(source[name])));
      }
    };
    add(context?.values, (value) => (typeof value === "function" && !isNotesList(value) ? value() : value));
    add(context?.functions, (value) => value);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    add(BUILTIN_FUNCTIONS, (value) => value);
    return entries;
  }
  let current;
  try {
    current = lookupName(path[0], context);
    for (const name of path.slice(1)) {
      if (!isNotesNode(current)) return [];
      current = current.properties[name];
    }
  } catch {
    return [];
  }
  if (!isNotesNode(current)) return [];
  return Object.entries(current.properties).map(([name, value]) => completionEntry(name, value));
}
