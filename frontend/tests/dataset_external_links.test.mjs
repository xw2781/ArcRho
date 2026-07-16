import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const referenceSource = await readFile(
  new URL("../ui/shared/integrations/excel_reference.js", import.meta.url),
  "utf8",
);
const referenceUrl = `data:text/javascript;base64,${Buffer.from(referenceSource).toString("base64")}`;
const excelApiStubUrl = `data:text/javascript;base64,${Buffer.from(
  "export async function readExcelCellsBatch(){ return { ok: false, results: [] }; }",
).toString("base64")}`;
let controllerSource = await readFile(
  new URL("../ui/shared/dataset/dataset_external_links.js", import.meta.url),
  "utf8",
);
controllerSource = controllerSource
  .replace('"/ui/shared/integrations/excel_api.js"', JSON.stringify(excelApiStubUrl))
  .replace(
    '"/ui/shared/integrations/excel_reference.js?v=20260715a"',
    JSON.stringify(referenceUrl),
  );
const externalLinks = await import(
  `data:text/javascript;base64,${Buffer.from(controllerSource).toString("base64")}`
);

const REF = "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B2";

function model2x2() {
  return {
    origin_labels: ["2024", "2025"],
    dev_labels: ["12m", "24m"],
    values: [[1, 2], [3, 4]],
    mask: [[true, true], [true, true]],
  };
}

function decoratedCell() {
  const classes = new Set();
  return {
    classes,
    dataset: {},
    classList: {
      contains: (name) => classes.has(name),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return !!force;
      },
    },
    removeAttribute() {},
  };
}

function arrayOutlineClasses(cell) {
  return Array.from(cell.classes)
    .filter((name) => name.startsWith("arArrayFormula"))
    .sort();
}

test("normalizes link metadata without merging separate consumers", () => {
  const normalized = externalLinks.normalizeDatasetExternalLinks([
    {
      reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!$a$1",
      target_cells: [{ row: 0, column: 0 }, { row: 0, column: 0 }],
    },
    {
      reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
      target_cells: [{ row: 1, column: 0 }],
    },
    {
      reference: "='C:\\Data\\[Other.xlsx]Sheet 2'!B2",
      target_cells: [{ row: 0, column: 0 }],
    },
    {
      reference: "='C:\\Data\\[Other.xlsx]Sheet 2'!A1:B1",
      target_cells: [{ row: 1, column: 1 }],
    },
  ]);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].reference, "='C:\\Data\\[Book.xlsx]Sheet 1'!A1");
  assert.deepEqual(normalized[0].target_cells, [
    { row: 0, column: 0, source_cell: "A1" },
  ]);
  assert.deepEqual(normalized[1].target_cells, [
    { row: 1, column: 0, source_cell: "A1" },
  ]);
});

test("accepts clipped source mappings and rejects mixed or out-of-range mappings", () => {
  const reference = "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:C3";
  const normalized = externalLinks.normalizeDatasetExternalLinks([{
    reference,
    target_cells: [
      { row: 0, column: 0, source_cell: "$A$1" },
      { row: 1, column: 0, source_cell: "A2" },
    ],
  }]);
  assert.deepEqual(normalized[0].target_cells, [
    { row: 0, column: 0, source_cell: "A1" },
    { row: 1, column: 0, source_cell: "A2" },
  ]);
  assert.deepEqual(externalLinks.normalizeDatasetExternalLinks([{
    reference,
    target_cells: [
      { row: 0, column: 0, source_cell: "A1" },
      { row: 1, column: 0 },
    ],
  }]), []);
  assert.deepEqual(externalLinks.normalizeDatasetExternalLinks([{
    reference,
    target_cells: [{ row: 0, column: 0, source_cell: "D4" }],
  }]), []);
  assert.deepEqual(externalLinks.normalizeDatasetExternalLinks([{
    reference,
    target_cells: [
      { row: 0, column: 0, source_cell: "A1" },
      { row: 0, column: 0, source_cell: "B1" },
    ],
  }]), []);
});

