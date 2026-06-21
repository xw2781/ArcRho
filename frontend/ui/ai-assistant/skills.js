const SQL_KEYWORDS = new Set([
  "add", "all", "alter", "and", "as", "asc", "begin", "between", "by", "case", "close", "clustered",
  "constraint", "create", "cross", "cursor", "deallocate", "declare", "delete", "desc", "distinct", "drop",
  "else", "end", "except", "exec", "execute", "exists", "from", "full", "group", "having", "if", "in",
  "index", "inner", "insert", "intersect", "into", "is", "join", "left", "like", "local", "merge", "not",
  "null", "on", "openquery", "or", "order", "outer", "over", "partition", "primary", "read_only",
  "right", "row_number", "select", "set", "static", "table", "then", "top", "truncate", "union", "update",
  "values", "when", "where", "with",
]);

const SQL_FUNCTIONS = new Set([
  "avg", "cast", "coalesce", "convert", "count", "dateadd", "datediff", "datename", "datepart", "db_name",
  "eomonth", "getdate", "iif", "isnull", "len", "lower", "ltrim", "max", "min", "nullif", "rank",
  "replace", "round", "row_number", "rtrim", "sum", "try_cast", "try_convert", "upper",
]);

const SQL_DATATYPES = new Set([
  "bigint", "binary", "bit", "char", "date", "datetime", "datetime2", "datetimeoffset", "decimal",
  "float", "image", "int", "money", "nchar", "ntext", "numeric", "nvarchar", "real", "smalldatetime",
  "smallint", "smallmoney", "text", "time", "timestamp", "tinyint", "uniqueidentifier", "varbinary",
  "varchar", "xml",
]);

const MAJOR_CLAUSE_RE = /^(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|UNION|UNION ALL|EXCEPT|INTERSECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|MERGE|WITH|SET|VALUES)\b/i;
const JOIN_RE = /^(INNER|LEFT|RIGHT|FULL|CROSS)?\s*(OUTER\s+)?JOIN\b/i;

export const SQL_FORMAT_VALIDATION_SKILL = {
  id: "sql-format-validation",
  title: "SQL Format Validation",
  subtitle: "Format active MSSQL code, review a diff, then apply on approval.",
  badge: "SQL",
};

export const SQL_CODING_STANDARDS_PATH = "F:\\NewJersey\\Repos\\The Binder\\app\\pages\\sql-coding-standards.html";
export const SQL_CODING_STANDARDS_URL = "file:///F:/NewJersey/Repos/The%20Binder/app/pages/sql-coding-standards.html";
export const SQL_CODING_STANDARDS_MARKDOWN_LINK = `[SQL Coding Standards](${SQL_CODING_STANDARDS_URL})`;

function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function isSqlLineComment(line) {
  return /^\s*--/.test(String(line || ""));
}

