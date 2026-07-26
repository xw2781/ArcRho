const DATASET_INPUT_QUERY_ALIASES = Object.freeze({
  project: Object.freeze(["project", "project_name", "p"]),
  path: Object.freeze(["path", "class", "reserving_class", "rc"]),
  tri: Object.freeze(["tri", "input_triangle", "dataset_name", "dataset"]),
  instanceName: Object.freeze(["instance_name", "instanceName"]),
  methodName: Object.freeze(["method_name", "methodName"]),
  originLen: Object.freeze(["origin_len", "originLen"]),
  devLen: Object.freeze(["dev_len", "devLen"]),
  dataFormat: Object.freeze(["data_format", "dataFormat"]),
  numberFormat: Object.freeze(["number_format", "numberFormat"]),
  decimalPlaces: Object.freeze(["decimal_places", "decimalPlaces"]),
});

function firstQueryValue(searchParams, aliases) {
  for (const alias of aliases) {
    const value = String(searchParams.get(alias) || "").trim();
    if (value) return value;
  }
  return "";
}

export function readDatasetInputQueryValues(value) {
  const searchParams = value instanceof URLSearchParams
    ? value
    : new URLSearchParams(String(value || ""));
  return Object.fromEntries(
    Object.entries(DATASET_INPUT_QUERY_ALIASES).map(([field, aliases]) => (
      [field, firstQueryValue(searchParams, aliases)]
    )),
  );
}
