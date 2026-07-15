/*
===============================================================================
DFM Notes Tab - shared Notes controller adapter
===============================================================================
*/
import { markDfmDirty } from "/ui/method_pages/dfm/dfm_state.js";
import { mountNotesTab } from "/ui/shared/tabs/notes/notes_tab.js?v=20260714a";

let notesController = null;

function setStatus(text) {
  try {
    window.parent.postMessage({ type: "arcrho:status", text: String(text || "") }, "*");
  } catch {
    // ignore
  }
}

export function getDfmNotesText() {
  return ensureNotesController()?.getValue() ?? "";
}

export function setDfmNotesText(value) {
  const nextText = typeof value === "string" ? value : "";
  ensureNotesController()?.setValue(nextText, { markClean: true });
}

function ensureNotesController() {
  if (notesController && !notesController.destroyed) return notesController;
  const container = document.getElementById("dfmNotesMount");
  if (!container) return null;
  notesController = mountNotesTab({
    container,
    ariaLabel: "Development Factor Method notes",
    onChange: () => markDfmDirty(),
    onStatus: setStatus,
  });
  return notesController;
}

export function wireNotesInput() {
  return ensureNotesController();
}
