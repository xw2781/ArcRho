import { FORMULA_FUNCTION_ARGUMENTS, ARCRHO_FORMULA_FUNCTIONS, findArcRhoFormulaReferences } from "/ui/shared/dataset/dataset_formula.js?v=20260917a";

export const FORMULA_CATALOG = [
  ...Object.entries(FORMULA_FUNCTION_ARGUMENTS).map(([name, args]) => ({ name, arguments: args.map(name => ({ name: name.replace(/[\[\]]/g, ""), optional: name.startsWith("[") })) })),
  ...Object.values(ARCRHO_FORMULA_FUNCTIONS),
];

export const quoteFormulaText = value => `"${String(value).replaceAll('"', '""')}"`;

/** Include context arguments after the caret when editing a complete call. */
export function formulaCompletionIdentity(raw, query, current) {
  const identity = { ...current };
  let args = {};
  try {
    args = findArcRhoFormulaReferences(raw).find(call => call.start < query.end && call.end >= query.end)?.arguments || {};
  } catch { /* Incomplete drafts use the arguments already typed. */ }
  query.spec?.arguments.forEach((arg, index) => {
    if (arg.name in args) return;
    const value = query.parts[index];
    if (/^"(?:[^"]|"")*"$/.test(value || "")) args[arg.name] = value.slice(1, -1).replaceAll('""', '"');
  });
  if (args.Path) identity.reserving_class = args.Path;
  if (args.ProjectName && String(args.ProjectName).toLowerCase() !== "default") identity.project_name = args.ProjectName;
  return identity;
}

/** The innermost call and argument at the caret, even in an incomplete draft. */
export function formulaCallContext(raw, caret = raw.length) {
  const text = raw.slice(0, caret), stack = [];
  let quote = "", bracket = 0, brace = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[") bracket++;
    if (ch === "]") bracket--;
    if (bracket) continue;
    if (ch === "{") brace++;
    if (ch === "}") brace--;
    if (ch === "(") {
      const match = /([A-Za-z_][\w]*)\s*$/.exec(text.slice(0, i));
      stack.push({ name: match?.[1], start: i + 1, argument: 0, parts: [], brace });
    } else if (ch === ")") stack.pop();
    else if (ch === "," && stack.length && brace === stack.at(-1).brace) {
      const call = stack.at(-1);
      call.parts.push(text.slice(call.start, i).trim());
      call.argument++;
      call.start = i + 1;
    }
  }
  const call = stack.at(-1);
  if (!call?.name) return null;
  const spec = FORMULA_CATALOG.find(item => item.name.toUpperCase() === call.name.toUpperCase());
  return spec ? { ...call, spec, query: text.slice(call.start).trim(), end: caret, quote } : null;
}

export function formulaCompletionQuery(raw, caret = raw.length) {
  const text = raw.slice(0, caret);
  const bracket = findActiveDfmDatasetNameQuery(raw, caret);
  if (bracket) return { ...bracket, kind: "dataset" };
  if (!raw.trimStart().startsWith("=")) return null;
  const call = formulaCallContext(raw, caret);
  if (call) {
    const argument = call.spec.arguments[Math.min(call.argument, call.spec.arguments.length - 1)];
    const name = argument?.name;
    if (["TriangleName", "VectorName"].includes(name)) return { ...call, kind: "datasetArgument" };
    if (["Path", "ProjectName"].includes(name)) return { ...call, kind: "contextArgument" };
    if ((typeof argument?.default === "boolean" || ["ByTypeName", "SuppressWarnings", "logical_test"].includes(name)) && /^(?:T(?:R(?:U(?:E)?)?)?|F(?:A(?:L(?:S(?:E)?)?)?)?)?$/i.test(call.query)) return { ...call, kind: "boolean" };
  }
  if (!call?.quote) {
    const match = /[A-Za-z_][\w]*$/.exec(text);
    if (match) return { kind: "function", start: caret - match[0].length, end: caret, query: match[0], call };
  }
  return call ? { ...call, kind: "hint" } : null;
}

export function completionEdit(raw, query, insertion) {
  if (!["function", "dataset"].includes(query.kind)) insertion = (raw.slice(query.start, query.end).match(/^\s*/)?.[0] || "") + insertion;
  let end = query.end;
  if (query.kind === "function") {
    while (/[\w]/.test(raw[end] || "")) end++;
    if (/^\s*\(/.test(raw.slice(end))) insertion = insertion.replace(/\($/, "");
  } else if (query.kind === "dataset") {
    const close = raw.indexOf("]", end);
    if (close >= 0 && !/[\[()+*/]/.test(raw.slice(end, close))) end = close + 1;
    if (raw[end] === "[") insertion = insertion.slice(0, -1);
  } else if (query.quote) {
    while (end < raw.length) {
      if (raw[end++] !== query.quote) continue;
      if (raw[end] === query.quote) { end++; continue; }
      break;
    }
  }
  return { value: raw.slice(0, query.start) + insertion + raw.slice(end), caret: query.start + insertion.length };
}

function insideSingleQuotedSegment(text, index) {
  let quoted = "";
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (quoted) {
      if (text[cursor] === quoted) {
        if (text[cursor + 1] === quoted) cursor += 1;
        else quoted = "";
      }
    } else if (["'", '\"'].includes(text[cursor])) quoted = text[cursor];
  }
  return quoted;
}

export function findActiveDfmDatasetNameQuery(rawFormula, caretPosition) {
  const text = String(rawFormula || "");
  const caret = Math.max(0, Math.min(text.length, Number(caretPosition) || 0));
  const open = text.lastIndexOf("[", caret - 1);
  if (open < 0 || text.slice(open + 1, caret).includes("]")) return null;
  if (insideSingleQuotedSegment(text, open)) return null;

  let prior = open - 1;
  while (prior >= 0 && /\s/.test(text[prior])) prior -= 1;
  // A bracket immediately following a completed bracket is the coordinate
  // portion of [Dataset][row, col], not a new dataset-name token.
  if (prior >= 0 && text[prior] === "]") return null;

  return {
    start: open,
    end: caret,
    query: text.slice(open + 1, caret),
  };
}

export function filterDfmDatasetNames(datasetNames, rawQuery) {
  const query = String(rawQuery || "").trim().toLocaleLowerCase();
  const seen = new Set();
  const matches = [];
  for (const rawName of Array.isArray(datasetNames) ? datasetNames : []) {
    const name = String(rawName || "").trim();
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key) || (query && !key.includes(query))) continue;
    seen.add(key);
    matches.push(name);
  }
  return matches.sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function completeDfmDatasetName(rawFormula, activeQuery, datasetName) {
  const text = String(rawFormula || "");
  const start = Number(activeQuery?.start);
  const end = Number(activeQuery?.end);
  const name = String(datasetName || "").trim();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || !name) {
    return null;
  }
  const insertion = `[${name}][`;
  return {
    value: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    caret: start + insertion.length,
  };
}

