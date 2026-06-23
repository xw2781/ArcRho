import { TYPING_FRAME_MS, TYPING_MAX_FRAMES } from "./state.js";

const SQL_CHAT_KEYWORDS = new Set([
  "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "BEGIN", "BETWEEN", "BY", "CASE", "CREATE",
  "CROSS", "DELETE", "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXCEPT", "EXEC", "EXISTS",
  "FROM", "FULL", "GROUP", "HAVING", "IF", "IN", "INNER", "INSERT", "INTERSECT", "INTO",
  "IS", "JOIN", "LEFT", "LIKE", "MERGE", "NOT", "NULL", "ON", "OR", "ORDER", "OUTER",
  "OVER", "PARTITION", "RIGHT", "SELECT", "SET", "TABLE", "THEN", "TOP", "TRUNCATE",
  "UNION", "UPDATE", "VALUES", "WHEN", "WHERE", "WITH",
]);
const SQL_CHAT_FUNCTIONS = new Set([
  "AVG", "CAST", "COALESCE", "CONVERT", "COUNT", "DATEADD", "DATEDIFF", "DATENAME",
  "DATEPART", "EOMONTH", "GETDATE", "IIF", "ISNULL", "LEN", "LOWER", "MAX", "MIN",
  "NULLIF", "REPLACE", "ROUND", "ROW_NUMBER", "RTRIM", "SUM", "TRY_CAST", "TRY_CONVERT", "UPPER",
]);
const SQL_CHAT_DATATYPES = new Set([
  "BIGINT", "BINARY", "BIT", "CHAR", "DATE", "DATETIME", "DATETIME2", "DECIMAL", "FLOAT",
  "INT", "MONEY", "NCHAR", "NUMERIC", "NVARCHAR", "REAL", "SMALLDATETIME", "SMALLINT",
  "TEXT", "TIME", "TIMESTAMP", "TINYINT", "UNIQUEIDENTIFIER", "VARBINARY", "VARCHAR", "XML",
]);

export function getAssistantBrandInitial(name) {
  const text = String(name || "").trim();
  const firstAscii = Array.from(text).find((char) => /^[A-Za-z0-9]$/.test(char));
  return firstAscii ? firstAscii.toUpperCase() : "#";
}

export function createAssistantUserAvatarSvg(initial) {
  const safeInitial = getAssistantBrandInitial(initial);
  return `
    <svg viewBox="0 0 32 32" role="img" aria-label="${safeInitial} initial avatar" focusable="false">
      <text x="16" y="21" text-anchor="middle" fill="#526071" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700">${safeInitial}</text>
    </svg>
  `;
}

function decodeAssistantFileUrl(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return "";
    const pathname = decodeURIComponent(url.pathname || "");
    if (url.hostname) return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    return pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
  } catch {
    return "";
  }
}

function handleAssistantLinkClick(event) {
  const link = event.currentTarget;
  const href = String(link?.getAttribute?.("href") || "");
  if (!href.toLowerCase().startsWith("file:")) return;
  event.preventDefault();
  const filePath = decodeAssistantFileUrl(href);
  const host = window.ADAHost || null;
  if (!filePath || typeof host?.openPath !== "function") return;
  void host.openPath({ path: filePath });
}

function createAssistantMarkdownLink(label, href) {
  const linkText = String(label || "").trim();
  const rawHref = String(href || "").trim();
  let url = null;
  try {
    url = new URL(rawHref);
  } catch {
    return document.createTextNode(`[${linkText}](${rawHref})`);
  }
  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    return document.createTextNode(`[${linkText}](${rawHref})`);
  }
  const link = document.createElement("a");
  link.textContent = linkText || rawHref;
  link.href = url.href;
  if (url.protocol === "file:") {
    link.title = decodeAssistantFileUrl(url.href) || rawHref;
    link.addEventListener("click", handleAssistantLinkClick);
  } else {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return link;
}

