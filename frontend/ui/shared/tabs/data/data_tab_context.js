const DATA_TAB_HOSTS = new Set(["dataset_viewer", "dfm"]);

let dataTabHost = "dataset_viewer";

export function configureDataTabHost(host) {
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (!DATA_TAB_HOSTS.has(normalizedHost)) {
    throw new Error(`Unsupported Dataset Data-tab host: ${host}`);
  }
  dataTabHost = normalizedHost;
}

export function getDataTabHost() {
  return dataTabHost;
}

export function isDfmDataTabHost() {
  return dataTabHost === "dfm";
}
