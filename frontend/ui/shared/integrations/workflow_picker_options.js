const WF_GLOBAL_CTRL_PREFIX = "arcrho_workflow_global_ctrl_v1::";

function toText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeNameKey(value) {
  return toText(value).replace(/\s+/g, " ").toLowerCase();
}

function normalizeGlobalVarType(type, key = "") {
  const raw = toText(type).toLowerCase();
  if (raw === "project") return "project";
  if (raw === "reservingclass" || raw === "reserving_class" || raw === "reserving class") {
    return "reservingClass";
  }
  if (raw === "string" || raw === "other") return "string";
  if (key === "project") return "project";
  if (key === "reservingClass") return "reservingClass";
  return "string";
}

function normalizeGlobalControl(input) {
  const obj = input && typeof input === "object" ? input : {};
  if (Array.isArray(obj.vars)) return obj.vars;

  const legacy = [];
  if ("project" in obj) {
    legacy.push({ key: "project", name: "<Default Project>", type: "project", value: obj.project });
  }
  if ("reservingClass" in obj) {
    legacy.push({
      key: "reservingClass",
      name: "Default Path",
      type: "reservingClass",
      value: obj.reservingClass,
    });
  }
  return legacy;
}

function getSearchParams() {
  try {
    return new URLSearchParams(window.location.search || "");
  } catch {
    return new URLSearchParams();
  }
}

export function getWorkflowIdFromPickerOptions(options = {}) {
  const explicit = toText(options?.workflowId || options?.workflowInstanceId);
  if (explicit) return explicit;

  const qs = getSearchParams();
  const embeddedWorkflowId = toText(qs.get("wf"));
  if (embeddedWorkflowId) return embeddedWorkflowId;

  const pathname = toText(window.location?.pathname).replace(/\\/g, "/").toLowerCase();
  if (pathname.endsWith("/ui/workflow/workflow.html") || pathname.endsWith("/workflow/workflow.html")) {
    return toText(qs.get("inst")) || "default";
  }
  return "";
}

export function loadWorkflowGlobalControlForPicker(options = {}) {
  const workflowId = getWorkflowIdFromPickerOptions(options);
  if (!workflowId) return { workflowId: "", vars: [] };

  try {
    const raw = window.localStorage?.getItem(`${WF_GLOBAL_CTRL_PREFIX}${workflowId}`) || "";
    if (!raw) return { workflowId, vars: [] };
    const parsed = JSON.parse(raw);
    return { workflowId, vars: normalizeGlobalControl(parsed) };
  } catch {
    return { workflowId, vars: [] };
  }
}

export function getWorkflowGlobalValuesForPicker(rawType, options = {}) {
  const targetType = normalizeGlobalVarType(rawType);
  const { workflowId, vars } = loadWorkflowGlobalControlForPicker(options);
  if (!workflowId) return [];

  const out = [];
  const seen = new Set();
  for (const variable of vars) {
    if (!variable || typeof variable !== "object") continue;
    const key = toText(variable.key);
    const type = normalizeGlobalVarType(variable.type, key);
    if (type !== targetType) continue;
    const value = toText(variable.value);
    if (!value || value.toLowerCase() === "__default__") continue;
    const valueKey = normalizeNameKey(value);
    if (!valueKey || seen.has(valueKey)) continue;
    seen.add(valueKey);
    out.push({
      key,
      name: toText(variable.name) || key || value,
      type,
      value,
    });
  }
  return out;
}

export function buildWorkflowProjectRootNode(options = {}, fullPathByProject = null) {
  const values = getWorkflowGlobalValuesForPicker("project", options);
  if (!values.length) return null;

  return {
    name: "Current Workflow",
    path: "__virtual_workflow_projects",
    level_label: "Workflow",
    value_type: "virtual-folder",
    has_children: true,
    children: values.map((item) => {
      const mappedPath = fullPathByProject instanceof Map
        ? fullPathByProject.get(normalizeNameKey(item.value))
        : "";
      return {
        name: item.name || "Project",
        path: mappedPath || item.value,
        level_label: "Project",
        display_detail: item.value,
        select_value: item.value,
        has_children: false,
      };
    }),
  };
}

export function buildWorkflowPathRootNode(options = {}) {
  const values = getWorkflowGlobalValuesForPicker("reservingClass", options);
  if (!values.length) return null;

  return {
    name: "Current Workflow",
    path: "__virtual_workflow_path",
    level_label: "Workflow",
    value_type: "virtual-folder",
    has_children: true,
    children: values.map((item) => ({
      name: item.value,
      path: item.value,
      level_label: item.name || "Reserving Class",
      value_type: "source",
      has_children: false,
    })),
  };
}
