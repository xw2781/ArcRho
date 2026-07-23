// ---------------------------------------------------------------------------
// Notebook Editor - JupyterLab-style cell-based execution
// ---------------------------------------------------------------------------

const arcodeShared = window.ArcodeEditorShared || {};
const scriptingSessionId = arcodeShared.getOrCreateScriptingSessionId();
const scriptingQueryParams = new URLSearchParams(window.location.search);
const scriptingTabInstanceId = arcodeShared.sanitizeStorageId(scriptingQueryParams.get("inst") || "");
const forceFreshNotebook = scriptingQueryParams.get("fresh") === "1";
const skipLastNotebookLoad = scriptingQueryParams.get("skipLast") === "1";
const LEGACY_CELLS_STORAGE_KEY = "sc_cells";
const CELLS_STORAGE_KEY = scriptingTabInstanceId
  ? `${LEGACY_CELLS_STORAGE_KEY}_${scriptingTabInstanceId}`
  : LEGACY_CELLS_STORAGE_KEY;

function scriptingFetch(path, options = {}) {
  return arcodeShared.scriptingFetch(path, options, scriptingSessionId);
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const cellsArea = document.getElementById("cellsArea");
const addCellBottom = document.getElementById("addCellBottom");
const addCellBtn = document.getElementById("addCellBtn");
const newCellTypeSelect = document.getElementById("newCellTypeSelect");
const runAllBtn = document.getElementById("runAllBtn");
const stopBtn = document.getElementById("stopBtn");
const restartBtn = document.getElementById("restartBtn");
const clearOutputBtn = document.getElementById("clearOutputBtn");
const shortcutsBtn = document.getElementById("shortcutsBtn");
const notebookFileBanner = document.getElementById("notebookFileBanner");
const notebookFileBannerMessage = document.getElementById("notebookFileBannerMessage");
const reloadDiskNotebookBtn = document.getElementById("reloadDiskNotebookBtn");
const saveNotebookCopyBtn = document.getElementById("saveNotebookCopyBtn");
const overwriteDiskNotebookBtn = document.getElementById("overwriteDiskNotebookBtn");
const sidebar = document.getElementById("sidebar");
const sidebarContent = document.getElementById("sidebarContent");
const sidebarTopSlot = document.getElementById("sidebarTopSlot");
const sidebarBottomSlot = document.getElementById("sidebarBottomSlot");
const sidebarSplitHandle = document.getElementById("sidebarSplitHandle");
const tocView = document.getElementById("tocView");
const tocBody = document.getElementById("tocBody");
const tocHeader = document.querySelector(".sc-toc-header");
const tocHeadingNumbersBtn = document.getElementById("tocHeadingNumbersBtn");
const varsView = document.getElementById("varsView");
const varsHeader = document.querySelector(".sc-vars-header");
const varsBody = document.getElementById("varsBody");
const statusText = document.getElementById("statusText");
const resizeHandle = document.getElementById("resizeHandle");
const shortcutsOverlay = document.getElementById("shortcutsOverlay");
const shortcutsCloseBtn = document.getElementById("shortcutsCloseBtn");
const shortcutsCancelBtn = document.getElementById("shortcutsCancelBtn");
const shortcutsSaveBtn = document.getElementById("shortcutsSaveBtn");
const shortcutsResetBtn = document.getElementById("shortcutsResetBtn");
const shortcutsError = document.getElementById("shortcutsError");
const shortcutInputs = Array.from(document.querySelectorAll(".sc-shortcuts-input"));

// ---------------------------------------------------------------------------
// Cell state
// ---------------------------------------------------------------------------
let cells = [];       // { id, type, editor, editorEl, topRowEl, inputFrameEl, bottomRowEl, outputSidePlaceholderEl, outputEl, outputFrameEl, labelEl, cellEl, runBtn, sectionToggleBtn, sectionCodeCountBadge, executionCount, outputs, markdownRendered, hiddenByControllers }
let nextCellId = 1;
let focusedCellId = null;
let editingCellId = null;
let rangeSelectionAnchorId = null;
let isRunning = false;
let monacoReady = false;
let draggingCellId = null;
let draggingCellIds = [];
const CELL_DRAG_MIME = "application/x-arcode-cell-id";
const SHORTCUTS_STORAGE_KEY = "sc_shortcuts";
const CELL_TYPES = Object.freeze({
  CODE: "code",
  MARKDOWN: "markdown",
  RAW: "raw",
});
const SHORTCUT_ACTIONS = [
  { id: "runCellPrimary", label: "Run cell (primary)" },
  { id: "runCellAlternate", label: "Run cell (alternate)" },
  { id: "runCellAdvance", label: "Run and advance to next cell" },
  { id: "toggleLineNumbers", label: "Toggle code cell line numbers" },
  { id: "clearCellOutput", label: "Clear current cell output" },
  { id: "undoNotebook", label: "Undo notebook change" },
  { id: "redoNotebook", label: "Redo notebook change" },
  { id: "addCellBefore", label: "Add new cell before current" },
  { id: "addCellAfter", label: "Add new cell after current" },
  { id: "copyCell", label: "Copy current cell" },
  { id: "pasteCellAfter", label: "Paste cell after current" },
  { id: "cutCell", label: "Cut current cell" },
  { id: "deleteCellDoubleTap", label: "Delete current cell (double-tap)" },
];
const SHORTCUT_DEFAULTS = Object.freeze({
  runCellPrimary: "Ctrl+Enter",
  runCellAlternate: "Ctrl+Space",
  runCellAdvance: "Shift+Enter",
  toggleLineNumbers: "Ctrl+Shift+L",
  clearCellOutput: "Alt+C",
  undoNotebook: "Z",
  redoNotebook: "Shift+Z",
  addCellBefore: "A",
  addCellAfter: "B",
  copyCell: "C",
  pasteCellAfter: "V",
  cutCell: "X",
  deleteCellDoubleTap: "D",
});
const MODIFIER_KEY_NAMES = new Set(["Control", "Shift", "Alt", "Meta"]);
const DELETE_CELL_DOUBLE_TAP_MS = 1000;
const NOTEBOOK_UNDO_LIMIT = 10;
const SECTION_COLLAPSE_ANIM_MS = 180;
const DEFAULT_NOTEBOOK_TITLE = "Untitled Notebook";
const DEFAULT_NOTEBOOK_FILENAME = `${DEFAULT_NOTEBOOK_TITLE}.ipynb`;

let shortcutBindings = { ...SHORTCUT_DEFAULTS };
let shortcutsDialogOpen = false;
let shortcutFocusRestoreEl = null;
let cellClipboard = null;
let pendingDeleteTapKey = "";
let pendingDeleteTapAt = 0;
let currentNotebookFilename = "";
let currentNotebookPath = "";
let savedNotebookText = "";
let notebookDirty = false;
let notebookAutoSaveEnabled = true;
let notebookAutoSaveTimer = 0;
let notebookRevisionPollTimer = 0;
let lastNotebookDiskRevision = null;
let notebookDiskConflict = "";
let suppressNotebookDirtyTracking = false;
let codeCellLineNumbersVisible = true;
let execTimeVisible = true;
let notebookUndoStack = [];
let notebookRedoStack = [];
let suppressNotebookUndo = false;
let pendingEditUndoSnapshot = null;
const collapsedSectionControllers = new Set();
const sectionCollapseTimers = new Map();
const selectedCellIds = new Set();

const dropPlaceholderEl = document.createElement("div");
dropPlaceholderEl.className = "sc-drop-placeholder";

const SAMPLE_CODE = `# Arcode Notebook Editor
# Variables persist between cells. Shift+Enter to run & advance.
# Available: read_json, write_json, read_csv, write_csv,
#            list_files, get_project_path, get_data_path,
#            pd (pandas), json, os, math, log

log("Hello from Arcode!")`;

// ---------------------------------------------------------------------------
// Monaco setup
// ---------------------------------------------------------------------------

const EDITOR_OPTIONS = {
  language: "python",
  theme: window.ArcRhoColorTheme?.getMonacoTheme?.() || "vs",
  fontSize: 13,
  fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
  minimap: { enabled: false },
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  wordWrap: "on",
  tabSize: 4,
  insertSpaces: true,
  automaticLayout: true,
  padding: { top: 4, bottom: 4 },
  renderWhitespace: "none",
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  scrollbar: { vertical: "hidden", horizontal: "hidden", alwaysConsumeMouseWheel: false },
  lineDecorationsWidth: 8,
  lineNumbersMinChars: 3,
  folding: false,
  glyphMargin: false,
  contextmenu: true,
};

require.config({ paths: { vs: "/ui/libs/monaco-editor/min/vs" } });

require(["vs/editor/editor.main"], function () {
  monacoReady = true;

  // New notebook tabs opened from Home card pass fresh=1 and should not restore prior drafts.
  const saved = forceFreshNotebook ? null : loadCellsFromStorage();
  const restoredDraft = Boolean(saved && saved.length > 0);
  if (restoredDraft) {
    saved.forEach((cellState) => {
      const cell = addCell(cellState.source, null, "after", cellState.type, { recordUndo: false, persist: false });
      if (typeof applyImportedCellState === "function") applyImportedCellState(cell, cellState);
    });
  } else {
    addCell(SAMPLE_CODE, null, "after", CELL_TYPES.CODE, { recordUndo: false });
  }

  focusCell(cells[0]?.id);
  refreshToc();
  updateNotebookTitleUI();
  clearNotebookUndoHistory();
  if (typeof markNotebookSavedBaseline === "function") markNotebookSavedBaseline("", null);
  loadScriptingPreferences();
  if (!restoredDraft && !skipLastNotebookLoad && typeof loadLastOpenedNotebookFromHost === "function") {
    void loadLastOpenedNotebookFromHost();
  }
});


