// Step one of the two-step save, shared by every ArcRho editor window.
//
// A save rewrites every dependent object it can reach, and the user used to
// learn which ones only after the write had landed. Each save endpoint now has
// a sibling `<save url>/plan` that answers the same question first: ArcRho
// Engine walks the dependency graphs, writes nothing, and returns the objects
// the save would refresh plus a `fingerprint` of the graph it read.
//
// The page shows that list, and only if the user confirms does it send the
// save with `plan_fingerprint` set. The Engine rechecks the fingerprint under
// the reserving-class lease and refuses with 409 when the class moved while
// the dialog was open, so a save can never land against a list nobody saw.
// The lease is deliberately not held across that pause — it would block every
// other save in the class for as long as the dialog stayed open.
//
// A plan that reaches nothing is not worth a dialog: those saves proceed
// straight through, which is most of them.

import { showPageMessageBox } from "/ui/shared/components/message_box/message_box.js?v=20260813e";

// Enough names to judge the blast radius without turning the box into a list
// the user has to scroll; the remainder is counted, never silently dropped.
const MAX_LISTED_DEPENDENTS = 25;

/** Returns the plan endpoint that belongs to one save endpoint. */
export function savePlanUrl(saveUrl) {
  const url = String(saveUrl || "").trim();
  return url ? `${url}/plan` : "";
}

/** Builds the confirmation text for one plan. */
export function describeSavePlan(plan, { subject = "this object" } = {}) {
  const dependents = Array.isArray(plan?.dependents) ? plan.dependents : [];
  const count = dependents.length;
  const listed = dependents.slice(0, MAX_LISTED_DEPENDENTS).map((item) => {
    const name = String(item?.dataset_name || "").trim() || "(unnamed)";
    const kind = String(item?.kind || "").trim();
    return kind ? `  • ${name}  (${kind})` : `  • ${name}`;
  });
  const remaining = count - listed.length;
  if (remaining > 0) listed.push(`  • ...and ${remaining} more`);
  return [
    `Saving ${subject} can refresh ${count} dependent object${count === 1 ? "" : "s"}:`,
    "",
    listed.join("\n"),
    "",
    // The walk prunes branches whose output did not actually move, so the
    // plan is honestly a superset - promising an exact list would train
    // users to distrust the dialog.
    "These are the objects this save can reach; some may already be up to date and be left unchanged.",
    "Nothing has been saved yet.",
  ].join("\n");
}

/** Asks the app server for one save's dependent-update plan. */
export async function requestSavePlan(planUrl, payload, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const response = await fetchImpl(String(planUrl || ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      String(data?.detail || data?.message || `HTTP ${response.status}`).trim(),
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * Shows one plan and returns whether the user chose to go ahead.
 *
 * The confirming button is an action and Cancel is the box's own OK, so every
 * dismissal the message box treats like OK — Escape, the close button, a
 * backdrop click — cancels the save instead of committing it.
 */
export async function confirmSavePlan(plan, { subject, documentRef } = {}) {
  const choice = await showPageMessageBox({
    title: "Dependent updates",
    message: describeSavePlan(plan, { subject }),
    actions: [{ id: "confirm", label: "Save and update" }],
    okLabel: "Cancel",
    balancedActions: true,
    // The message box owns the default document; naming one here only when a
    // caller supplied it keeps this module importable without a DOM.
    ...(documentRef ? { documentRef } : {}),
  });
  return choice === "confirm";
}

/**
 * Runs the plan step for one save and asks the user to confirm it.
 *
 * @param {Object} options
 * @param {Function} [options.requestPlan] - Resolves with the plan and throws
 *   on refusal; pages with their own API layer pass its plan call here so the
 *   plan travels the same request path as the save.
 * @param {string} [options.saveUrl] - Save endpoint; its `/plan` sibling is
 *   posted to when `requestPlan` is not given.
 * @param {string} [options.planUrl] - Plan endpoint, when it is not `saveUrl + "/plan"`.
 * @param {Object} [options.payload] - Exactly the body the save will send, so
 *   the plan and the save resolve the same propagation roots.
 * @param {string} options.subject - Saved object name, such as `Cape Cod`.
 * @param {Function} [options.showDialog] - Wraps the dialog; pages pass
 *   `progress.duringDialog` so the saving spinner drops while it is up.
 * @returns {Promise<{proceed: boolean, cancelled?: boolean, failed?: boolean,
 *   fingerprint: string, plan: Object|null, error?: Error, message?: string}>}
 */
export async function planAndConfirmSave({
  requestPlan = null,
  saveUrl = "",
  planUrl = "",
  payload,
  subject = "this object",
  documentRef,
  fetchImpl,
  showDialog = (work) => work(),
} = {}) {
  const url = String(planUrl || savePlanUrl(saveUrl)).trim();
  if (typeof requestPlan !== "function" && !url) {
    return { proceed: false, failed: true, fingerprint: "", plan: null, message: "No dependent-update plan endpoint was configured for this save." };
  }

  let plan;
  try {
    plan = typeof requestPlan === "function"
      ? await requestPlan()
      : await requestSavePlan(url, payload, { fetchImpl });
  } catch (error) {
    // The plan preflights the same conditions the save does (no live Engine,
    // a class still being rewritten), so its refusal is the save's refusal.
    // Saving anyway would drop the review step exactly when the class is
    // least predictable; the edit stays in the editor either way.
    return {
      proceed: false,
      failed: true,
      fingerprint: "",
      plan: null,
      error,
      message: String(error?.message || "Could not determine which dependent objects this save would update.").trim(),
    };
  }

  const fingerprint = String(plan?.fingerprint || "");
  if (!(Number(plan?.dependent_count) > 0)) {
    return { proceed: true, confirmed: false, fingerprint, plan };
  }

  const confirmed = await showDialog(() => confirmSavePlan(plan, { subject, documentRef }));
  if (!confirmed) {
    return { proceed: false, cancelled: true, fingerprint, plan, message: "Save cancelled; nothing was changed." };
  }
  return { proceed: true, confirmed: true, fingerprint, plan };
}
