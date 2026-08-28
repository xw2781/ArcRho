// An object that is still some other object's input may not be deleted: the
// server refuses the whole request with 409 and names what is using it. This
// module turns that refusal into the window the user can act from -- every
// blocking dependent is a link that opens its own method or dataset window, so
// the input can be cleared there and the delete retried.
//
// The refusal is the server's to make, not this page's. Project Instance never
// pre-checks dependents before offering Delete, because the answer it cached
// could be stale by the time the user confirms and a delete refused for a
// reason that no longer holds is worse than one round trip.

import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260827a";

// Matches DELETE_BLOCKED_BY_DEPENDENTS in
// app_server/services/dataset_instance_index_service.py. Pinned by
// frontend/tests/project_instance_delete_dependents.test.mjs.
export const DELETE_BLOCKED_BY_DEPENDENTS = "dataset_has_dependents";

export function installProjectInstanceDeleteGuard(ctx) {
  const { api, state } = ctx;

  const toText = (value) => String(value ?? "").trim();

  /**
   * Returns the structured refusal when a delete was blocked by dependents.
   *
   * FastAPI nests a raised detail under `detail`; the same object arrives
   * unchanged whether the delete ran here or on the Gateway, so one shape is
   * enough. Anything else -- a plain error string, a different status -- is not
   * this refusal and is left to the caller's normal error handling.
   */
  function readDeleteBlockedDetail(payload) {
    const detail = payload?.detail;
    if (!detail || typeof detail !== "object") return null;
    if (toText(detail.error) !== DELETE_BLOCKED_BY_DEPENDENTS) return null;
    const blocked = Array.isArray(detail.blocked_datasets) ? detail.blocked_datasets : [];
    const entries = blocked
      .map((item) => ({
        datasetName: toText(item?.dataset_name),
        dependents: (Array.isArray(item?.dependents) ? item.dependents : [])
          .map((dependent) => ({
            datasetName: toText(dependent?.dataset_name),
            methodType: toText(dependent?.method_type),
          }))
          .filter((dependent) => dependent.datasetName),
      }))
      .filter((item) => item.datasetName && item.dependents.length);
    if (!entries.length) return null;
    return { message: toText(detail.message), blockedDatasets: entries };
  }

  /**
   * One link per (blocked dataset, dependent) pair.
   *
   * The upstream name is only appended when more than one dataset was blocked:
   * with a single blocked dataset the message already names it, and repeating
   * it on every row would just make the names harder to scan.
   */
  function buildDependentLinks(blockedDatasets) {
    const showsUpstream = blockedDatasets.length > 1;
    const links = [];
    const seen = new Set();
    for (const blocked of blockedDatasets) {
      for (const dependent of blocked.dependents) {
        const key = JSON.stringify([blocked.datasetName.toLowerCase(), dependent.datasetName.toLowerCase()]);
        if (seen.has(key)) continue;
        seen.add(key);
        const type = dependent.methodType && dependent.methodType !== "None"
          ? ` — ${dependent.methodType}`
          : "";
        const upstream = showsUpstream ? ` (uses ${blocked.datasetName})` : "";
        links.push({
          label: `${dependent.datasetName}${type}${upstream}`,
          datasetName: dependent.datasetName,
          methodType: dependent.methodType,
          ariaLabel: `Open ${dependent.datasetName} to clear its ${blocked.datasetName} input`,
        });
      }
    }
    return links;
  }

  function blockedMessage(detail) {
    if (detail.message) return detail.message;
    const names = detail.blockedDatasets.map((item) => item.datasetName).join(", ");
    return `${names} is used as input by other objects in this reserving class. `
      + "Open each dependent listed below and clear this input there, then delete again.";
  }

  /** Shows the blocking dependents and opens whichever one the user clicks. */
  async function showDeleteBlockedByDependents(detail) {
    let requestedDependent = null;
    await showPageMessageBox({
      title: "Cannot delete: still in use",
      message: blockedMessage(detail),
      tone: "warn",
      links: buildDependentLinks(detail.blockedDatasets),
      closeOnLinkClick: true,
      onLinkClick: (item) => {
        requestedDependent = item;
      },
      okLabel: "Close",
    });
    // Opened after the box has closed, so the new window is not left sitting
    // behind the modal's inert overlay.
    if (!requestedDependent) return;
    api.openDependentDatasetByName?.(requestedDependent.datasetName, {
      reservingClass: state.selectedPath,
      methodType: requestedDependent.methodType,
    });
  }

  Object.assign(api, {
    readDeleteBlockedDetail,
    showDeleteBlockedByDependents,
  });
}
