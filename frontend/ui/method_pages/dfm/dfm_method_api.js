export const DFM_METHOD_JSON_FORMAT = "arcrho-dfm-v4";

function text(value) {
  return String(value ?? "").trim();
}

async function requestJson(path, body, options = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(text(payload?.detail || payload?.error) || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function isDfmV2Method(method) {
  return text(method?.["json_format"]) === DFM_METHOD_JSON_FORMAT;
}

export function readDfmMethodIdentityFromPage() {
  const query = new URLSearchParams(globalThis.location?.search || "");
  return {
    project_name: text(document.getElementById("projectSelect")?.value || query.get("project")),
    reserving_class: text(document.getElementById("pathInput")?.value || query.get("class")),
    method_name: text(document.getElementById("dfmMethodName")?.value || query.get("method_name")),
    output_dataset: text(query.get("output_dataset")),
  };
}

export function loadDfmMethod(identity, options = {}) {
  return requestJson("/dfm/method/load", {
    project_name: text(identity?.project_name),
    reserving_class: text(identity?.reserving_class),
    method_name: text(identity?.method_name),
    ...(text(identity?.output_dataset) ? { output_dataset: text(identity.output_dataset) } : {}),
  }, options);
}

export function resolveDfmDatasetReferences(payload, options = {}) {
  return requestJson("/dfm/method/dataset-references/resolve", payload, options);
}

export async function listDfmDatasetInstances(identity, options = {}) {
  const projectName = text(identity?.project_name);
  const reservingClass = text(identity?.reserving_class);
  if (!projectName || !reservingClass) return [];
  const url = new URL("/datasets/cached", globalThis.location?.origin || "http://localhost");
  url.searchParams.set("project_name", projectName);
  url.searchParams.set("reserving_class", reservingClass);
  const response = await fetch(url.toString(), { cache: "no-store", signal: options.signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(text(payload?.detail || payload?.error) || `HTTP ${response.status}`);
  }
  return (Array.isArray(payload?.files) ? payload.files : [])
    .map((item) => text(item?.name))
    .filter(Boolean);
}

export function previewDfmMethod(method, options = {}) {
  return requestJson("/dfm/method/preview", { method }, options);
}

function dfmMethodSaveBody({
  project_name,
  reserving_class,
  method,
  notes,
  expected_owned_revision,
  expected_derived_revision,
} = {}) {
  return {
    project_name: text(project_name),
    reserving_class: text(reserving_class),
    method,
    notes: String(notes ?? ""),
    ...(text(expected_owned_revision) ? { expected_owned_revision: text(expected_owned_revision) } : {}),
    ...(text(expected_derived_revision) ? { expected_derived_revision: text(expected_derived_revision) } : {}),
  };
}

export function saveDfmMethod(input = {}, options = {}) {
  return requestJson("/dfm/method/save", dfmMethodSaveBody(input), options);
}

export function refreshDfmMethod(identity, options = {}) {
  return requestJson("/dfm/method/refresh", {
    project_name: text(identity?.project_name),
    reserving_class: text(identity?.reserving_class),
    method_name: text(identity?.method_name),
    ...(text(identity?.output_dataset) ? { output_dataset: text(identity.output_dataset) } : {}),
  }, options);
}
