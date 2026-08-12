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
  assert.match(index, /review_table\/review_table\.css\?v=20260812b/u);
  assert.match(index, /ui_shell\.js\?v=20260812b/u);
  for (const consumer of [uiShell, shellMessages, updateProgress]) {
    assert.match(consumer, /ui_automation\.js\?v=20260812b/u);
  }
  assert.match(component, /cell\.textContent/u);
  assert.doesNotMatch(component, /innerHTML/u);
  assert.match(component, /event\.key === "Escape"/u);
  assert.match(component, /Select all visible actions/u);
  assert.match(styles, /\.reviewTable th\s*\{[\s\S]*?position: sticky;/u);
  assert.match(styles, /\.reviewTableResizeHandle/u);
});

test("a projectInstance-hosted review table runs as a nested pi-window", async () => {
  const [automation, piReviewTable, piMessages, piWindows, windowPage, windowScript, component, styles] = await Promise.all([
    source("ui/shell/ui_automation.js"),
    source("ui/project_instance/project_instance_review_table.js"),
    source("ui/project_instance/project_instance_messages.js"),
    source("ui/project_instance/project_instance_windows.js"),
    source("ui/shared/components/review_table/review_table_window.html"),
    source("ui/shared/components/review_table/review_table_window.js"),
    source("ui/shared/components/review_table/review_table.js"),
    source("ui/shared/components/review_table/review_table.css"),
  ]);

  // The shell routes host=projectInstance opens to the active Project Instance
  // tab and pins follow-up status/close commands to that owning tab.
  assert.match(automation, /reviewTableWantsProjectInstanceHost/u);
  assert.match(automation, /arcrho:automation-review-table-open/u);
  assert.match(automation, /arcrho:automation-review-table-status/u);
  assert.match(automation, /arcrho:automation-review-table-close/u);
  assert.match(automation, /reviewTableHostTabs/u);
  // Without an active Project Instance page the shell modal remains the host.
  assert.match(automation, /openAutomationReviewTable\(args\)/u);

  // The Project Instance page owns the dialog lifecycle as a nested window.
  assert.match(piMessages, /arcrho:automation-review-table-open/u);
  assert.match(piMessages, /arcrho:review-table-window-complete/u);
  assert.match(piReviewTable, /kind: "review_table"/u);
  assert.match(piReviewTable, /createFloatingContentWindow/u);
  assert.match(piReviewTable, /status: "pending", pending: true/u);
  assert.match(piReviewTable, /accepted: !!entry\.result\?\.accepted/u);
  // A user closing the window (X or minimized-tab close) resolves the review
  // as a cancelled completion instead of hanging the macro poll loop.
  assert.match(piReviewTable, /settleEntryIfWindowClosed/u);
  // Review windows are macro-session state, never part of the persisted
  // Project Instance window snapshot.
  assert.match(piWindows, /windowKind === "review_table"\) return null/u);

  // The nested-window page embeds the same shared panel the modal uses.
  assert.match(windowPage, /review_table\.css\?v=20260812b/u);
  assert.match(windowPage, /review_table_window\.js\?v=20260812a/u);
  assert.match(windowScript, /createReviewTablePanel/u);
  assert.match(windowScript, /arcrho:review-table-window-ready/u);
  assert.match(component, /export function createReviewTablePanel/u);
  assert.match(styles, /\.reviewTableWindowHost/u);
});

test("an implicit active-window query with no open window reports None instead of an error", async () => {
  const piMessages = await source("ui/project_instance/project_instance_messages.js");
  // ArcRhoUI.project_instance.active_window() sends no windowId; when nothing
  // is open the page must reply ok with an empty windowId so the Python API
  // returns None, keeping the error only for explicit window lookups.
  assert.match(piMessages, /automationWindowArgsHaveExplicitTarget/u);
  assert.match(piMessages, /\{ ok: true, result: \{ windowId: "", id: "", connected: false, active: false \} \}/u);
  assert.match(piMessages, /Project Instance window was not found\./u);
});
