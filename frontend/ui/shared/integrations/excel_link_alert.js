// One in-window alert for every broken Excel link, wherever the link lives.
//
// A dataset grid cell and a DFM Ratios User Entry cell fail the same way - the
// workbook moved, the sheet was renamed, a deleted row left a #REF! - so both
// report it the same way: a modal in the window the user is looking at, naming
// each reference that broke and why, while the saved value stays put and the
// cell stays red until the reference is fixed. The status bar is not enough
// for this: it is where a refresh reports how many cells changed, and a link
// the user must go and repair should not scroll past in the same line.
import { openExcelWorkbook } from "/ui/shared/integrations/excel_api.js?v=20260819a";
import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260827a";

const MAX_LISTED_FAILURES = 6;

function workbookFileName(path) {
  return String(path || "").split(/[\\/]/).pop() || String(path || "");
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function failureLine(failure) {
  const sheet = String(failure?.worksheet || "").trim();
  const cell = String(failure?.sourceCell || "").trim();
  const source = sheet && cell ? `${sheet}!${cell}` : (cell || sheet);
  const destination = String(failure?.destination || "").trim();
  const reason = String(failure?.error || "The linked cell could not be read.").trim();
  const location = [source, destination].filter(Boolean).join(" → ");
  return location ? `${location}: ${reason}` : reason;
}

export function describeExcelLinkFailures(failures, {
  valueNoun = "linked cell",
  unnamedCount = 0,
  reason = "",
} = {}) {
  const items = Array.isArray(failures) ? failures.filter(Boolean) : [];
  const unnamed = Math.max(0, Number(unnamedCount) || 0);
  const cause = String(reason || "").trim();
  if (!items.length) {
    if (!unnamed) return "";
    // Nothing came back cell by cell, so there is no reference to send the user
    // to. Say what was attempted, that nothing changed, and whatever reason the
    // caller does have - never guess at one.
    return `${plural(unnamed, valueNoun)} could not be refreshed.`
      + " The saved values are kept, so nothing in this window changed."
      + (cause ? `\n\n${cause}` : "");
  }
  const workbooks = Array.from(new Set(
    items.map((failure) => workbookFileName(failure?.workbookPath)).filter(Boolean),
  ));
  const source = workbooks.length === 1 ? ` from ${workbooks[0]}` : "";
  const headline = `${plural(items.length, valueNoun)} could not be read${source}.`
    + " The saved values are kept and shown in red until the reference is fixed.";
  const listed = items.slice(0, MAX_LISTED_FAILURES).map(failureLine);
  const remaining = items.length - listed.length;
  if (remaining > 0) listed.push(`and ${remaining} more.`);
  const tail = unnamed
    ? `\n\n${plural(unnamed, valueNoun)} could not be refreshed for another reason.`
    : "";
  return `${headline}\n\n${listed.join("\n")}${tail}`;
}

/**
 * Shows the failed-refresh alert and resolves once the user dismisses it.
 *
 * `failures` are `{workbookPath, worksheet, sourceCell, destination, error}`
 * records. Each distinct workbook gets a link that opens it in Excel at the
 * first cell that failed there, so the fix is one click from the message.
 *
 * A refresh can also fail with nothing to name - the request itself did not
 * come back. That is still a failed action the user asked for, so it gets the
 * same box through `unnamedCount` and `reason` rather than a status line the
 * next action overwrites.
 */
export async function showExcelLinkFailureAlert({
  failures = [],
  unnamedCount = 0,
  reason = "",
  title = "",
  valueNoun = "linked cell",
  documentRef = document,
} = {}) {
  const items = Array.isArray(failures) ? failures.filter(Boolean) : [];
  const unnamed = Math.max(0, Number(unnamedCount) || 0);
  if (!items.length && !unnamed) return false;
  const byWorkbook = new Map();
  for (const failure of items) {
    const path = String(failure?.workbookPath || "").trim();
    if (!path || byWorkbook.has(path.toLowerCase())) continue;
    byWorkbook.set(path.toLowerCase(), failure);
  }
  const links = Array.from(byWorkbook.values()).map((failure) => ({
    label: `Open ${workbookFileName(failure.workbookPath)}`,
    ariaLabel: `Open ${workbookFileName(failure.workbookPath)} in Excel`,
    failure,
  }));
  await showPageMessageBox({
    title: title || (items.length ? "Excel Link Reference Error" : "Excel Refresh Failed"),
    tone: "warn",
    message: describeExcelLinkFailures(items, { valueNoun, unnamedCount: unnamed, reason }),
    links,
    onLinkClick: (item) => {
      const failure = item?.failure;
      if (!failure) return;
      openExcelWorkbook(
        failure.workbookPath,
        String(failure.worksheet || ""),
        String(failure.sourceCell || ""),
      );
    },
    documentRef,
  });
  return true;
}
