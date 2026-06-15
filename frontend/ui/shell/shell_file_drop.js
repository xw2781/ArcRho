import { shell } from "./shell_context.js?v=20260510a";

const NOTEBOOK_EXTENSIONS = new Set([".ipynb", ".arcnb", ".py"]);

let shellFileDropsWired = false;
let dragOverlayEl = null;
let dragOverlayTitleEl = null;
let dragOverlayDetailEl = null;
let hideOverlayTimer = 0;

function ensureDragOverlay() {
  if (dragOverlayEl) return dragOverlayEl;
  dragOverlayEl = document.createElement("div");
  dragOverlayEl.id = "shellFileDropOverlay";
  dragOverlayEl.setAttribute("aria-hidden", "true");
  Object.assign(dragOverlayEl.style, {
    position: "fixed",
    inset: "48px 12px 28px 12px",
    zIndex: "8900",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    border: "2px dashed rgba(37, 99, 235, 0.72)",
    borderRadius: "10px",
    background: "rgba(239, 246, 255, 0.72)",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.7)",
    backdropFilter: "blur(1px)",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    minWidth: "320px",
    maxWidth: "520px",
    padding: "18px 22px",
    border: "1px solid #bfdbfe",
    borderRadius: "8px",
    background: "#ffffff",
    boxShadow: "0 14px 34px rgba(15, 23, 42, 0.18)",
    color: "#1f2937",
    textAlign: "center",
  });

  dragOverlayTitleEl = document.createElement("div");
  Object.assign(dragOverlayTitleEl.style, {
    fontSize: "15px",
    fontWeight: "700",
    lineHeight: "1.35",
  });

  dragOverlayDetailEl = document.createElement("div");
  Object.assign(dragOverlayDetailEl.style, {
    marginTop: "5px",
    fontSize: "12px",
    color: "#5b6472",
    lineHeight: "1.35",
  });

  panel.appendChild(dragOverlayTitleEl);
  panel.appendChild(dragOverlayDetailEl);
  dragOverlayEl.appendChild(panel);
  document.body.appendChild(dragOverlayEl);
  return dragOverlayEl;
}

function hasExternalFiles(event) {
  const transfer = event?.dataTransfer;
  if (!transfer) return false;
  const types = Array.from(transfer.types || []);
  if (types.includes("Files")) return true;
  return Array.from(transfer.items || []).some((item) => item?.kind === "file");
}

function getPathExtension(pathLike) {
  const value = String(pathLike || "").trim().toLowerCase();
  const dot = value.lastIndexOf(".");
  return dot >= 0 ? value.slice(dot) : "";
}

function getDraggedFileEntries(event) {
  return Array.from(event?.dataTransfer?.files || []).map((file) => ({
    file,
    name: String(file?.name || "").trim(),
    path: getDroppedFilePath(file),
  }));
}

function getNotebookEntriesFromFiles(files) {
  const seen = new Set();
  const paths = [];
  const names = [];
  for (const entry of files) {
    const filePath = String(entry?.path || "").trim();
    const name = String(entry?.name || "").trim();
    const extension = getPathExtension(filePath || name);
    if (!NOTEBOOK_EXTENSIONS.has(extension)) continue;
    const key = (filePath || name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (filePath) paths.push(filePath);
    names.push(name || filePath);
  }
  return { paths, names };
}

function getDropHint(event) {
  const fileEntries = getDraggedFileEntries(event);
  const notebookEntries = getNotebookEntriesFromFiles(fileEntries);
  if (notebookEntries.names.length) {
    const count = notebookEntries.names.length;
    return {
      supported: true,
      title: count === 1
        ? "Drop to open notebook in Arcode"
        : `Drop to open ${count} scripting files in Arcode`,
      detail: count === 1 ? notebookEntries.names[0] : ".ipynb, .arcnb, and .py files are supported.",
    };
  }
  if (!fileEntries.length) {
    return {
      supported: true,
      title: "Drop notebook or Python file to open in Arcode",
      detail: ".ipynb, .arcnb, and .py files are supported.",
    };
  }
  return {
    supported: false,
    title: "Drop an .ipynb, .arcnb, or .py scripting file",
    detail: "Other file types are not opened by the shell drop target.",
  };
}

function showDragOverlay(event) {
  const hint = getDropHint(event);
  const overlay = ensureDragOverlay();
  clearTimeout(hideOverlayTimer);
  if (dragOverlayTitleEl) dragOverlayTitleEl.textContent = hint.title;
  if (dragOverlayDetailEl) dragOverlayDetailEl.textContent = hint.detail;
  overlay.style.borderColor = hint.supported ? "rgba(37, 99, 235, 0.72)" : "rgba(220, 38, 38, 0.62)";
  overlay.style.background = hint.supported ? "rgba(239, 246, 255, 0.72)" : "rgba(254, 242, 242, 0.72)";
  overlay.style.display = "flex";
  hideOverlayTimer = window.setTimeout(hideDragOverlay, 350);
}

function hideDragOverlay() {
  clearTimeout(hideOverlayTimer);
  hideOverlayTimer = 0;
  if (dragOverlayEl) dragOverlayEl.style.display = "none";
}

function getDroppedFilePath(file) {
  if (!file) return "";
  const hostApi = shell.getHostApi?.();
  if (typeof hostApi?.getPathForFile === "function") {
    try {
      const resolved = hostApi.getPathForFile(file);
      if (resolved) return String(resolved);
    } catch {
      // ignore
    }
  }
  return typeof file.path === "string" ? file.path : "";
}

function getDroppedNotebookPaths(event) {
  return getNotebookEntriesFromFiles(getDraggedFileEntries(event)).paths;
}

export function handleShellFileDragOver(event) {
  if (!hasExternalFiles(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  showDragOverlay(event);
  return true;
}

export function handleShellFileDrop(event) {
  if (!hasExternalFiles(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  hideDragOverlay();

  const notebookPaths = getDroppedNotebookPaths(event);
  if (!notebookPaths.length) {
    shell.updateStatusBar?.("Drop an .ipynb, .arcnb, or .py scripting file to open it in Arcode.", { tone: "warning" });
    return true;
  }

  for (const notebookPath of notebookPaths) {
    shell.openScriptingTab?.({ forceNew: true, notebookPath });
  }

  const label = notebookPaths.length === 1 ? "scripting file" : `${notebookPaths.length} scripting files`;
  shell.updateStatusBar?.(`Opening ${label} in Arcode...`);
  return true;
}

export function initShellFileDrops() {
  if (shellFileDropsWired) return;
  shellFileDropsWired = true;
  window.addEventListener("dragover", handleShellFileDragOver, true);
  window.addEventListener("drop", handleShellFileDrop, true);
  window.addEventListener("dragleave", () => {
    clearTimeout(hideOverlayTimer);
    hideOverlayTimer = window.setTimeout(hideDragOverlay, 120);
  }, true);
  window.addEventListener("blur", hideDragOverlay);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideDragOverlay();
  }, true);
}
