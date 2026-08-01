import { shell } from "../shell/shell_context.js?v=20260510a";

const API_BASE = window.location.origin;
const LIBRARY_WINDOW_FRAGMENT_URL = "/ui/macro/macro_library_window.html?v=20260731a";
const LIBRARY_WINDOW_POSITION_KEY = "arcrho_macro_library_window_position";
const LIBRARY_STATUS_META = {
  not_installed: { label: "New", className: "not-installed", action: "Load" },
  update_available: { label: "Update", className: "update-available", action: "Update" },
  up_to_date: { label: "Loaded", className: "up-to-date", action: "Loaded" },
  local_differs: { label: "Differs", className: "local-differs", action: "Load" },
};

let libraryWindow = null;
let libraryHeader = null;
let libraryRefreshBtn = null;
let libraryCloseBtn = null;
let libraryLoadBtn = null;
let libraryList = null;
let libraryDescription = null;
let libraryStatus = null;
let libraryWindowWired = false;
let libraryWindowLoadPromise = null;
let libraryMacros = [];
let libraryUnavailableMessage = "";
let selectedLibraryMacroId = "";

function refreshLibraryElements() {
  libraryWindow = document.getElementById("macroLibraryWindow");
  libraryHeader = document.getElementById("macroLibraryHeader");
  libraryRefreshBtn = document.getElementById("macroLibraryRefreshBtn");
  libraryCloseBtn = document.getElementById("macroLibraryCloseBtn");
  libraryLoadBtn = document.getElementById("macroLibraryLoadBtn");
  libraryList = document.getElementById("macroLibraryList");
  libraryDescription = document.getElementById("macroLibraryDescription");
  libraryStatus = document.getElementById("macroLibraryStatus");
  return !!libraryWindow;
}

