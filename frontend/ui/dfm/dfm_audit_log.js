import { loadDatasetSidecar } from "/ui/shared/api.js";
import { createDatasetAuditLog } from "/ui/shared/dataset_audit_log.js?v=20260714b";
import {
  getResolvedProjectName,
  getResolvedReservingClass,
  getDefaultMethodName,
} from "/ui/dfm/dfm_state.js";

let auditLogView = null;
let auditRequestSequence = 0;

function getDfmAuditContext() {
  return {
    project_name: String(getResolvedProjectName() || "").trim(),
    reserving_class: String(getResolvedReservingClass() || "").trim(),
    dataset_name: String(document.getElementById("dfmMethodName")?.value || "").trim()
      || getDefaultMethodName(),
  };
}

function hasDfmAuditContext(context) {
  return Boolean(context.project_name && context.reserving_class && context.dataset_name);
}

export function initDfmAuditLog(container = document.getElementById("dfmAuditLogMount")) {
  if (auditLogView || !container) return auditLogView;
  auditLogView = createDatasetAuditLog({
    container,
    ariaLabel: "DFM audit log",
    emptyDescription: "DFM saves will appear here after the first save.",
  });
  return auditLogView;
}

export function renderDfmAuditLog(entries = []) {
  auditRequestSequence += 1;
  initDfmAuditLog()?.render(entries);
}

export async function refreshDfmAuditLog() {
  const view = initDfmAuditLog();
  if (!view) return false;

  const context = getDfmAuditContext();
  const requestSequence = ++auditRequestSequence;
  if (!hasDfmAuditContext(context)) {
    view.render([]);
    return false;
  }

  view.setLoading("Loading audit log...");
  try {
    const response = await loadDatasetSidecar(context);
    if (requestSequence !== auditRequestSequence) return false;
    if (!response.ok) {
      view.setError(response.data?.detail || "Unable to load the audit log.");
      return false;
    }
    view.render(response.data?.exists ? response.data.audit_log : []);
    return true;
  } catch (error) {
    if (requestSequence !== auditRequestSequence) return false;
    view.setError(error?.message || "Unable to load the audit log.");
    return false;
  }
}
