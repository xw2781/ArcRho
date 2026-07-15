let auditController = null;

export function configureDataTabAudit(controller) {
  auditController = controller && typeof controller === "object" ? controller : null;
}

export function getDataTabAuditController() {
  return auditController;
}