test("clips normal and transposed destinations to editable cells", () => {
  const model = model2x2();
  const normal = externalLinks.buildDatasetExternalLinkTargets({
    model,
    startRow: 0,
    startColumn: 0,
    rowCount: 2,
    columnCount: 1,
  });
  assert.equal(normal.ok, true);
  assert.deepEqual(
    normal.targets.map(({ row, column }) => ({ row, column })),
    [{ row: 0, column: 0 }, { row: 1, column: 0 }],
  );

  const transposed = externalLinks.buildDatasetExternalLinkTargets({
    model,
    transposed: true,
    startRow: 0,
    startColumn: 0,
    rowCount: 1,
    columnCount: 2,
  });
  assert.equal(transposed.ok, true);
  assert.deepEqual(
    transposed.targets.map(({ row, column }) => ({ row, column })),
    [{ row: 0, column: 0 }, { row: 1, column: 0 }],
  );

  model.mask[1][0] = false;
  const clipped = externalLinks.buildDatasetExternalLinkTargets({
    model,
    startRow: 0,
    startColumn: 0,
    rowCount: 4,
    columnCount: 3,
  });
  assert.equal(clipped.ok, true);
  assert.deepEqual(
    clipped.targets.map(({ row, column, rowOffset, columnOffset }) => ({
      row,
      column,
      rowOffset,
      columnOffset,
    })),
    [
      { row: 0, column: 0, rowOffset: 0, columnOffset: 0 },
      { row: 0, column: 1, rowOffset: 0, columnOffset: 1 },
      { row: 1, column: 1, rowOffset: 1, columnOffset: 1 },
    ],
  );
  assert.equal(clipped.ignoredCellCount, 9);
});

test("commits a linked range as numeric values plus separate metadata", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async (items) => ({
      ok: true,
      results: items.map((_item, index) => ({ ok: true, value: [10, 0, -2, 40][index] })),
    }),
  });
  controller.load([]);

  const result = await controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: REF,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(state.model.values, [[10, 0], [-2, 40]]);
  assert.equal(state.dirty.size, 4);
  assert.equal(controller.isDirty(), true);
  assert.deepEqual(controller.serialize()[0].target_cells, [
    { row: 0, column: 0, source_cell: "A1" },
    { row: 0, column: 1, source_cell: "B1" },
    { row: 1, column: 0, source_cell: "A2" },
    { row: 1, column: 1, source_cell: "B2" },
  ]);
});

test("commits transposed ranges in displayed row-major order", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    isTransposed: () => true,
    readCellsBatch: async () => ({
      ok: true,
      results: [10, 20, 30, 40].map((value) => ({ ok: true, value })),
    }),
  });
  controller.load([]);

  const result = await controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: REF,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(state.model.values, [[10, 30], [20, 40]]);
  assert.deepEqual(controller.serialize()[0].target_cells, [
    { row: 0, column: 0, source_cell: "A1" },
    { row: 1, column: 0, source_cell: "B1" },
    { row: 0, column: 1, source_cell: "A2" },
    { row: 1, column: 1, source_cell: "B2" },
  ]);
});

test("commits only the in-grid triangle portion of a large Excel range", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  state.model.mask[1][1] = false;
  const readItems = [];
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async (items) => {
      readItems.push(...items);
      return {
        ok: true,
        results: items.map((_item, index) => ({ ok: true, value: 10 + index })),
      };
    },
  });
  controller.load([]);

  const result = await controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:D4",
  });

  assert.equal(result.ok, true);
  assert.equal(result.affectedCellCount, 3);
  assert.deepEqual(readItems.map((item) => item.cell), ["A1", "B1", "A2"]);
  assert.deepEqual(state.model.values, [[10, 11], [12, 4]]);
  assert.deepEqual(controller.serialize()[0].target_cells, [
    { row: 0, column: 0, source_cell: "A1" },
    { row: 0, column: 1, source_cell: "B1" },
    { row: 1, column: 0, source_cell: "A2" },
  ]);
});

