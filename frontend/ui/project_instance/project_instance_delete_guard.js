// An object that is still some other object's input may not be deleted on its
// own: the server refuses the whole request with 409, names what is using it,
// and includes the full downstream closure. This module turns that refusal
// into the window the user can act from — every listed object is a link that
// opens its own method or dataset window, and one action offers deleting the
// whole dependency chain in a single confirmed resubmission, which matches how
// ResQ removes an object together with what reads it.
//
// The refusal is the server's to make, not this page's. Project Instance never
// pre-checks dependents before offering Delete, because the answer it cached
// could be stale by the time the user confirms and a delete refused for a
// reason that no longer holds is worse than one round trip.

import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260831a";

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
    const closure = (Array.isArray(detail.downstream_closure) ? detail.downstream_closure : [])
      .map((item) => ({
        datasetName: toText(item?.dataset_name),
        methodType: toText(item?.method_type),
      }))
      .filter((item) => item.datasetName);
    return {
      message: toText(detail.message),
      blockedDatasets: entries,
      downstreamClosure: closure,
    };
  }

  /**
   * One link per downstream object. The closure is the walk's own breadth-first
   * order, so the direct dependents lead and deeper descendants follow; when
   * no closure came back the direct dependents are the list.
   */
  function buildDependentLinks(detail) {
    if (detail.downstreamClosure.length) {
      return detail.downstreamClosure.map((item) => {
        const type = item.methodType && item.methodType !== "None"
          ? ` — ${item.methodType}`
          : "";
        return {
          label: `${item.datasetName}${type}`,
          datasetName: item.datasetName,
          methodType: item.methodType,
          ariaLabel: `Open ${item.datasetName} in its own window`,
        };
      });
    }
    const showsUpstream = detail.blockedDatasets.length > 1;
    const links = [];
    const seen = new Set();
    for (const blocked of detail.blockedDatasets) {
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
    const base = detail.message || (() => {
      const names = detail.blockedDatasets.map((item) => item.datasetName).join(", ");
      return `${names} is used as input by other objects in this reserving class. `
        + "Open each dependent listed below and clear this input there, then delete again.";
    })();
    if (!detail.downstreamClosure.length) return base;
    const count = detail.downstreamClosure.length;
    return `${base}\nOr delete the selection together with ${count === 1
      ? "the 1 downstream object"
      : `all ${count} downstream objects`} listed below.`;
  }

  /**
   * Shows the blocking chain. Resolves with `{deleteChainNames}` when the user
   * chose to delete the whole dependency chain (the caller resubmits the
   * delete with those names included), or `null` when the box was dismissed or
   * a listed object was opened instead.
   */
  async function showDeleteBlockedByDependents(detail) {
    let requestedDependent = null;
    const chainNames = detail.downstreamClosure.map((item) => item.datasetName);
    const action = await showPageMessageBox({
      title: "Cannot delete: still in use",
      message: blockedMessage(detail),
      tone: "warn",
      links: buildDependentLinks(detail),
      closeOnLinkClick: true,
      onLinkClick: (item) => {
        requestedDependent = item;
      },
      actions: chainNames.length
        ? [{
          id: "delete-chain",
          label: chainNames.length === 1
            ? "Delete all (1 downstream)"
            : `Delete all (${chainNames.length} downstream)`,
        }]
        : [],
      okLabel: "Close",
    });
    // Opened after the box has closed, so the new window is not left sitting
    // behind the modal's inert overlay.
    if (requestedDependent) {
      api.openDependentDatasetByName?.(requestedDependent.datasetName, {
        reservingClass: state.selectedPath,
        methodType: requestedDependent.methodType,
      });
      return null;
    }
    if (action === "delete-chain" && chainNames.length) {
      return { deleteChainNames: chainNames };
    }
    return null;
  }

  Object.assign(api, {
    readDeleteBlockedDetail,
    showDeleteBlockedByDependents,
  });
}
