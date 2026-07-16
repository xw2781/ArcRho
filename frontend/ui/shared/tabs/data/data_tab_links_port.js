let linksController = null;

export function configureDataTabLinks(controller = null) {
  linksController = controller && typeof controller === "object" ? controller : null;
}

export function getDataTabLinksController() {
  return linksController;
}