test("clips a full-sheet Excel reference without materializing its source cells", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const readItems = [];
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async (items) => {
      readItems.push(...items);
      return {
        ok: true,
        results: items.map((_item, index) => ({ ok: true, value: 20 + index })),
      };
    },
  });
  controller.load([]);

  const result = await controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:XFD1048576",
  });

  assert.equal(result.ok, true);
  assert.equal(result.affectedCellCount, 4);
  assert.deepEqual(readItems.map((item) => item.cell), ["A1", "B1", "A2", "B2"]);
  assert.equal(controller.listRecords()[0].value, "20...");
  assert.equal(externalLinks.normalizeDatasetExternalLinks([{
    reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:XFD1048576",
    target_cells: [{ row: 0, column: 0, source_cell: "XFD1048576" }],
  }]).length, 1);
});

test("range Values previews keep an ellipsis when clipping leaves one target", () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({ state });
  controller.load([{
    reference: REF,
    target_cells: [{ row: 0, column: 0, source_cell: "A1" }],
  }]);

  assert.equal(controller.listRecords()[0].value, "1...");
});

test("failed range reads leave every value and link unchanged", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async () => ({
      ok: true,
      results: [
        { ok: true, value: 10 },
        { ok: false, error: "not numeric" },
        { ok: true, value: 30 },
        { ok: true, value: 40 },
      ],
    }),
  });
  controller.load([]);

  const result = await controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: REF,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(state.model.values, [[1, 2], [3, 4]]);
  assert.deepEqual(controller.serialize(), []);
  assert.equal(state.dirty.size, 0);
});

test("blank Excel cells reject the whole linked range", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async () => ({
      ok: true,
      results: [
        { ok: true, value: 10 },
        { ok: true, value: "" },
        { ok: true, value: 30 },
        { ok: true, value: 40 },
      ],
    }),
  });
  controller.load([]);

  const result = await controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: REF,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /blank value/u);
  assert.deepEqual(state.model.values, [[1, 2], [3, 4]]);
  assert.deepEqual(controller.serialize(), []);
});

test("breaking a grouped source preserves values and hard-codes all consumers", () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({ state });
  controller.load([
    { reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", target_cells: [{ row: 0, column: 0 }] },
    { reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", target_cells: [{ row: 1, column: 1 }] },
  ]);
  const before = structuredClone(state.model.values);
  const [record] = controller.listRecords();

  const result = controller.breakLink(record.id);

  assert.equal(result.ok, true);
  assert.equal(result.affectedCellCount, 2);
  assert.deepEqual(state.model.values, before);
  assert.deepEqual(controller.serialize(), []);
  assert.equal(controller.isDirty(), true);
  controller.restoreSaved();
  assert.equal(controller.isDirty(), false);
  assert.equal(controller.serialize().length, 2);
});

test("refresh applies each range atomically and marks only changed cells", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async () => ({
      ok: true,
      results: [
        { ok: true, value: 1 },
        { ok: true, value: 20 },
        { ok: true, value: 3 },
        { ok: true, value: 40 },
      ],
    }),
  });
  controller.load([{
    reference: REF,
    target_cells: [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
    ],
  }]);

  const result = await controller.refreshAll();

  assert.deepEqual(result, { linkedCellCount: 4, changedCount: 2, failedCount: 0 });
  assert.deepEqual(state.model.values, [[1, 20], [3, 40]]);
  assert.deepEqual(Array.from(state.dirty.keys()), ["0,1", "1,1"]);
  assert.equal(controller.isDirty(), false);
});

