import {
  DETAILS_FIELD_ATTRIBUTE,
  setDetailsFieldsHidden,
} from "/ui/shared/tabs/details/details_form_layout.js?v=20260817a";

export { DETAILS_FIELD_ATTRIBUTE };

/**
 * Details rows whose value the host already fixes. They are read-only wherever
 * they still appear, so showing them spends a form row on something the user
 * cannot act on.
 */
export const HOST_FIXED_DETAILS_FIELDS = Object.freeze(["project", "method_type"]);

/**
 * A Workflow step is the one host that still lets the user choose the project
 * inside the embedded page: it opens the Dataset Viewer and DFM with no project
 * of its own and reads the selection back out of the Details tab. Project
 * Instance windows pass the project down and pin it, so they hide the row.
 */
export function hostFixesDetailsProject(search = globalThis.location?.search) {
  const params = new URLSearchParams(String(search ?? ""));
  return !(params.get("wf") || "").trim();
}

/**
 * Hides the host-fixed Details rows on every page whose host supplies them.
 * Call before `syncDetailsLabelWidth` so a hidden label cannot widen the shared
 * label column.
 */
export function applyHostFixedDetailsFields({
  root,
  search = globalThis.location?.search,
  documentRef = globalThis.document,
} = {}) {
  return setDetailsFieldsHidden(
    root,
    HOST_FIXED_DETAILS_FIELDS,
    hostFixesDetailsProject(search),
    { documentRef },
  );
}
