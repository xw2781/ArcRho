import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  filterReviewTableRows,
  normalizeReviewTableColumns,
  normalizeReviewTableRows,
  selectedReviewTableRowIds,
  summarizeReviewTableSelection,
} from "../ui/shared/components/review_table/review_table.js";

const frontendRoot = new URL("../", import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, frontendRoot), "utf8");
}

test("review-table normalization preserves timestamps as text and keeps markup inert", () => {
  const columns = normalizeReviewTableColumns([
    { key: "name", label: "Dataset Or Method" },
    { key: "resq_time", label: "ResQ Timestamp" },
    { key: "status", label: "Status" },
  ]);
  const rows = normalizeReviewTableRows([
    {
      id: "dataset:paid",
      cells: {
        name: "Paid <img src=x onerror=alert(1)>",
        resq_time: "2026-08-12T10:30:00-04:00",
        status: { text: "ResQ Newer", tone: "newer" },
      },
    },
    {
      id: "method:dfm",
      disabled: true,
      selected: true,
      cells: { name: "DFM", resq_time: "", status: "Unsupported" },
    },
  ], columns);

  assert.equal(rows[0].cells[0].text, "Paid <img src=x onerror=alert(1)>");
  assert.equal(rows[0].cells[1].text, "2026-08-12T10:30:00-04:00");
  assert.equal(rows[0].cells[2].tone, "newer");
  assert.equal(rows[0].selected, true);
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].selected, false);
});

test("review-table selection summaries respect disabled rows and the filtered view", () => {
  const columns = normalizeReviewTableColumns([{ key: "name", label: "Name" }]);
  const rows = normalizeReviewTableRows([
    { id: "a", selected: true, cells: { name: "Paid Loss" } },
    { id: "b", selected: false, cells: { name: "Case Reserve" } },
    { id: "c", disabled: true, cells: { name: "Unsupported Method" } },
  ], columns);
  const selected = new Set(["a", "c"]);
  const visible = filterReviewTableRows(rows, "loss");
  const summary = summarizeReviewTableSelection(rows, selected, visible);

  assert.deepEqual(selectedReviewTableRowIds(rows, selected), ["a"]);
  assert.equal(summary.actionableCount, 2);
  assert.equal(summary.selectedCount, 1);
  assert.equal(summary.visibleCount, 1);
  assert.equal(summary.allVisibleSelected, true);
  assert.equal(summary.someVisibleSelected, false);
});

test("review-table rows require unique stable identifiers", () => {
  const columns = normalizeReviewTableColumns([{ key: "name", label: "Name" }]);
  assert.throws(
    () => normalizeReviewTableRows([{ cells: { name: "Missing id" } }], columns),
    /requires a stable id/u,
  );
  assert.throws(
    () => normalizeReviewTableRows([
      { id: "same", cells: { name: "One" } },
      { id: "same", cells: { name: "Two" } },
    ], columns),
    /duplicated/u,
  );
});

test("shell UI automation wires asynchronous review-table open, status, and close commands", async () => {
  const [automation, index, uiShell, shellMessages, updateProgress, component, styles] = await Promise.all([
    source("ui/shell/ui_automation.js"),
    source("ui/index.html"),
    source("ui/shell/ui_shell.js"),
    source("ui/shell/shell_messages.js"),
    source("ui/shell/update_progress.js"),
    source("ui/shared/components/review_table/review_table.js"),
    source("ui/shared/components/review_table/review_table.css"),
  ]);

  assert.match(automation, /ui\.reviewTableOpen/u);
  assert.match(automation, /ui\.reviewTableStatus/u);
  assert.match(automation, /ui\.reviewTableClose/u);
  assert.match(automation, /return \{ dialogId \}/u);
  assert.match(automation, /status: "completed"/u);
  assert.match(automation, /selectedRowIds/u);
  assert.match(index, /review_table\/review_table\.css\?v=20260812a/u);
  assert.match(index, /ui_shell\.js\?v=20260812a/u);
  for (const consumer of [uiShell, shellMessages, updateProgress]) {
    assert.match(consumer, /ui_automation\.js\?v=20260812a/u);
  }
  assert.match(component, /cell\.textContent/u);
  assert.doesNotMatch(component, /innerHTML/u);
  assert.match(component, /event\.key === "Escape"/u);
  assert.match(component, /Select all visible actions/u);
  assert.match(styles, /\.reviewTable th\s*\{[\s\S]*?position: sticky;/u);
  assert.match(styles, /\.reviewTableResizeHandle/u);
});
