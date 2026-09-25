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

function identityBody({ project_name, reserving_class, method_name } = {}) {
  return {
    project_name: text(project_name),
    reserving_class: text(reserving_class),
    method_name: text(method_name),
  };
}

function saveBody({
  project_name,
  reserving_class,
  method,
  notes,
  expected_owned_revision,
  expected_derived_revision,
  plan_fingerprint,
} = {}) {
  return {
    project_name: text(project_name),
    reserving_class: text(reserving_class),
    method,
    notes: String(notes ?? ""),
    ...(text(expected_owned_revision) ? { expected_owned_revision: text(expected_owned_revision) } : {}),
    ...(text(expected_derived_revision) ? { expected_derived_revision: text(expected_derived_revision) } : {}),
    ...(text(plan_fingerprint) ? { plan_fingerprint: text(plan_fingerprint) } : {}),
  };
}

export function loadBootstrapMethod(identity = {}, options = {}) {
  return requestJson("/bootstrap/load", identityBody(identity), options);
}

/* Runs the settings on screen on the server and returns the method with the
   new run; nothing is written, and Save publishes the same run. */
export function simulateBootstrapMethod({ project_name, reserving_class, method } = {}, options = {}) {
  return requestJson("/bootstrap/simulate", {
    project_name: text(project_name),
    reserving_class: text(reserving_class),
    method,
  }, options);
}

/* Re-runs the run a method holds and returns its percentile ladder at the
   interval (in percent), scaled and unscaled; nothing is read or written. */
export function loadBootstrapLadder({ method, interval } = {}, options = {}) {
  return requestJson("/bootstrap/ladder", { method, interval: Number(interval) }, options);
}

export function planBootstrapSave(input = {}, options = {}) {
  return requestJson("/bootstrap/save/plan", saveBody(input), options);
}

export function saveBootstrapMethod(input = {}, options = {}) {
  return requestJson("/bootstrap/save", saveBody(input), options);
}

export function refreshBootstrapMethod(identity = {}, options = {}) {
  return requestJson("/bootstrap/refresh", identityBody(identity), options);
}