export function appendAssistantInlineMarkdown(parent, text) {
  const raw = String(text || "");
  const pattern = /(\[[^\]\n]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  for (const match of raw.matchAll(pattern)) {
    if (match.index > lastIndex) parent.appendChild(document.createTextNode(raw.slice(lastIndex, match.index)));
    const token = match[0];
    if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]\n]+)\]\(([^)]+)\)$/);
      const el = createAssistantMarkdownLink(linkMatch?.[1] || "", linkMatch?.[2] || "");
      parent.appendChild(el);
      lastIndex = match.index + token.length;
      continue;
    }
    const el = token.startsWith("**") ? document.createElement("strong") : document.createElement("code");
    const content = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
    if (token.startsWith("**")) {
      el.textContent = content;
    } else if (shouldHighlightAssistantInlineSql(content)) {
      el.className = "aiAssistantSqlInlineCode";
      appendAssistantHighlightedSql(el, content);
    } else {
      el.textContent = content;
    }
    parent.appendChild(el);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < raw.length) parent.appendChild(document.createTextNode(raw.slice(lastIndex)));
}

function isAssistantSqlLanguage(language) {
  return /^(sql|mssql|tsql|t-sql)$/i.test(String(language || "").trim());
}

function shouldHighlightAssistantInlineSql(text) {
  const source = String(text || "").trim();
  if (!source) return false;
  const words = source.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return words.some((word, index) => {
    const upper = word.toUpperCase();
    const next = String(words[index + 1] || "").toUpperCase();
    return SQL_CHAT_KEYWORDS.has(upper) ||
      SQL_CHAT_FUNCTIONS.has(upper) ||
      SQL_CHAT_DATATYPES.has(upper) ||
      (upper === "ORDER" && next === "BY") ||
      (upper === "GROUP" && next === "BY") ||
      (upper === "LEFT" && next === "JOIN") ||
      (upper === "INNER" && next === "JOIN") ||
      (upper === "RIGHT" && next === "JOIN") ||
      (upper === "FULL" && next === "JOIN");
  });
}

function appendAssistantSqlToken(parent, text, className = "") {
  if (!text) return;
  if (!className) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  const token = document.createElement("span");
  token.className = `aiAssistantSqlToken ${className}`;
  token.textContent = text;
  parent.appendChild(token);
}

function appendAssistantHighlightedSql(parent, text) {
  const source = String(text || "");
  let index = 0;
  let inBlockComment = false;
  while (index < source.length) {
    const rest = source.slice(index);
    if (inBlockComment) {
      const end = source.indexOf("*/", index);
      const next = end >= 0 ? end + 2 : source.length;
      appendAssistantSqlToken(parent, source.slice(index, next), "comment");
      index = next;
      inBlockComment = end < 0;
      continue;
    }
    if (rest.startsWith("--")) {
      const newline = source.indexOf("\n", index);
      const next = newline >= 0 ? newline : source.length;
      appendAssistantSqlToken(parent, source.slice(index, next), "comment");
      index = next;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      const next = end >= 0 ? end + 2 : source.length;
      appendAssistantSqlToken(parent, source.slice(index, next), "comment");
      index = next;
      inBlockComment = end < 0;
      continue;
    }
    const ch = source[index];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === quote && source[index + 1] === quote) {
          index += 2;
        } else if (source[index] === quote) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      appendAssistantSqlToken(parent, source.slice(start, index), "string");
      continue;
    }
    if (ch === "[") {
      const end = source.indexOf("]", index + 1);
      if (end >= 0) {
        appendAssistantSqlToken(parent, source.slice(index, end + 1), "identifier");
        index = end + 1;
        continue;
      }
    }
    const number = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (number) {
      appendAssistantSqlToken(parent, number[0], "number");
      index += number[0].length;
      continue;
    }
    const word = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (word) {
      const value = word[0];
      const upper = value.toUpperCase();
      const after = source.slice(index + value.length).trimStart();
      if (SQL_CHAT_KEYWORDS.has(upper)) appendAssistantSqlToken(parent, value, "keyword");
      else if (SQL_CHAT_FUNCTIONS.has(upper) && after.startsWith("(")) appendAssistantSqlToken(parent, value, "function");
      else if (SQL_CHAT_DATATYPES.has(upper)) appendAssistantSqlToken(parent, value, "datatype");
      else appendAssistantSqlToken(parent, value);
      index += value.length;
      continue;
    }
    appendAssistantSqlToken(parent, ch);
    index += 1;
  }
}

