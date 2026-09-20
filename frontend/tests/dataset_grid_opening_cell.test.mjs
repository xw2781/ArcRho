import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A Dataset window opens on a cell instead of on an instruction to pick one,
// so its formula panel shows a formula as soon as the grid is on screen.

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const referenceSource = await readFile(
  new URL("../ui/shared/integrations/excel_reference.js", import.meta.url),
  "utf8",
);
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

const spreadsheetStubUrl = dataUrl(`
  export function createSpreadsheetTableController() {
    return {
      applyDom() {}, clear() {}, copy() {}, move() { return false; },
      prepareContextCell() {}, selectCell() {}, selectColumn() {}, selectRow() {},
      selection() { return { ranges: [] }; }, setRange() {},
    };
  }
  export function getTopLeftRangeCell(ranges) { return ranges?.[0] ? { r: ranges[0].r0, c: ranges[0].c0 } : null; }
  export function normalizeRange(r0, c0, r1, c1) { return { r0, c0, r1, c1 }; }
`);
const viewStubUrl = dataUrl(`
  export function getDatasetGridSelectionLayout() { return globalThis.__arTestGridLayout; }
  export function getDisplayDatasetModel() { return globalThis.__arTestDisplayModel; }
  export function setDatasetGridEditConfig() {}
`);
const formulaHoverStubUrl = dataUrl(`
  export function createFormulaHoverEditor() {
    const controller = {
      openCalls: [],
      attach() { return true; },
      hide() {},
      open(dock, context, options) { this.openCalls.push({ context, options }); return true; },
    };
    globalThis.__arTestFormulaHover = controller;
    return controller;
  }
`);
const messageBoxStubUrl = dataUrl("export function showPageMessageBox() { return Promise.resolve(); }");

const interactionsSource = (await readFile(
  new URL("../ui/shared/tabs/data/dataset_grid_interactions.js", import.meta.url),
  "utf8",
))
  .replace(/"\/ui\/shared\/components\/spreadsheet\/spreadsheet_table\.js\?v=[^"]*"/u, JSON.stringify(spreadsheetStubUrl))
  .replace(/"\/ui\/shared\/tabs\/data\/dataset_grid_view\.js\?v=[^"]*"/u, JSON.stringify(viewStubUrl))
  .replace(/"\/ui\/shared\/integrations\/excel_reference\.js\?v=[^"]*"/u, JSON.stringify(dataUrl(referenceSource)))
  .replace(/"\/ui\/shared\/components\/formula_hover\/formula_hover\.js\?v=[^"]*"/u, JSON.stringify(formulaHoverStubUrl))
  .replace(/"\/ui\/shared\/dataset\/dataset_internal_reference\.js\?v=[^"]*"/u, JSON.stringify(internalReferenceUrl))
  .replace(/"\/ui\/shared\/dataset\/dataset_formula\.js\?v=[^"]*"/u, JSON.stringify(datasetFormulaUrl))
  .replace(/"\/ui\/shared\/components\/message_box\/message_box\.js\?v=[^"]*"/u, JSON.stringify(messageBoxStubUrl));

const interactions = await import(dataUrl(interactionsSource));

const FORMULA = "='C:\\Data\\[Book.xlsx]Sheet 1'!A1";

/** A manual dataset window showing a two-by-two grid with its formula panel. */
function setup({ links = new Map() } = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousAnimationFrame = globalThis.requestAnimationFrame;
  const formulaPanel = { hidden: false };
  globalThis.window = { parent: { postMessage() {} } };
  globalThis.document = {
    activeElement: null,
    addEventListener() {},
    getElementById(id) {
      if (id === "transposedChk") return { checked: false };
      if (id === "tableWrap") return { addEventListener() {}, checkVisibility: () => true, querySelector: () => null };
      if (id === "datasetFormulaPanel") return formulaPanel;
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.__arTestGridLayout = { maxRow: 1, maxCol: 1 };
  const state = {
    model: { source_kind: "input", origin_labels: ["2024", "2025"], dev_labels: ["12m", "24m"], values: [[1, 2], [3, 4]], mask: [[true, true], [true, true]] },
    dirty: new Map(),
    activeCell: null,
    selectionAnchor: null,
    selRanges: [],
  };
  globalThis.__arTestDisplayModel = state.model;
  const api = interactions.wireDatasetGridInteractions({
    state,
    isReadOnly: () => false,
    renderTable: () => {},
    notifyDatasetUpdated: () => {},
    setStatus: () => {},
    getExternalLinkCellInfo: (r, c) => links.get(`${r},${c}`) || null,
  });
  const cleanup = () => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousAnimationFrame;
    delete globalThis.__arTestGridLayout;
    delete globalThis.__arTestDisplayModel;
    delete globalThis.__arTestFormulaHover;
  };
  return { api, state, links, formulaHover: globalThis.__arTestFormulaHover, cleanup };
}

const lastOpenedFormula = (context) => context.formulaHover.openCalls.at(-1)?.context?.formula;

test("the opening cell is the first cell holding a formula", () => {
  assert.deepEqual(
    interactions.pickDatasetOpeningCell({
      maxRow: 1,
      maxCol: 1,
      getCellFormula: (r, c) => (r === 1 && c === 0 ? FORMULA : ""),
    }),
    { r: 1, c: 0, hasFormula: true },
  );
});

test("a grid with no formula opens on its first cell, and an empty grid on none", () => {
  const none = () => "";
  assert.deepEqual(
    interactions.pickDatasetOpeningCell({ maxRow: 3, maxCol: 3, getCellFormula: none }),
    { r: 0, c: 0, hasFormula: false },
  );
  assert.equal(interactions.pickDatasetOpeningCell({ maxRow: -1, maxCol: -1, getCellFormula: none }), null);
});

test("a dataset with a linked cell opens on it with its formula in the panel", () => {
  const context = setup({ links: new Map([["0,1", { reference: FORMULA }]]) });
  try {
    context.api.applySelectionFromState();

    assert.deepEqual(context.state.activeCell, { r: 0, c: 1 });
    assert.deepEqual(context.state.selRanges, [{ r0: 0, c0: 1, r1: 0, c1: 1 }]);
    assert.equal(lastOpenedFormula(context), FORMULA);
  } finally {
    context.cleanup();
  }
});

test("formulas arriving after the first paint move the selection off the fallback cell", () => {
  const context = setup();
  try {
    context.api.applySelectionFromState();
    assert.deepEqual(context.state.activeCell, { r: 0, c: 0 });

    context.links.set("1,1", { reference: FORMULA });
    context.api.applySelectionFromState();

    assert.deepEqual(context.state.activeCell, { r: 1, c: 1 });
    assert.equal(lastOpenedFormula(context), FORMULA);
  } finally {
    context.cleanup();
  }
});

test("a cell the reader has chosen is never taken back", () => {
  const context = setup();
  try {
    context.api.applySelectionFromState();
    context.state.activeCell = { r: 1, c: 0 };
    context.state.selRanges = [{ r0: 1, c0: 0, r1: 1, c1: 0 }];

    context.links.set("0,1", { reference: FORMULA });
    context.api.applySelectionFromState();

    assert.deepEqual(context.state.activeCell, { r: 1, c: 0 });
  } finally {
    context.cleanup();
  }
});
