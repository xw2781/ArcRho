/*
===============================================================================
DFM Notes Tab - shared Notes controller adapter
===============================================================================
*/
import { markDfmDirty } from "/ui/method_pages/dfm/dfm_state.js";
import { mountNotesTab } from "/ui/shared/tabs/notes/notes_tab.js?v=20260910a";
import { buildDfmNotesExpressionContext } from "/ui/method_pages/dfm/dfm_notes_expressions.js";

let notesController = null;
// Supplied by the orchestrator: returns the grouped method JSON payload the
// note's `{...}` placeholders read their values from.
let buildExpressionPayload = null;

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

/** Re-renders the placeholders in the note against the current method state. */
export function refreshDfmNotesView() {
  notesController?.render?.();
}

function ensureNotesController() {
  if (notesController && !notesController.destroyed) return notesController;
  const container = document.getElementById("dfmNotesPage");
  if (!container) return null;
  notesController = mountNotesTab({
    container,
    ariaLabel: "Development Factor Method notes",
    onChange: () => markDfmDirty(),
    onStatus: setStatus,
    expressionContext: () => buildDfmNotesExpressionContext(buildExpressionPayload?.() || {}),
  });
  return notesController;
}

export function wireNotesInput({ buildExpressionPayload: buildPayload } = {}) {
  if (typeof buildPayload === "function") buildExpressionPayload = buildPayload;
  return ensureNotesController();
}
