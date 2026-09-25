import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const referenceSource = await readFile(
  new URL("../ui/shared/integrations/excel_reference.js", import.meta.url),
  "utf8",
);
const spreadsheetStubUrl = dataUrl(`
  export function createSpreadsheetTableController(options) {
    return {
      applyDom() {}, clear() {}, copy() { globalThis.__arTestCopiedRanges = options.readSelection().ranges; }, move() { return false; },
      prepareContextCell() {}, selectCell() {}, selectColumn() {}, selectRow() {},
      selection() { return { ranges: [] }; },
      setRange(anchorCell, activeCell) {
        options.writeSelection({ anchorCell, activeCell, ranges: [{ r0: anchorCell.r, c0: anchorCell.c, r1: activeCell.r, c1: activeCell.c }] });
      },
    };
  }
  export function getTopLeftRangeCell(ranges) { return ranges?.[0] ? { r: ranges[0].r0, c: ranges[0].c0 } : null; }
  export function normalizeRange(r0, c0, r1, c1) { return { r0, c0, r1, c1 }; }
`);
const viewStubUrl = dataUrl(`
  export function getDatasetGridSelectionLayout() { return { maxRow: 2, maxCol: 1 }; }
  export function getDisplayDatasetModel() { return globalThis.__arTestDisplayModel; }
  export function setDatasetGridEditConfig(config) { globalThis.__arTestGridEditConfig = config; }
`);
const formulaHoverStubUrl = dataUrl(`
  export function createFormulaHoverEditor() {
    return { attach() {}, hide() {}, open() {} };
  }
`);

const internalReferenceUrl = dataUrl(await readFile(
  new URL("../ui/shared/dataset/dataset_internal_reference.js", import.meta.url),
  "utf8",
));
const datasetFormulaUrl = dataUrl((await readFile(
  new URL("../ui/shared/dataset/dataset_formula.js", import.meta.url),
  "utf8",
))
  .replace('"/ui/shared/integrations/excel_reference.js?v=20260715a"', JSON.stringify(dataUrl(referenceSource)))
  .replace('"/ui/shared/dataset/dataset_internal_reference.js?v=20260830a"', JSON.stringify(internalReferenceUrl)));

// The read-only refusal opens a page message box; record what it was told.
const messageBoxStubUrl = dataUrl(`
  export function showPageMessageBox(options) {
    globalThis.__arTestMessageBoxes = globalThis.__arTestMessageBoxes || [];
    globalThis.__arTestMessageBoxes.push(options);
    return Promise.resolve();
  }
`);

const interactionSource = (await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_interactions.js", import.meta.url),
  "utf8",
))
  .replace(
    '"/ui/shared/components/spreadsheet/spreadsheet_table.js?v=20260715a"',
    JSON.stringify(spreadsheetStubUrl),
  )
  .replace(
    '"/ui/shared/tabs/data/dataset_grid_view.js?v=20260919a"',
    JSON.stringify(viewStubUrl),
  )
  .replace(
    '"/ui/shared/integrations/excel_reference.js?v=20260715a"',
    JSON.stringify(dataUrl(referenceSource)),
  )
  .replace(
    '"/ui/shared/components/formula_hover/formula_hover.js?v=20260908b"',
    JSON.stringify(formulaHoverStubUrl),
  )
  .replace(
    '"/ui/shared/dataset/dataset_internal_reference.js?v=20260830a"',
    JSON.stringify(internalReferenceUrl),
  )
  .replace(
    '"/ui/shared/dataset/dataset_formula.js?v=20260830a"',
    JSON.stringify(datasetFormulaUrl),
  )
  .replace(
    '"/ui/shared/components/message_box/message_box.js?v=20260925a"',
    JSON.stringify(messageBoxStubUrl),
  );
const interactions = await import(dataUrl(interactionSource));

function setup({ isReadOnly } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const listeners = new Map();
  globalThis.window = { parent: { postMessage() {} } };
  const tableWrap = { addEventListener() {}, querySelector() { return null; } };
  globalThis.document = {
    activeElement: null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    getElementById(id) {
      if (id === "transposedChk") return { checked: false };
      if (id === "tableWrap") return tableWrap;
      return null;
    },
    querySelector() { return null; },
  };
  globalThis.requestAnimationFrame = (callback) => callback();

  const state = {
    model: {
      origin_labels: ["2024", "2025"],
      dev_labels: ["12m", "24m"],
      values: [[1, 2], [3, 4]],
      mask: [[true, true], [true, false]],
    },
    dirty: new Map(),
    activeCell: { r: 0, c: 0 },
    selectionAnchor: { r: 0, c: 0 },
    selRanges: [{ r0: 0, c0: 0, r1: 1, c1: 1 }],
    showSubtotal: true,
  };
  globalThis.__arTestDisplayModel = state.model;
  const calls = { renders: 0, updates: 0, statuses: [] };
  globalThis.__arTestMessageBoxes = [];
  interactions.wireDatasetGridInteractions({
    state,
    renderTable: () => { calls.renders += 1; },
    notifyDatasetUpdated: () => { calls.updates += 1; },
    refreshDatasetSettingsDirty: () => {},
    setStatus: (message) => calls.statuses.push(message),
    isReadOnly: isReadOnly || (() => false),
    hardCodeExternalLinkCells: () => 0,
    decorateExternalLinkCell: () => {},
    getExternalLinkCellInfo: () => null,
  });

  const keydown = listeners.get("keydown")?.at(-1);
  const type = (key) => keydown({
    key,
    target: null,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() { this.defaultPrevented = true; },
  });

  return {
    state,
    calls,
    listeners,
    type,
    cleanup() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.requestAnimationFrame = previousAnimationFrame;
      delete globalThis.__arTestDisplayModel;
      delete globalThis.__arTestGridEditConfig;
      delete globalThis.__arTestCopiedRanges;
    },
  };
}