async function ensureLibraryWindowDom() {
  if (refreshLibraryElements()) return true;
  if (!libraryWindowLoadPromise) {
    libraryWindowLoadPromise = fetch(LIBRARY_WINDOW_FRAGMENT_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((markup) => {
        if (document.getElementById("macroLibraryWindow")) return;
        const template = document.createElement("template");
        template.innerHTML = markup.trim();
        document.body.appendChild(template.content);
      })
      .catch((err) => {
        libraryWindowLoadPromise = null;
        throw err;
      });
  }
  try {
    await libraryWindowLoadPromise;
  } catch (err) {
    const message = String(err?.message || err || "unable to load macro library window");
    shell.updateStatusBar?.(`Macro library window failed to load: ${message}`, { tone: "error" });
    return false;
  }
  return refreshLibraryElements();
}

function setLibraryStatus(text, tone = "", options = {}) {
  const message = String(text || "");
  if (libraryStatus) {
    libraryStatus.textContent = message;
    libraryStatus.dataset.tone = tone || "";
  }
  if (options.statusBar && message) {
    shell.updateStatusBar?.(message, { tone: tone || "" });
  }
}

function libraryStatusMeta(macro) {
  return LIBRARY_STATUS_META[String(macro?.status || "")] || LIBRARY_STATUS_META.not_installed;
}

function getSelectedLibraryMacro() {
  return libraryMacros.find((macro) => macro.id === selectedLibraryMacroId) || null;
}

async function loadLibraryMacros() {
  setLibraryStatus("Loading macro library...");
  try {
    const response = await fetch(`${API_BASE}/scripting/macro-library`);
    const result = await response.json();
    libraryMacros = Array.isArray(result?.macros) ? result.macros : [];
    libraryUnavailableMessage = result?.available ? "" : String(result?.message || "Macro library is not available.");
    renderLibraryList();
    renderLibraryDescription();
    if (libraryUnavailableMessage) {
      setLibraryStatus(libraryUnavailableMessage, "error");
    } else {
      const updates = libraryMacros.filter((macro) => macro.status === "update_available").length;
      setLibraryStatus(updates > 0
        ? `${libraryMacros.length} shared macro(s); ${updates} update(s) available.`
        : `${libraryMacros.length} shared macro(s) available.`);
    }
  } catch (err) {
    libraryMacros = [];
    libraryUnavailableMessage = String(err?.message || err || "Failed to load the macro library.");
    renderLibraryList();
    renderLibraryDescription();
    setLibraryStatus(`Failed to load the macro library. ${libraryUnavailableMessage}`, "error");
  }
}

function renderLibraryList() {
  if (!libraryList) return;
  libraryList.textContent = "";
  if (!libraryMacros.length) {
    const empty = document.createElement("div");
    empty.className = "macroEmpty";
    empty.textContent = libraryUnavailableMessage || "The shared macro library is empty.";
    libraryList.appendChild(empty);
    selectedLibraryMacroId = "";
    return;
  }
  if (!selectedLibraryMacroId || !libraryMacros.some((macro) => macro.id === selectedLibraryMacroId)) {
    selectedLibraryMacroId = libraryMacros[0]?.id || "";
  }
  libraryMacros.forEach((macro) => {
    const item = document.createElement("button");
    item.className = "macroListItem";
    item.type = "button";
    item.dataset.id = macro.id;
    item.classList.toggle("active", macro.id === selectedLibraryMacroId);
    item.setAttribute("aria-selected", macro.id === selectedLibraryMacroId ? "true" : "false");
    const topRow = document.createElement("span");
    topRow.className = "macroListItemTop";
    const title = document.createElement("span");
    title.className = "macroListItemName";
    title.textContent = macro.name || macro.id;
    topRow.appendChild(title);
    if (macro.version) {
      const version = document.createElement("span");
      version.className = "macroListItemVersion";
      version.textContent = `v${macro.version}`;
      topRow.appendChild(version);
    }
    const meta = libraryStatusMeta(macro);
    const status = document.createElement("span");
    status.className = `macroLibraryStatusTag ${meta.className}`;
    status.textContent = meta.label;
    topRow.appendChild(status);
    item.appendChild(topRow);
    item.title = [macro.description, macro.release_note ? `Release note: ${macro.release_note}` : "", macro.path || macro.id]
      .filter(Boolean)
      .join("\n");
    item.addEventListener("click", () => {
      selectedLibraryMacroId = macro.id;
      renderLibraryList();
      renderLibraryDescription();
    });
    libraryList.appendChild(item);
  });
}

function renderLibraryDescription() {
  if (!libraryDescription) return;
  const macro = getSelectedLibraryMacro();
  if (!macro) {
    libraryDescription.textContent = libraryUnavailableMessage
      ? "The shared macro library is not reachable."
      : "Select a shared macro to view its details.";
    if (libraryLoadBtn) {
      libraryLoadBtn.textContent = "Load";
      libraryLoadBtn.disabled = true;
    }
    return;
  }
  const lines = [macro.description || "This macro has no description section yet."];
  const detailLines = [];
  if (macro.version) detailLines.push(`Library version: ${macro.version}`);
  if (macro.release_note) detailLines.push(`Release note: ${macro.release_note}`);
  if (macro.status === "not_installed") {
    detailLines.push("Not in your local macros yet.");
  } else if (macro.status === "up_to_date") {
    detailLines.push("Your local copy is up to date.");
  } else if (macro.status === "update_available") {
    detailLines.push(`Your local copy is v${macro.local_version || "?"}; an update is available.`);
  } else if (macro.status === "local_differs") {
    detailLines.push(`Your local copy${macro.local_version ? ` (v${macro.local_version})` : ""} differs from the library version.`);
  }
  if (detailLines.length) lines.push("", ...detailLines);
  libraryDescription.textContent = lines.join("\n");
  const meta = libraryStatusMeta(macro);
  if (libraryLoadBtn) {
    libraryLoadBtn.textContent = meta.action;
    libraryLoadBtn.disabled = macro.status === "up_to_date";
  }
}

async function installSelectedLibraryMacro() {
  const macro = getSelectedLibraryMacro();
  if (!macro) {
    setLibraryStatus("Select a shared macro before loading.", "error", { statusBar: true });
    return;
  }
  if (libraryLoadBtn) libraryLoadBtn.disabled = true;
  setLibraryStatus(`Loading ${macro.name || macro.id} from the library...`);
  try {
    const install = async (overwrite) => {
      const response = await fetch(`${API_BASE}/scripting/macro-library/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macro_id: macro.id, overwrite }),
      });
      return response.json();
    };
    let result = await install(false);
    if (!result?.success && result?.needs_confirmation) {
      const confirmed = window.confirm(
        `${result.message || "A different local copy of this macro already exists."}\n\n`
        + "Replace your local copy with the library version?",
      );
      if (!confirmed) {
        setLibraryStatus("Library macro was not loaded; your local copy is unchanged.", "", { statusBar: true });
        renderLibraryDescription();
        return;
      }
      result = await install(true);
    }
    if (!result?.success) throw new Error(result?.message || "Library macro load failed.");
    setLibraryStatus(result.message || `Loaded ${macro.name || macro.id}.`, "", { statusBar: true });
    window.dispatchEvent(new CustomEvent("arcrho:local-macros-changed"));
    await loadLibraryMacros();
  } catch (err) {
    const message = String(err?.message || err || "Library macro load failed.");
    setLibraryStatus(`Library macro load failed: ${message}`, "error", { statusBar: true });
    renderLibraryDescription();
  }
}

function getLibraryWindowBounds() {
  const margin = 8;
  const styles = libraryWindow ? getComputedStyle(libraryWindow) : null;
  const minWidth = Number.parseFloat(styles?.minWidth || "") || 360;
  const minHeight = Number.parseFloat(styles?.minHeight || "") || 320;
  const statusbarHeight = Number(shell.getStatusBarHeight?.() || 0);
  return {
    margin,
    minWidth,
    minHeight,
    maxRight: Math.max(margin + minWidth, window.innerWidth - margin),
    maxBottom: Math.max(margin + minHeight, window.innerHeight - statusbarHeight - margin),
  };
}

function clampLibraryWindowRect(left, top, width, height) {
  const bounds = getLibraryWindowBounds();
  const maxWidth = Math.max(bounds.minWidth, bounds.maxRight - bounds.margin);
  const maxHeight = Math.max(bounds.minHeight, bounds.maxBottom - bounds.margin);
  const nextWidth = Math.min(Math.max(bounds.minWidth, Number(width) || bounds.minWidth), maxWidth);
  const nextHeight = Math.min(Math.max(bounds.minHeight, Number(height) || bounds.minHeight), maxHeight);
  const maxLeft = Math.max(bounds.margin, bounds.maxRight - nextWidth);
  const maxTop = Math.max(bounds.margin, bounds.maxBottom - nextHeight);
  return {
    left: Math.min(Math.max(bounds.margin, Number(left) || bounds.margin), maxLeft),
    top: Math.min(Math.max(bounds.margin, Number(top) || bounds.margin), maxTop),
    width: nextWidth,
    height: nextHeight,
  };
}

function applyLibraryWindowRect(left, top, width, height) {
  if (!libraryWindow) return;
  const next = clampLibraryWindowRect(left, top, width, height);
  libraryWindow.style.left = `${Math.round(next.left)}px`;
  libraryWindow.style.top = `${Math.round(next.top)}px`;
  libraryWindow.style.width = `${Math.round(next.width)}px`;
  libraryWindow.style.height = `${Math.round(next.height)}px`;
  libraryWindow.style.right = "auto";
  libraryWindow.style.bottom = "auto";
}

function applyLibraryWindowPosition(left, top, width, height) {
  // Drag moves the window only; size is fixed for the whole gesture so the
  // open-animation scale transform can never leak into the inline size.
  if (!libraryWindow) return;
  const next = clampLibraryWindowRect(left, top, width, height);
  libraryWindow.style.left = `${Math.round(next.left)}px`;
  libraryWindow.style.top = `${Math.round(next.top)}px`;
  libraryWindow.style.right = "auto";
  libraryWindow.style.bottom = "auto";
}

function saveLibraryWindowPosition() {
  if (!libraryWindow) return;
  const rect = libraryWindow.getBoundingClientRect();
  try {
    localStorage.setItem(LIBRARY_WINDOW_POSITION_KEY, JSON.stringify({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: libraryWindow.offsetWidth,
      height: libraryWindow.offsetHeight,
    }));
  } catch {}
}

function restoreLibraryWindowPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_WINDOW_POSITION_KEY) || "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      applyLibraryWindowRect(saved.left, saved.top, saved.width, saved.height);
    }
  } catch {}
}

function clampOpenLibraryWindow() {
  if (!libraryWindow?.classList.contains("open")) return;
  const rect = libraryWindow.getBoundingClientRect();
  applyLibraryWindowRect(rect.left, rect.top, libraryWindow.offsetWidth, libraryWindow.offsetHeight);
  saveLibraryWindowPosition();
}

function initLibraryWindowDrag() {
  if (!libraryWindow || !libraryHeader) return;
  let dragState = null;

  libraryHeader.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button")) return;
    const rect = libraryWindow.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: libraryWindow.offsetWidth,
      height: libraryWindow.offsetHeight,
    };
    try { libraryHeader.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  });

  libraryHeader.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    applyLibraryWindowPosition(
      event.clientX - dragState.offsetX,
      event.clientY - dragState.offsetY,
      dragState.width,
      dragState.height,
    );
  });

  const stopDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    try { libraryHeader.releasePointerCapture(event.pointerId); } catch {}
    saveLibraryWindowPosition();
    dragState = null;
  };

  libraryHeader.addEventListener("pointerup", stopDrag);
  libraryHeader.addEventListener("pointercancel", stopDrag);
  window.addEventListener("resize", clampOpenLibraryWindow);
}

function initLibraryWindowResize() {
  if (!libraryWindow) return;
  const handles = Array.from(libraryWindow.querySelectorAll(".macroResizeHandle"));
  if (!handles.length) return;
  let resizeState = null;

  const startResize = (event) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const rect = libraryWindow.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      edge: String(handle?.dataset?.resizeEdge || "se"),
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: libraryWindow.offsetWidth,
      height: libraryWindow.offsetHeight,
    };
    try { handle.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopPropagation();
  };

  const moveResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const dx = event.clientX - resizeState.startX;
    const dy = event.clientY - resizeState.startY;
    const edge = resizeState.edge;
    const bounds = getLibraryWindowBounds();
    const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
    // Anchor-preserving resize: the edge opposite the dragged one must never
    // move, so each axis clamps against its own fixed anchor instead of the
    // generic window clamp (which can shift the anchored edge at the limits).
    let { left, top, width, height } = resizeState;
    if (edge.includes("e")) {
      width = clamp(resizeState.width + dx, bounds.minWidth, bounds.maxRight - resizeState.left);
    }
    if (edge.includes("s")) {
      height = clamp(resizeState.height + dy, bounds.minHeight, bounds.maxBottom - resizeState.top);
    }
    if (edge.includes("w")) {
      const right = resizeState.left + resizeState.width;
      left = clamp(resizeState.left + dx, bounds.margin, right - bounds.minWidth);
      width = right - left;
    }
    if (edge.includes("n")) {
      const bottom = resizeState.top + resizeState.height;
      top = clamp(resizeState.top + dy, bounds.margin, bottom - bounds.minHeight);
      height = bottom - top;
    }
    if (!libraryWindow) return;
    libraryWindow.style.left = `${Math.round(left)}px`;
    libraryWindow.style.top = `${Math.round(top)}px`;
    libraryWindow.style.width = `${Math.round(width)}px`;
    libraryWindow.style.height = `${Math.round(height)}px`;
    libraryWindow.style.right = "auto";
    libraryWindow.style.bottom = "auto";
  };

  const stopResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch {}
    saveLibraryWindowPosition();
    resizeState = null;
  };

  handles.forEach((handle) => {
    handle.addEventListener("pointerdown", startResize);
    handle.addEventListener("pointermove", moveResize);
    handle.addEventListener("pointerup", stopResize);
    handle.addEventListener("pointercancel", stopResize);
  });
}

export async function initMacroLibraryWindow() {
  if (libraryWindowWired && refreshLibraryElements()) return true;
  if (!(await ensureLibraryWindowDom())) return false;
  if (libraryWindowWired) return true;
  libraryWindowWired = true;
  libraryCloseBtn?.addEventListener("click", closeMacroLibraryWindow);
  libraryRefreshBtn?.addEventListener("click", () => loadLibraryMacros());
  libraryLoadBtn?.addEventListener("click", installSelectedLibraryMacro);
  initLibraryWindowDrag();
  initLibraryWindowResize();
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!libraryWindow?.classList.contains("open")) return;
    closeMacroLibraryWindow();
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }, true);
  return true;
}

export async function openMacroLibraryWindow() {
  if (!(await initMacroLibraryWindow())) return;
  restoreLibraryWindowPosition();
  libraryWindow?.classList.add("open");
  void loadLibraryMacros();
}

export function closeMacroLibraryWindow() {
  refreshLibraryElements();
  libraryWindow?.classList.remove("open");
}