function splitTopLevelCommas(value) {
  const text = String(value || "");
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1] || "";
    if (quote) {
      if (ch === quote && next === quote) {
        i += 1;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[" && !quote) {
      quote = "]";
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function transformCodeWords(segment) {
  return String(segment || "").replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (word, offset, source) => {
    const key = word.toLowerCase();
    if (SQL_DATATYPES.has(key)) return key;
    const after = source.slice(offset + word.length).trimStart();
    if (SQL_FUNCTIONS.has(key) && after.startsWith("(")) return key.toUpperCase();
    if (SQL_KEYWORDS.has(key)) return key.toUpperCase();
    return word;
  });
}

function normalizeCodeSpacing(segment) {
  return transformCodeWords(segment)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*(<=|>=|<>|!=|=|<|>)\s*/g, " $1 ")
    .replace(/\s+\)/g, ")")
    .replace(/\(\s+/g, "(")
    .replace(/\s+;/g, ";")
    .replace(/\s+$/g, "");
}

function normalizeSqlLine(line, state) {
  if (isSqlLineComment(line)) return line;
  let output = "";
  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        output += line.slice(i);
        return output;
      }
      output += line.slice(i, end + 2);
      i = end + 2;
      state.inBlockComment = false;
      continue;
    }
    if (line.startsWith("--", i)) {
      output += line.slice(i);
      return output;
    }
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        output += line.slice(i);
        state.inBlockComment = true;
        return output;
      }
      output += line.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < line.length) {
        if (line[i] === quote && line[i + 1] === quote) {
          i += 2;
        } else if (line[i] === quote) {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      output += line.slice(start, i);
      continue;
    }
    if (ch === "[") {
      const end = line.indexOf("]", i + 1);
      if (end >= 0) {
        output += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const start = i;
    while (i < line.length && !line.startsWith("--", i) && !line.startsWith("/*", i) && !["'", '"', "["].includes(line[i])) {
      i += 1;
    }
    output += normalizeCodeSpacing(line.slice(start, i));
  }
  return output;
}

function breakClauses(line) {
  if (isSqlLineComment(line)) return String(line || "");
  return String(line || "")
    .replace(/\s+\b(FROM|WHERE|HAVING|GROUP\s+BY|ORDER\s+BY|UNION\s+ALL|UNION|EXCEPT|INTERSECT)\b/gi, "\n$1")
    .replace(/\s+\b((?:INNER|LEFT|RIGHT|FULL|CROSS)(?:\s+OUTER)?\s+JOIN|JOIN)\b/gi, "\n$1")
    .replace(/\s+\b(ON)\b\s+/gi, "\n    $1 ")
    .replace(/\s+\b(AND|OR)\b\s+/gi, (match, op, offset, source) => {
      const before = source.slice(Math.max(0, offset - 32), offset);
      return /\bBETWEEN\s+\S+\s*$/i.test(before) ? match : `\n    ${op} `;
    });
}

function expandCommaList(line) {
  const trimmed = line.trim();
  const select = trimmed.match(/^SELECT\s+(.+)$/i);
  if (select && !/^\*/.test(select[1].trim())) {
    const parts = splitTopLevelCommas(select[1]);
    if (parts.length > 1) return ["SELECT", ...parts.map((part, index) => `${part}${index < parts.length - 1 ? "," : ""}`)];
  }
  const ordered = trimmed.match(/^(GROUP BY|ORDER BY)\s+(.+)$/i);
  if (ordered) {
    const parts = splitTopLevelCommas(ordered[2]);
    if (parts.length > 1) return [ordered[1].toUpperCase(), ...parts.map((part, index) => `${part}${index < parts.length - 1 ? "," : ""}`)];
  }
  return [trimmed];
}

function indentSqlLines(lines) {
  const output = [];
  let indent = 0;
  let clauseMode = "";
  for (const rawLine of lines) {
    const trimmed = String(rawLine || "").trim();
    if (!trimmed) {
      if (output.length && output[output.length - 1] !== "") output.push("");
      continue;
    }
    if (isSqlLineComment(rawLine)) {
      output.push(String(rawLine || ""));
      continue;
    }
    const expanded = expandCommaList(trimmed);
    for (const part of expanded) {
      const line = part.trim();
      if (!line) continue;
      if (/^END\b/i.test(line)) indent = Math.max(0, indent - 1);
      const isMajor = MAJOR_CLAUSE_RE.test(line) || JOIN_RE.test(line);
      if (isMajor) clauseMode = line.match(MAJOR_CLAUSE_RE)?.[1]?.toUpperCase() || "JOIN";
      const isContinuation = !isMajor && /^(SELECT|WHERE|GROUP BY|ORDER BY|HAVING|SET|VALUES)$/i.test(clauseMode);
      const extra = /^(AND|OR|ON|WHEN|ELSE)\b/i.test(line) ? 1 : (isContinuation ? 1 : 0);
      output.push(`${"    ".repeat(indent + extra)}${line}`);
      if (/\b(BEGIN|CASE)\s*$/i.test(line) || /^BEGIN\b/i.test(line)) indent += 1;
    }
  }
  return output;
}

function addFinalSemicolon(lines) {
  const next = [...lines];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const line = next[i].trim();
    if (!line || line.startsWith("--") || line.startsWith("/*")) continue;
    if (/[;]$/.test(line) || /^GO$/i.test(line)) break;
    if (/^(SELECT|INSERT|UPDATE|DELETE|MERGE|EXEC|WITH|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(line)) {
      next[i] = `${next[i]};`;
    }
    break;
  }
  return next;
}

export function formatMssqlSql(source) {
  const normalized = normalizeLineEndings(source).replace(/\t/g, "    ");
  const state = { inBlockComment: false };
  const normalizedLines = normalized
    .split("\n")
    .map((line) => normalizeSqlLine(line.replace(/\s+$/g, ""), state));
  const clauseLines = normalizedLines.flatMap((line) => breakClauses(line).split("\n"));
  const indented = addFinalSemicolon(indentSqlLines(clauseLines));
  return `${indented.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/g, "")}\n`;
}

export function buildSqlFormatFindings(source, proposed) {
  const text = normalizeLineEndings(source);
  const proposedText = normalizeLineEndings(proposed);
  const findings = [];
  const statementLikeCount = countSqlPattern(text, /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|EXEC|WITH)\b/gi);
  if (statementLikeCount > 1) {
    findings.push(`Review all SQL blocks in this batch; detected ${statementLikeCount} statement-like keywords.`);
  }
  if (/SELECT\s+\*/i.test(text) && !/EXISTS\s*\(\s*SELECT\s+\*/i.test(text)) {
    findings.push("Review SELECT * usage; standards prefer selecting only needed columns except inside EXISTS.");
  }
  if (/\bDISTINCT\b/i.test(text)) {
    findings.push("Review DISTINCT; standards warn it can mask join or filter issues.");
  }
  if (/\bSELECT\b[\s\S]{0,800}\bINTO\b/i.test(text)) {
    findings.push("Review SELECT INTO; standards prefer creating tables explicitly before INSERT INTO except structure-only copies.");
  }
  if (/\bEXEC\s*\(|sp_executesql|nvarchar\s*\(\s*max\s*\).*SELECT/i.test(text)) {
    findings.push("Review dynamic SQL and parameterization; avoid dynamic SQL unless there is a clear need.");
  }
  const tempMatches = [...text.matchAll(/#[A-Za-z_][A-Za-z0-9_]*/g)].map((match) => match[0].toLowerCase());
  const tempTables = Array.from(new Set(tempMatches));
  for (const tableName of tempTables) {
    const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\bDROP\\s+TABLE\\s+${escaped}\\b`, "i").test(text)) {
      findings.push(`Review temp-table cleanup; ${tableName} is referenced without a matching DROP TABLE.`);
      break;
    }
  }
  if (/\bDECLARE\b[\s\S]{0,120}\bCURSOR\b/i.test(text) && !/\bCLOSE\b[\s\S]{0,400}\bDEALLOCATE\b/i.test(text)) {
    findings.push("Review cursor cleanup/options; standards prefer LOCAL READ_ONLY FORWARD_ONLY STATIC when cursors are necessary.");
  }
  if (text !== proposedText) {
    findings.unshift("Deterministic formatting changed keyword/function case, spacing, clause breaks, or indentation.");
  } else {
    findings.unshift("No deterministic formatting changes were needed.");
  }
  return findings;
}

function countSqlPattern(source, pattern) {
  return (String(source || "").match(pattern) || []).length;
}

function numberSqlLines(source) {
  const lines = normalizeLineEndings(source).split("\n");
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, " ")} | ${line}`).join("\n");
}

export function buildSqlReviewPrompt({ title, path, original, proposed, findings }) {
  const originalText = normalizeLineEndings(original);
  const proposedText = normalizeLineEndings(proposed);
  const originalLineText = numberSqlLines(originalText);
  const selectCount = countSqlPattern(originalText, /\bSELECT\b/gi);
  const statementLikeCount = countSqlPattern(originalText, /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|EXEC|WITH)\b/gi);
  const sectionCommentCount = countSqlPattern(originalText, /^\s*--.+$/gmi);
  const standards = [
    "Priorities: functionality, maintainability, clarity, consistency.",
    "Capitalize SQL keywords and built-in functions; keep built-in datatypes lowercase.",
    "Indent BEGIN/END blocks, subqueries, JOIN/ON clauses, and multi-line SELECT/WHERE/GROUP BY/ORDER BY clauses.",
    "Use spaces around operators and after commas; use trailing commas in checked-in production SQL.",
    "End statements with semicolons.",
    "Review DISTINCT, SELECT *, SELECT INTO, dynamic SQL, cursors, temp table cleanup, indexing, and datatype choices as advisory items rather than automatic rewrites.",
  ].join("\n- ");
  return [
    "Review this MSSQL after ArcBot's deterministic SQL Format Validation pass.",
    "Review the entire SQL batch, including every statement and every block after section comments. Do not stop after the first SELECT.",
    "Return concise findings only. Do not use Markdown heading markers such as #, ##, or ###.",
    "Use exactly these bold Markdown group labels as standalone lines:",
    "**1. Syntax and formatting suggestions beyond deterministic validation**",
    "**2. Performance and optimizations**",
    "Start every issue bullet with the original SQL line number before the issue text, for example `Line 12:` or `Lines 12-14:`. Use `Line unknown:` only when the relevant original line cannot be identified.",
    "Do not repeat deterministic formatting changes as findings. Do not force a note for every block; mention only statements or blocks with material issues. If a section has no material findings, write \"No material findings.\" Do not include the standards link; ArcBot adds it separately. Do not rewrite the full SQL unless there is a small high-confidence correction.",
    "",
    `File: ${title || "active SQL tab"}${path ? ` (${path})` : ""}`,
    `Batch shape: ${statementLikeCount || "unknown"} statement-like keyword${statementLikeCount === 1 ? "" : "s"}, ${selectCount} SELECT keyword${selectCount === 1 ? "" : "s"}, ${sectionCommentCount} section comment${sectionCommentCount === 1 ? "" : "s"}.`,
    "",
    `Standards summary:\n- ${standards}`,
    "",
    `Deterministic findings:\n- ${(findings || []).join("\n- ")}`,
    "",
    "Original SQL with line numbers:",
    "```sql",
    originalLineText.slice(0, 24000),
    "```",
    "",
    "Formatted SQL:",
    "```sql",
    proposedText.slice(0, 24000),
    "```",
  ].join("\n");
}
