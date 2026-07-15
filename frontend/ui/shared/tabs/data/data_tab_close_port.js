let closeConfirmController = null;

export function configureDataTabCloseConfirm(controller) {
  closeConfirmController = controller && typeof controller === "object" ? controller : null;
}

export function getDataTabCloseConfirm() {
  return closeConfirmController;
}