function flushAssistantMarkdownList(container, listState) {
  if (!listState.items.length) return;
  const list = document.createElement(listState.ordered ? "ol" : "ul");
  if (listState.ordered && listState.start > 1) list.start = listState.start;
  for (const itemText of listState.items) {
    const item = document.createElement("li");
    appendAssistantInlineMarkdown(item, itemText);
    list.appendChild(item);
  }
  container.appendChild(list);
  listState.items = [];
  listState.ordered = false;
  listState.start = 1;
}

export function renderAssistantMarkdown(el, text) {
  if (!el) return;
  const raw = String(text || "");
  el.textContent = "";
  el.classList.toggle("rich", true);
  const lines = raw.split(/\r?\n/);
  const listState = { items: [], ordered: false, start: 1 };
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines = [];
  const flushCodeBlock = () => {
    if (!codeLines.length) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    const codeText = codeLines.join("\n");
    if (isAssistantSqlLanguage(codeLanguage)) {
      code.className = "aiAssistantSqlCode";
      appendAssistantHighlightedSql(code, codeText);
    } else {
      code.textContent = codeText;
    }
    pre.appendChild(code);
    el.appendChild(pre);
    codeLines = [];
    codeLanguage = "";
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      flushAssistantMarkdownList(el, listState);
      if (inCodeBlock) flushCodeBlock();
      else codeLanguage = fence[1] || "";
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushAssistantMarkdownList(el, listState);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const isOrdered = !!ordered;
      if (listState.items.length && listState.ordered !== isOrdered) flushAssistantMarkdownList(el, listState);
      listState.ordered = isOrdered;
      if (!listState.items.length) listState.start = isOrdered ? Number(ordered[1]) || 1 : 1;
      listState.items.push(bullet ? bullet[1] : ordered[2]);
      continue;
    }
    flushAssistantMarkdownList(el, listState);
    const paragraph = document.createElement("p");
    appendAssistantInlineMarkdown(paragraph, line);
    el.appendChild(paragraph);
  }
  flushAssistantMarkdownList(el, listState);
  if (inCodeBlock || codeLines.length) flushCodeBlock();
  if (!el.childNodes.length) el.textContent = raw;
}

export function renderAssistantMessageContent(el, role, text) {
  if (!el) return;
  if (role === "assistant") {
    renderAssistantMarkdown(el, text);
    return;
  }
  el.classList.remove("rich");
  el.textContent = text || "";
}

function prefersReducedAssistantMotion() {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

export async function typeAssistantMessage(el, text, { scrollToBottom = null } = {}) {
  if (!el) return;
  const fullText = String(text || "");
  el.classList.remove("thinking");
  el.classList.add("typing");
  if (prefersReducedAssistantMotion() || fullText.length < 48) {
    renderAssistantMarkdown(el, fullText);
    el.classList.remove("typing");
    return;
  }
  const step = Math.max(2, Math.ceil(fullText.length / TYPING_MAX_FRAMES));
  for (let index = step; index < fullText.length; index += step) {
    renderAssistantMarkdown(el, fullText.slice(0, index));
    if (typeof scrollToBottom === "function") scrollToBottom();
    await new Promise((resolve) => window.setTimeout(resolve, TYPING_FRAME_MS));
  }
  renderAssistantMarkdown(el, fullText);
  el.classList.remove("typing");
}
