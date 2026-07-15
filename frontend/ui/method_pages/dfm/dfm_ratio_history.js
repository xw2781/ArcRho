/*
===============================================================================
DFM Ratio History - Ratios-tab undo/redo snapshots
===============================================================================
*/
import {
  activeRatioCols,
  getDfmInst,
  getHostApi,
  getRatioColAllActive,
  markDfmDirty,
  ratioStrikeSet,
  selectedSummaryByCol,
  setRatioColAllActive,
} from "/ui/method_pages/dfm/dfm_state.js";

const HISTORY_LIMIT = 20;
const HISTORY_FORMAT = "arcrho-dfm-ratio-history-step-v1";

let undoStack = [];
let redoStack = [];
let pendingBefore = null;
let pendingSource = "";
let applyingHistory = false;
let tempDir = "";
let tempStepIndex = 0;
let saveChain = Promise.resolve();
let afterRestoreCallback = () => {};

function sortedStrings(values) {
  return Array.from(values || []).map((value) => String(value)).sort();
}

function selectedEntries() {
  return Array.from(selectedSummaryByCol.entries())
    .map(([col, rowId]) => [Number(col), String(rowId)])
    .filter(([col, rowId]) => Number.isFinite(col) && rowId)
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
}

function snapshotRatioState() {
  return {
    strikes: sortedStrings(ratioStrikeSet),
    selected: selectedEntries(),
    activeCols: Array.from(activeRatioCols).map((col) => Number(col)).filter(Number.isFinite).sort((a, b) => a - b),
    ratioColAllActive: !!getRatioColAllActive(),
  };
}

function serializeSnapshot(snapshot) {
  return JSON.stringify(snapshot || snapshotRatioState());
}

function pushLimited(stack, snapshot) {
  stack.push(snapshot);
  while (stack.length > HISTORY_LIMIT) stack.shift();
}

function notifyHistoryState() {
  try {
    window.parent.postMessage({
      type: "arcrho:dfm-history-state",
      inst: getDfmInst(),
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    }, "*");
  } catch {
    // ignore stale shell messaging
  }
}

function queueTempStep(snapshot, reason) {
  if (!tempDir) return;
  const hostApi = getHostApi();
  if (typeof hostApi?.saveDfmRatioUndoStep !== "function") return;
  const payload = {
    "json format": HISTORY_FORMAT,
    reason: String(reason || ""),
    created: new Date().toISOString(),
    state: snapshot,
  };
  const index = tempStepIndex % (HISTORY_LIMIT * 2 + 1);
  tempStepIndex += 1;
  saveChain = saveChain
    .then(() => hostApi.saveDfmRatioUndoStep({ dir: tempDir, index, data: payload }))
    .catch(() => {});
}

function applySnapshot(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  ratioStrikeSet.clear();
  sortedStrings(source.strikes).forEach((key) => ratioStrikeSet.add(key));

  selectedSummaryByCol.clear();
  if (Array.isArray(source.selected)) {
    source.selected.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return;
      const col = Number(entry[0]);
      const rowId = String(entry[1] || "");
      if (Number.isFinite(col) && rowId) selectedSummaryByCol.set(col, rowId);
    });
  }

  activeRatioCols.clear();
  if (Array.isArray(source.activeCols)) {
    source.activeCols.forEach((col) => {
      const next = Number(col);
      if (Number.isFinite(next)) activeRatioCols.add(next);
    });
  }
  setRatioColAllActive(!!source.ratioColAllActive);
}

export function initRatioHistory({ afterRestore } = {}) {
  if (typeof afterRestore === "function") afterRestoreCallback = afterRestore;
  undoStack = [];
  redoStack = [];
  pendingBefore = null;
  pendingSource = "";
  tempStepIndex = 0;
  notifyHistoryState();

  const hostApi = getHostApi();
  if (typeof hostApi?.createDfmRatioUndoSession !== "function") return;
  Promise.resolve(hostApi.createDfmRatioUndoSession({ inst: getDfmInst() }))
    .then((result) => {
      tempDir = result?.ok && result.dir ? String(result.dir) : "";
      if (tempDir) {
        queueTempStep(snapshotRatioState(), "initial");
        window.parent.postMessage({ type: "arcrho:dfm-history-session", inst: getDfmInst(), dir: tempDir }, "*");
      }
    })
    .catch(() => {
      tempDir = "";
    });
}

export function clearRatioHistoryTempSession() {
  const dir = tempDir;
  tempDir = "";
  undoStack = [];
  redoStack = [];
  pendingBefore = null;
  pendingSource = "";
  notifyHistoryState();
  if (!dir) return;
  const hostApi = getHostApi();
  if (typeof hostApi?.clearDfmRatioUndoSession !== "function") return;
  saveChain = saveChain
    .then(() => hostApi.clearDfmRatioUndoSession({ dir }))
    .catch(() => {});
}

export function beginRatioHistoryAction(source = "") {
  if (applyingHistory) return;
  if (pendingBefore) {
    commitRatioHistoryAction(`${pendingSource || source || "ratio-change"}:auto-commit`);
  }
  if (pendingBefore) return;
  pendingBefore = snapshotRatioState();
  pendingSource = String(source || "");
}

export function commitRatioHistoryAction(source = "") {
  if (applyingHistory || !pendingBefore) return;
  const before = pendingBefore;
  const reason = String(source || pendingSource || "ratio-change");
  pendingBefore = null;
  pendingSource = "";
  const after = snapshotRatioState();
  if (serializeSnapshot(before) === serializeSnapshot(after)) {
    notifyHistoryState();
    return;
  }
  pushLimited(undoStack, before);
  redoStack = [];
  queueTempStep(after, reason);
  notifyHistoryState();
}

export function cancelRatioHistoryAction() {
  pendingBefore = null;
  pendingSource = "";
  notifyHistoryState();
}

export function runRatioUndo() {
  if (!undoStack.length || applyingHistory) {
    notifyHistoryState();
    return false;
  }
  const current = snapshotRatioState();
  const previous = undoStack.pop();
  pushLimited(redoStack, current);
  applyingHistory = true;
  try {
    applySnapshot(previous);
    afterRestoreCallback(previous);
    markDfmDirty();
    queueTempStep(previous, "undo");
  } finally {
    applyingHistory = false;
    notifyHistoryState();
  }
  return true;
}

export function runRatioRedo() {
  if (!redoStack.length || applyingHistory) {
    notifyHistoryState();
    return false;
  }
  const current = snapshotRatioState();
  const next = redoStack.pop();
  pushLimited(undoStack, current);
  applyingHistory = true;
  try {
    applySnapshot(next);
    afterRestoreCallback(next);
    markDfmDirty();
    queueTempStep(next, "redo");
  } finally {
    applyingHistory = false;
    notifyHistoryState();
  }
  return true;
}

export function getRatioHistoryState() {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    tempDir,
  };
}
