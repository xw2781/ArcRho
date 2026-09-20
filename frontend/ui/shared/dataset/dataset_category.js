// The category displayed for an indexed instance, shared by PI and its graph.
export function datasetInstanceCategory(instance, datasetTypeCategory = "") {
  return String(instance?.dataset_category || instance?.category || "").trim()
    || String(datasetTypeCategory ?? "").trim();
}