test("typing a number over a selected range fills every editable cell in it", () => {
  const context = setup();
  try {
    context.type("2");

    assert.deepEqual(context.state.model.values, [[2, 2], [2, 4]]);
    assert.equal(context.state.dirty.size, 3);
    assert.equal(context.calls.statuses.at(-1), "Set 3 cells to 2.");
  } finally {
    context.cleanup();
  }
});

test("consecutive keystrokes build one number instead of replacing it", () => {
  const context = setup();
  try {
    context.type("2");
    context.type("5");

    assert.deepEqual(context.state.model.values, [[25, 25], [25, 4]]);
  } finally {
    context.cleanup();
  }
});

test("a decimal point and a leading minus are accepted while filling a range", () => {
  const context = setup();
  try {
    context.type("-");
    assert.deepEqual(context.state.model.values, [[1, 2], [3, 4]], "a lone sign changes nothing yet");
    context.type("1");
    context.type(".");
    context.type("5");

    assert.deepEqual(context.state.model.values, [[-1.5, -1.5], [-1.5, 4]]);
  } finally {
    context.cleanup();
  }
});

test("moving the selection starts the typed number over", () => {
  const context = setup();
  try {
    context.type("2");
    context.state.selRanges = [{ r0: 0, c0: 0, r1: 0, c1: 1 }];
    context.type("7");

    assert.deepEqual(context.state.model.values, [[7, 7], [2, 4]]);
  } finally {
    context.cleanup();
  }
});

test("a single selected cell still opens the inline editor instead of filling", () => {
  const context = setup();
  try {
    context.state.selRanges = [{ r0: 0, c0: 0, r1: 0, c1: 0 }];
    context.type("2");

    assert.deepEqual(context.state.model.values, [[1, 2], [3, 4]]);
    assert.equal(context.state.dirty.size, 0);
  } finally {
    context.cleanup();
  }
});

test("a read-only dataset refuses a typed range fill and says so in the window", () => {
  const context = setup({ isReadOnly: () => true });
  try {
    context.type("2");

    assert.deepEqual(context.state.model.values, [[1, 2], [3, 4]]);
    // The reason belongs in the window the reader is looking at, not on the
    // shell's status line below every page.
    assert.deepEqual(context.calls.statuses, []);
    const box = globalThis.__arTestMessageBoxes.at(-1);
    assert.equal(box.message, "Generated datasets are read-only.");
    assert.equal(box.title, "Read-only view");
  } finally {
    context.cleanup();
  }
});

test("Paste is available only when selected cells can be edited", () => {
  for (const readOnly of [false, true]) {
    const context = setup({ isReadOnly: () => readOnly });
    try {
      assert.equal(globalThis.__arTestGridEditConfig.canPasteSelection(), !readOnly);
      context.state.selRanges = [{ r0: 1, c0: 1, r1: 1, c1: 1 }];
      assert.equal(globalThis.__arTestGridEditConfig.canPasteSelection(), false);
    } finally {
      context.cleanup();
    }
  }
});

test("Copy All and Ctrl+A copy the entire display including the Total row", async () => {
  const context = setup();
  try {
    context.state.selRanges = [{ r0: 0, c0: 0, r1: 0, c1: 0 }];
    await globalThis.__arTestGridEditConfig.onContextAction("copy_all");
    assert.deepEqual(globalThis.__arTestCopiedRanges, [{ r0: 0, c0: 0, r1: 2, c1: 1 }]);
    delete globalThis.__arTestCopiedRanges;
    context.state.selRanges = [];
    const event = { key: "a", ctrlKey: true, preventDefault() { this.prevented = true; } };
    for (const listener of context.listeners.get("keydown")) listener(event);
    assert.equal(event.prevented, true);
    assert.deepEqual(globalThis.__arTestCopiedRanges, [{ r0: 0, c0: 0, r1: 2, c1: 1 }]);
  } finally {
    context.cleanup();
  }
});

test("Clear data zeroes every editable cell of the grid, whatever is selected", async () => {
  const context = setup();
  try {
    context.state.selRanges = [{ r0: 0, c0: 0, r1: 0, c1: 0 }];
    await globalThis.__arTestGridEditConfig.onContextAction("clear_data");

    // The masked cell is left alone, the same way a typed range fill skips it.
    assert.deepEqual(context.state.model.values, [[0, 0], [0, 4]]);
    assert.equal(context.calls.statuses.at(-1), "Set 3 cells to 0.");
  } finally {
    context.cleanup();
  }
});

test("Clear data is offered only on a grid that can be edited", () => {
  for (const readOnly of [false, true]) {
    const context = setup({ isReadOnly: () => readOnly });
    try {
      assert.equal(globalThis.__arTestGridEditConfig.canClearData(), !readOnly);
    } finally {
      context.cleanup();
    }
  }
});
