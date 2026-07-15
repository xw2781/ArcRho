import {
  loadProjectUserPreferences,
  scheduleProjectUserPreferencesSave,
} from "/ui/shared/services/project_user_preferences.js";
import {
  getResolvedProjectName,
  getResolvedReservingClass,
} from "/ui/method_pages/dfm/dfm_state.js";

function textValue(id) {
  return String(document.getElementById(id)?.value || "").trim();
}

function numberValue(id, fallback) {
  const raw = Number.parseInt(String(document.getElementById(id)?.value || "").trim(), 10);
  return Number.isFinite(raw) ? raw : fallback;
}

export function getCurrentDfmObjectSnapshot() {
  return {
    project: getResolvedProjectName() || textValue("projectSelect"),
    reservingClass: getResolvedReservingClass() || textValue("pathInput"),
    methodName: textValue("dfmMethodName"),
    outputVector: textValue("dfmOutputVector"),
    inputTriangle: textValue("triInput"),
    originLength: numberValue("originLenSelect", 12),
    developmentLength: numberValue("devLenSelect", 12),
    decimalPlaces: numberValue("decimalPlaces", 4),
  };
}

function normalizeDfmPrefs(raw, projectFallback = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const project = String(source.project || source.project_name || projectFallback || "").trim();
  const reservingClass = String(
    source.lastReservingClassPath
    || source.last_reserving_class_path
    || source.reservingClass
    || source.reserving_class
    || source.path
    || "",
  ).trim();
  const methodName = String(source.methodName || source.method_name || "").trim();
  const outputVector = String(source.outputVector || source.output_vector || "").trim();
  const inputTriangle = String(source.inputTriangle || source.input_triangle || source.datasetName || source.dataset_name || "").trim();
  if (!project) return null;
  return {
    project,
    reservingClass,
    methodName,
    outputVector,
    inputTriangle,
    originLength: Number.parseInt(String(raw.originLength || raw.origin_length || 12), 10) || 12,
    developmentLength: Number.parseInt(String(raw.developmentLength || raw.development_length || 12), 10) || 12,
    decimalPlaces: Number.parseInt(String(raw.decimalPlaces || raw.decimal_places || 4), 10) || 4,
  };
}

export async function getLastDfmObjectSnapshot(projectName = "") {
  const project = String(projectName || "").trim();
  if (!project) return null;
  try {
    const prefs = await loadProjectUserPreferences(project);
    return normalizeDfmPrefs({
      ...(prefs?.dfmObject && typeof prefs.dfmObject === "object" ? prefs.dfmObject : {}),
      lastReservingClassPath: prefs?.lastReservingClassPath || prefs?.last_reserving_class_path || "",
    }, project);
  } catch {
    return null;
  }
}

export function recordDfmObjectSnapshot(snapshot = {}) {
  const data = {
    project: String(snapshot.project || "").trim(),
    reservingClass: String(snapshot.reservingClass || "").trim(),
    methodName: String(snapshot.methodName || "").trim(),
    outputVector: String(snapshot.outputVector || "").trim(),
    inputTriangle: String(snapshot.inputTriangle || "").trim(),
    originLength: Number.parseInt(String(snapshot.originLength || 12), 10) || 12,
    developmentLength: Number.parseInt(String(snapshot.developmentLength || 12), 10) || 12,
    decimalPlaces: Number.parseInt(String(snapshot.decimalPlaces || 4), 10) || 4,
    savedAt: new Date().toISOString(),
  };
  scheduleProjectUserPreferencesSave(data.project, {
    lastReservingClassPath: data.reservingClass,
    dfmObject: {
      datasetName: data.inputTriangle,
      methodName: data.methodName,
      outputVector: data.outputVector,
      inputTriangle: data.inputTriangle,
      originLength: data.originLength,
      developmentLength: data.developmentLength,
      decimalPlaces: data.decimalPlaces,
      updated_at: new Date().toISOString(),
    },
  });
  return data;
}

export function recordCurrentDfmObjectSnapshot() {
  return recordDfmObjectSnapshot(getCurrentDfmObjectSnapshot());
}

export async function refreshDfmMethodIndex(projectName, reservingClassPath) {
  const project = String(projectName || "").trim();
  const reservingClass = String(reservingClassPath || "").trim();
  if (!project || !reservingClass) return null;
  const response = await fetch("/dfm/method-index/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_name: project, reserving_class: reservingClass }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json();
}
