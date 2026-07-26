import { loadDatasetSidecar } from "/ui/shared/dataset/dataset_api.js";
import { createAuditLogView } from "/ui/shared/tabs/audit_log/audit_log_view.js?v=20260714c";
import {
  formatSidecarAuditEventDate,
  normalizeSidecarAuditEntries,
} from "/ui/shared/tabs/audit_log/sidecar_audit_entries.js?v=20260714c";
import {
  getResolvedProjectName,
  getResolvedReservingClass,
  getDefaultMethodName,
} from "/ui/method_pages/dfm/dfm_state.js";
import { setDfmNotesText } from "/ui/method_pages/dfm/dfm_notes_tab.js?v=20260714a";

let auditLogView = null;
let auditRequestSequence = 0;
let hydratedDfmSidecar = null;
let hydratedOutputDataset = "";

function isPersistedMethodBootstrap() {
  return Boolean(new URLSearchParams(globalThis.location?.search || "").get("method_name"));
}

function getDfmAuditContext() {
  return {
    project_name: String(getResolvedProjectName() || "").trim(),
    reserving_class: String(getResolvedReservingClass() || "").trim(),
    dataset_name: hydratedOutputDataset
      || String(document.getElementById("dfmMethodName")?.value || "").trim()
      || getDefaultMethodName(),
  };
}

function hasDfmAuditContext(context) {
  return Boolean(context.project_name && context.reserving_class && context.dataset_name);
}

export function initDfmAuditLog(container = document.getElementById("dfmAuditLogMount")) {
  if (auditLogView || !container) return auditLogView;
  auditLogView = createAuditLogView({
    container,
    ariaLabel: "DFM audit log",
    emptyDescription: "DFM saves will appear here after the first save.",
    normalizeEntries: normalizeSidecarAuditEntries,
    formatEventDate: formatSidecarAuditEventDate,
  });
  return auditLogView;
}

export function renderDfmAuditLog(entries = []) {
  auditRequestSequence += 1;
  initDfmAuditLog()?.render(entries);
}

export function hydrateDfmOutputSidecar(sidecar, options = {}) {
  auditRequestSequence += 1;
  hydratedDfmSidecar = sidecar && typeof sidecar === "object" ? sidecar : {};
  hydratedOutputDataset = String(options.outputDataset || hydratedDfmSidecar.dataset_name || "").trim();
  if (options.hydrateNotes !== false) {
    setDfmNotesText(String(hydratedDfmSidecar.notes ?? ""));
  }
  initDfmAuditLog()?.render(hydratedDfmSidecar.audit_log || []);
  return hydratedDfmSidecar;
}

export function clearHydratedDfmOutputSidecar() {
  auditRequestSequence += 1;
  hydratedDfmSidecar = null;
  hydratedOutputDataset = "";
}

export async function refreshDfmAuditLog(options = {}) {
  const view = initDfmAuditLog();
  if (!view) return false;

  if (hydratedDfmSidecar) {
    if (options.hydrateNotes === true) {
      setDfmNotesText(String(hydratedDfmSidecar.notes ?? ""));
    }
    view.render(hydratedDfmSidecar.audit_log || []);
    return true;
  }
  if (isPersistedMethodBootstrap()) {
    view.setLoading("Loading audit log...");
    return false;
  }

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
    if (options.hydrateNotes === true) {
      setDfmNotesText(response.data?.exists ? String(response.data.notes ?? "") : "");
    }
    view.render(response.data?.exists ? response.data.audit_log : []);
    return true;
  } catch (error) {
    if (requestSequence !== auditRequestSequence) return false;
    view.setError(error?.message || "Unable to load the audit log.");
    return false;
  }
}
