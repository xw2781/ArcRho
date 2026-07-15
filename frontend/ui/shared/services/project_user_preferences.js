const prefsByProject = new Map();
const pendingSaveByProject = new Map();

function normalizeProject(projectName) {
  return String(projectName || "").trim();
}

function projectKey(projectName) {
  return normalizeProject(projectName).toLowerCase();
}

function mergeDeep(base, patch) {
  const out = { ...(base && typeof base === "object" ? base : {}) };
  if (!patch || typeof patch !== "object") return out;
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeDeep(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function loadProjectUserPreferences(projectName, options = {}) {
  const project = normalizeProject(projectName);
  if (!project) return {};
  const key = projectKey(project);
  if (!options?.forceReload && prefsByProject.has(key)) return prefsByProject.get(key);
  const response = await fetch(`/project-user-preferences?project_name=${encodeURIComponent(project)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
  const payload = await response.json().catch(() => ({}));
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  prefsByProject.set(key, data);
  return data;
}

export async function saveProjectUserPreferences(projectName, patch) {
  const project = normalizeProject(projectName);
  if (!project || !patch || typeof patch !== "object") return null;
  const response = await fetch("/project-user-preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_name: project, data: patch }),
  });
  if (!response.ok) throw new Error(await response.text().catch(() => `HTTP ${response.status}`));
  const payload = await response.json().catch(() => ({}));
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  prefsByProject.set(projectKey(project), data);
  return data;
}

export function scheduleProjectUserPreferencesSave(projectName, patch, delayMs = 250) {
  const project = normalizeProject(projectName);
  if (!project || !patch || typeof patch !== "object") return;
  const key = projectKey(project);
  const pending = pendingSaveByProject.get(key) || {};
  if (pending.timer) clearTimeout(pending.timer);
  const { timer, ...pendingData } = pending;
  const nextPending = mergeDeep(pendingData, patch);
  nextPending.timer = setTimeout(() => {
    const next = pendingSaveByProject.get(key) || {};
    pendingSaveByProject.delete(key);
    const { timer: _timer, ...data } = next;
    saveProjectUserPreferences(project, data).catch((err) => {
      console.warn("Failed to save project user preferences:", err);
    });
  }, delayMs);
  pendingSaveByProject.set(key, nextPending);
}
