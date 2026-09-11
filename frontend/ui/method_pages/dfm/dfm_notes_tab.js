/*
===============================================================================
DFM Notes Tab - shared Notes controller adapter
===============================================================================
*/
import { markDfmDirty } from "/ui/method_pages/dfm/dfm_state.js";
import { mountNotesTab } from "/ui/shared/tabs/notes/notes_tab.js?v=20260910b";
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

/**
 * The raw-text range last selected in the note. A macro that works on a
 * selection reads this; `start === end` means the whole note.
 */
export function getDfmNotesSelection() {
  return ensureNotesController()?.getSelection?.() ?? { start: 0, end: 0 };
}

/**
 * The two note fields a save stores in the output sidecar: `notes` is the
 * text with every placeholder rendered, for readers that cannot render such
 * as the ResQ export; `notes_source` is the raw text the tab edits, and is
 * empty when the note has no placeholders.
 */
export function getDfmNotesSaveFields() {
  const source = getDfmNotesText();
  const rendered = ensureNotesController()?.getRenderedValue?.() ?? source;
  return { notes: rendered, notes_source: rendered === source ? "" : source };
}

/** The text the Notes tab edits for a loaded output sidecar. */
export function notesTextFromSidecar(sidecar) {
  const source = sidecar?.notes_source;
  if (typeof source === "string" && source) return source;
  return String(sidecar?.notes ?? "");
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
