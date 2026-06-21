import { TYPING_FRAME_MS, TYPING_MAX_FRAMES } from "./state.js";

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
    el.textContent = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
    parent.appendChild(el);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < raw.length) parent.appendChild(document.createTextNode(raw.slice(lastIndex)));
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
  let codeLines = [];
  const flushCodeBlock = () => {
    if (!codeLines.length) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.appendChild(code);
    el.appendChild(pre);
    codeLines = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushAssistantMarkdownList(el, listState);
      if (inCodeBlock) flushCodeBlock();
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
