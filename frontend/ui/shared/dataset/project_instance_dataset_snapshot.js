const SNAPSHOT_KEY_PREFIX = "arcrho:project-instance-dataset-snapshot:v1:";

function text(value) {
  return String(value ?? "").trim();
}

function storageKey(projectName, reservingClass) {
  const project = text(projectName).toLowerCase();
  const path = text(reservingClass).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return project && path
    ? `${SNAPSHOT_KEY_PREFIX}${encodeURIComponent(project)}:${encodeURIComponent(path)}`
    : "";
}

export function publishProjectInstanceDatasetSnapshot(projectName, reservingClass, payload) {
  const key = storageKey(projectName, reservingClass);
  if (!key || !payload || typeof payload !== "object" || !Array.isArray(payload.files)) return false;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function readProjectInstanceDatasetSnapshot(projectName, reservingClass) {
  const key = storageKey(projectName, reservingClass);
  if (!key) return null;
  try {
    const payload = JSON.parse(window.sessionStorage.getItem(key) || "null");
    return payload && typeof payload === "object" && Array.isArray(payload.files)
      ? payload
      : null;
  } catch {
    return null;
  }
}
