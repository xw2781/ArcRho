// The Home "Color Theme" dialog: a live snapshot of each table style beside a
// Light / Dark switch. Picking a style or mode applies it at once, so the
// snapshot a user clicks is the look the app takes.
import { shell } from "./shell_context.js?v=20260510a";

const PREVIEW_URL = "/ui/shell/table_style_preview/table_style_preview.html";
const PREVIEW_VERSION = "20260923c";

const TABLE_STYLE_OPTIONS = [
  {
    value: "revolutionary",
    label: "Revolutionary",
    tag: "Default",
    description: "Clear slate grid lines, pale headers, and flat tabs with an underline.",
  },
  {
    value: "classic",
    label: "Classic",
    tag: "",
    description: "The original look: faint grid lines, gray headers, and boxed tabs.",
  },
];

const MODE_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

let overlay = null;
let lastFocus = null;

function themeApi() {
  return window.ArcRhoColorTheme;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function buildOverlay() {
  const node = document.createElement("div");
  node.id = "colorThemeDialogOverlay";
  node.className = "host-nodrag";
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-labelledby", "colorThemeDialogTitle");
  const tiles = TABLE_STYLE_OPTIONS.map((option) => `
    <button class="colorThemeTile" type="button" role="radio" aria-checked="false" tabindex="-1"
      data-table-style="${option.value}" id="colorThemeTile-${option.value}">
      <span class="colorThemeTileFrame">
        <iframe class="colorThemeTilePreview" title="${escapeHtml(option.label)} table style preview"
          tabindex="-1" aria-hidden="true" data-preview-style="${option.value}"></iframe>
      </span>
      <span class="colorThemeTileText">
        <span class="colorThemeTileName">
          <span>${escapeHtml(option.label)}</span>
          ${option.tag ? `<span class="colorThemeTileTag">${escapeHtml(option.tag)}</span>` : ""}
          <svg class="colorThemeTileCheck" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><polyline points="2,6.5 4.7,9 10,3"></polyline></svg>
        </span>
        <span class="colorThemeTileDescription">${escapeHtml(option.description)}</span>
      </span>
    </button>`).join("");
  const modes = MODE_OPTIONS.map((option) => `
    <button class="colorThemeMode" type="button" role="radio" aria-checked="false" tabindex="-1"
      data-color-mode="${option.value}" id="colorThemeMode-${option.value}">${escapeHtml(option.label)}</button>`).join("");
  node.innerHTML = `
    <div id="colorThemeDialogBox">
      <div class="colorThemeDialogHead">
        <div id="colorThemeDialogTitle">Color Theme</div>
        <div class="colorThemeDialogHint">Changes apply right away.</div>
      </div>
      <div class="colorThemeSectionLabel" id="colorThemeStyleLabel">Table Style</div>
      <div class="colorThemeTiles" role="radiogroup" aria-labelledby="colorThemeStyleLabel">${tiles}</div>
      <div class="colorThemeModeRow">
        <span class="colorThemeSectionLabel" id="colorThemeModeLabel">Mode</span>
        <div class="colorThemeModes" role="radiogroup" aria-labelledby="colorThemeModeLabel">${modes}</div>
      </div>
      <div class="colorThemeDialogButtons">
        <button class="appConfirmBtn primary" id="colorThemeDoneBtn" type="button">Done</button>
      </div>
    </div>`;
  document.body.appendChild(node);
  wireOverlay(node);
  return node;
}

function syncSelection() {
  if (!overlay) return;
  const style = themeApi()?.getTableStyle?.() || "revolutionary";
  const mode = shell.getColorTheme?.() || themeApi()?.getTheme?.() || "light";
  for (const tile of overlay.querySelectorAll(".colorThemeTile")) {
    const selected = tile.dataset.tableStyle === style;
    tile.setAttribute("aria-checked", selected ? "true" : "false");
    tile.tabIndex = selected ? 0 : -1;
  }
  for (const button of overlay.querySelectorAll(".colorThemeMode")) {
    const selected = button.dataset.colorMode === mode;
    button.setAttribute("aria-checked", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
  }
}

// The snapshots follow Light and Dark but never the table style: each one is
// locked to the style it shows.
function postModeToPreviews(mode) {
  if (!overlay) return;
  const api = themeApi();
  const type = api?.MESSAGE_TYPE || "arcrho:set-color-theme";
  for (const frame of overlay.querySelectorAll(".colorThemeTilePreview")) {
    try {
      frame.contentWindow?.postMessage({ type, theme: mode }, "*");
    } catch {
      // A preview still loading reads the stored mode when it starts.
    }
  }
}

function loadPreviews() {
  for (const frame of overlay.querySelectorAll(".colorThemeTilePreview")) {
    if (frame.getAttribute("src")) continue;
    const params = new URLSearchParams({ tableStyle: frame.dataset.previewStyle, v: PREVIEW_VERSION });
    frame.setAttribute("src", `${PREVIEW_URL}?${params.toString()}`);
  }
}

function chooseTableStyle(style) {
  const api = themeApi();
  if (!api?.setTableStyle) return;
  if (api.getTableStyle?.() === style) return;
  api.setTableStyle(style, { source: "home" });
  const label = TABLE_STYLE_OPTIONS.find((option) => option.value === style)?.label || style;
  shell.updateStatusBar?.(`Table style changed to ${label}.`);
  syncSelection();
}

function chooseMode(mode) {
  if ((shell.getColorTheme?.() || "light") === mode) return;
  shell.setColorTheme?.(mode);
  const label = MODE_OPTIONS.find((option) => option.value === mode)?.label || mode;
  shell.updateStatusBar?.(`Color theme changed to ${label}.`);
  syncSelection();
}

function moveWithinGroup(event, selector, choose, key) {
  const moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(event.key in moves)) return false;
  const items = Array.from(overlay.querySelectorAll(selector));
  const index = items.indexOf(event.target.closest(selector));
  if (index < 0) return false;
  event.preventDefault();
  const next = items[(index + moves[event.key] + items.length) % items.length];
  choose(next.dataset[key]);
  next.focus();
  return true;
}

function wireOverlay(node) {
  node.addEventListener("click", (event) => {
    if (event.target === node) {
      closeColorThemeDialog();
      return;
    }
    const tile = event.target.closest(".colorThemeTile");
    if (tile) {
      chooseTableStyle(tile.dataset.tableStyle);
      tile.focus();
      return;
    }
    const mode = event.target.closest(".colorThemeMode");
    if (mode) {
      chooseMode(mode.dataset.colorMode);
      mode.focus();
      return;
    }
    if (event.target.closest("#colorThemeDoneBtn")) closeColorThemeDialog();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeColorThemeDialog();
      return;
    }
    if (event.target.closest(".colorThemeTile")) {
      moveWithinGroup(event, ".colorThemeTile", chooseTableStyle, "tableStyle");
    } else if (event.target.closest(".colorThemeMode")) {
      moveWithinGroup(event, ".colorThemeMode", chooseMode, "colorMode");
    }
    if (event.key === "Tab") trapFocus(event);
  });
  const api = themeApi();
  window.addEventListener(api?.CHANGE_EVENT || "arcrho:color-theme-changed", (event) => {
    postModeToPreviews(event?.detail?.theme);
    syncSelection();
  });
  window.addEventListener(api?.TABLE_STYLE_CHANGE_EVENT || "arcrho:table-style-changed", () => syncSelection());
}

function trapFocus(event) {
  const focusable = Array.from(overlay.querySelectorAll("button"))
    .filter((button) => button.tabIndex >= 0 && !button.disabled);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openColorThemeDialog() {
  if (!overlay) overlay = buildOverlay();
  lastFocus = document.activeElement;
  syncSelection();
  loadPreviews();
  overlay.classList.add("open");
  requestAnimationFrame(() => {
    overlay.querySelector('.colorThemeTile[aria-checked="true"]')?.focus();
  });
}

export function closeColorThemeDialog() {
  if (!overlay?.classList.contains("open")) return;
  overlay.classList.remove("open");
  try {
    lastFocus?.focus?.();
  } catch {
    // The card that opened the dialog may have been re-rendered.
  }
}