test("refresh does not apply result payloads from a failed batch response", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async () => ({
      ok: false,
      results: [10, 20, 30, 40].map((value) => ({ ok: true, value })),
    }),
  });
  controller.load([{
    reference: REF,
    target_cells: [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
    ],
  }]);

  const result = await controller.refreshAll();

  assert.deepEqual(result, { linkedCellCount: 4, changedCount: 0, failedCount: 4 });
  assert.deepEqual(state.model.values, [[1, 2], [3, 4]]);
  assert.equal(state.dirty.size, 0);
});

test("refresh honors clipped source mappings and selected link groups", async () => {
  const state = { model: model2x2(), dirty: new Map() };
  const readItems = [];
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: async (items) => {
      readItems.push(...items);
      return {
        ok: true,
        results: items.map((item) => ({ ok: true, value: item.cell === "D4" ? 44 : 11 })),
      };
    },
  });
  controller.load([
    {
      reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:D4",
      target_cells: [
        { row: 0, column: 0, source_cell: "A1" },
        { row: 1, column: 1, source_cell: "$D$4" },
      ],
    },
    {
      reference: "='C:\\Data\\[Other.xlsx]Sheet 2'!C3",
      target_cells: [{ row: 0, column: 1, source_cell: "C3" }],
    },
  ]);
  const records = controller.listRecords();

  const result = await controller.refreshAll([records[0].id]);

  assert.deepEqual(result, { linkedCellCount: 2, changedCount: 2, failedCount: 0 });
  assert.deepEqual(readItems.map((item) => item.cell), ["A1", "D4"]);
  assert.deepEqual(state.model.values, [[11, 2], [3, 44]]);
  assert.equal(records[0].value, "1...");
});

test("exposes the range anchor for linked-cell formula editing", () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    isTransposed: () => true,
  });
  controller.load([{
    reference: REF,
    target_cells: [
      { row: 0, column: 0, source_cell: "A1" },
      { row: 0, column: 1, source_cell: "B1" },
    ],
  }]);

  assert.deepEqual(controller.getCellLinkInfo(1, 0), {
    id: "c:\\data\\book.xlsx\u001fsheet 1\u001fA1:B2",
    reference: REF,
    sourceCell: "B1",
    anchorDisplayRow: 0,
    anchorDisplayColumn: 0,
  });
});

test("decorates only the outside contour of a clipped Dataset array formula", () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({ state });
  controller.load([{
    reference: REF,
    target_cells: [
      { row: 0, column: 0, source_cell: "A1" },
      { row: 0, column: 1, source_cell: "B1" },
      { row: 1, column: 0, source_cell: "A2" },
    ],
  }]);
  const topLeft = decoratedCell();
  const topRight = decoratedCell();
  const bottomLeft = decoratedCell();
  const unlinked = decoratedCell();

  controller.decorateCell(topLeft, 0, 0);
  controller.decorateCell(topRight, 0, 1);
  controller.decorateCell(bottomLeft, 1, 0);
  controller.decorateCell(unlinked, 1, 1);

  assert.deepEqual(arrayOutlineClasses(topLeft), [
    "arArrayFormulaCell",
    "arArrayFormulaEdgeLeft",
    "arArrayFormulaEdgeTop",
  ]);
  assert.deepEqual(arrayOutlineClasses(topRight), [
    "arArrayFormulaCell",
    "arArrayFormulaEdgeBottom",
    "arArrayFormulaEdgeRight",
    "arArrayFormulaEdgeTop",
  ]);
  assert.deepEqual(arrayOutlineClasses(bottomLeft), [
    "arArrayFormulaCell",
    "arArrayFormulaEdgeBottom",
    "arArrayFormulaEdgeLeft",
    "arArrayFormulaEdgeRight",
  ]);
  assert.deepEqual(arrayOutlineClasses(unlinked), []);

  controller.load([{
    reference: REF,
    target_cells: [{ row: 0, column: 0, source_cell: "A1" }],
  }]);
  controller.decorateCell(topLeft, 0, 0);
  assert.deepEqual(arrayOutlineClasses(topLeft), [
    "arArrayFormulaCell",
    "arArrayFormulaEdgeBottom",
    "arArrayFormulaEdgeLeft",
    "arArrayFormulaEdgeRight",
    "arArrayFormulaEdgeTop",
  ]);

  controller.load([{
    reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1",
    target_cells: [{ row: 0, column: 0, source_cell: "A1" }],
  }]);
  controller.decorateCell(topLeft, 0, 0);
  assert.equal(topLeft.classes.has("arExternalLinkCell"), true);
  assert.deepEqual(arrayOutlineClasses(topLeft), []);
});

