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

export function loadBornhuetterFergusonMethod({
  project_name,
  reserving_class,
  method_name,
} = {}, options = {}) {
  return requestJson("/bornhuetter-ferguson/load", {
    project_name: text(project_name),
    reserving_class: text(reserving_class),
    method_name: text(method_name),
  }, options);
}

export function saveBornhuetterFergusonMethod({
  project_name,
  reserving_class,
  method,
  notes,
  expected_owned_revision,
  expected_derived_revision,
} = {}, options = {}) {
  return requestJson("/bornhuetter-ferguson/save", {
    project_name: text(project_name),
    reserving_class: text(reserving_class),
    method,
    notes: String(notes ?? ""),
    ...(text(expected_owned_revision)
      ? { expected_owned_revision: text(expected_owned_revision) }
      : {}),
    ...(text(expected_derived_revision)
      ? { expected_derived_revision: text(expected_derived_revision) }
      : {}),
  }, options);
}