test("rotates Dataset array-formula perimeter edges in Transposed mode", () => {
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    isTransposed: () => true,
  });
  controller.load([{
    reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1:B1",
    target_cells: [
      { row: 0, column: 0, source_cell: "A1" },
      { row: 0, column: 1, source_cell: "B1" },
    ],
  }]);
  const top = decoratedCell();
  const bottom = decoratedCell();

  controller.decorateCell(top, 0, 0);
  controller.decorateCell(bottom, 1, 0);

  assert.deepEqual(arrayOutlineClasses(top), [
    "arArrayFormulaCell",
    "arArrayFormulaEdgeLeft",
    "arArrayFormulaEdgeRight",
    "arArrayFormulaEdgeTop",
  ]);
  assert.deepEqual(arrayOutlineClasses(bottom), [
    "arArrayFormulaCell",
    "arArrayFormulaEdgeBottom",
    "arArrayFormulaEdgeLeft",
    "arArrayFormulaEdgeRight",
  ]);
});

test("bulk break removes selected source groups once", () => {
  let inventoryChanges = 0;
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    onInventoryChanged: () => { inventoryChanges += 1; },
  });
  controller.load([
    { reference: "='C:\\Data\\[Book.xlsx]Sheet 1'!A1", target_cells: [{ row: 0, column: 0 }] },
    { reference: "='C:\\Data\\[Other.xlsx]Sheet 2'!B2", target_cells: [{ row: 1, column: 1 }] },
  ]);
  const ids = controller.listRecords().map((record) => record.id);

  const result = controller.breakLinks(ids);

  assert.equal(result.ok, true);
  assert.equal(result.affectedCellCount, 2);
  assert.equal(controller.serialize().length, 0);
  assert.equal(inventoryChanges, 2);
});

test("hard-coding a target invalidates an unresolved Excel commit", async () => {
  let resolveRead;
  const readResult = new Promise((resolve) => { resolveRead = resolve; });
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: () => readResult,
  });
  controller.load([]);

  const pendingCommit = controller.commitReference({
    displayRow: 0,
    displayColumn: 0,
    reference: REF,
  });
  controller.hardCodeTargetCells([{ row: 0, column: 0 }]);
  resolveRead({
    ok: true,
    results: [1, 2, 3, 4].map((value) => ({ ok: true, value: value * 10 })),
  });
  const result = await pendingCommit;

  assert.equal(result.stale, true);
  assert.deepEqual(state.model.values, [[1, 2], [3, 4]]);
  assert.deepEqual(controller.serialize(), []);
});

test("breaking a link invalidates its unresolved refresh", async () => {
  let resolveRead;
  const readResult = new Promise((resolve) => { resolveRead = resolve; });
  const state = { model: model2x2(), dirty: new Map() };
  const controller = externalLinks.createDatasetExternalLinksController({
    state,
    readCellsBatch: () => readResult,
  });
  controller.load([{
    reference: REF,
    target_cells: [
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
    ],
  }]);

  const pendingRefresh = controller.refreshAll();
  const [record] = controller.listRecords();
  assert.equal(controller.breakLink(record.id).ok, true);
  resolveRead({
    ok: true,
    results: [10, 20, 30, 40].map((value) => ({ ok: true, value })),
  });
  const result = await pendingRefresh;

  assert.equal(result.stale, true);
  assert.deepEqual(state.model.values, [[1, 2], [3, 4]]);
  assert.deepEqual(controller.serialize(), []);
});
