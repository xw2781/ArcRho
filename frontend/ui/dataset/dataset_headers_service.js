import { validateDatasetOriginLabels } from "/ui/dataset/dataset_origin_labels.js";

export function createDatasetHeadersService(deps) {
  const { state, setStatus } = deps;

  const HEADER_CACHE_VERSION = "v3";
  const HEADER_PREFIX_V1 = "arcrho_header_labels::";
  const DEV_HEADER_PREFIX_V1 = "arcrho_dev_header_labels::";
  const HEADER_PREFIX_V2 = `${HEADER_PREFIX_V1}${HEADER_CACHE_VERSION}::`;
  const DEV_HEADER_PREFIX_V2 = `${DEV_HEADER_PREFIX_V1}${HEADER_CACHE_VERSION}::`;

  let lastHeaderKey = "";
  let lastDevHeaderKey = "";
  let headerRequestSequence = 0;
  let devHeaderRequestSequence = 0;

  function headerKey(project, originLen) {
    return `${HEADER_PREFIX_V2}${String(project || "").trim()}::${String(originLen || "")}`;
  }

  function loadHeadersCache(project, originLen) {
    try {
      const raw = localStorage.getItem(headerKey(project, originLen)) || "";
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.labels)) return parsed.labels.map(String);
    } catch {
      // ignore
    }
    return null;
  }

  function saveHeadersCache(project, originLen, labels) {
    try {
      localStorage.setItem(headerKey(project, originLen), JSON.stringify({ labels }));
    } catch {
      // ignore
    }
  }

  function getCurrentCalendarMode() {
    return document.querySelector('input[name="timeMode"][value="calendar"]')?.checked === true;
  }

  function devHeaderKey(project, originLen, devLen, calendar) {
    const mode = calendar ? "cal" : "dev";
    return `${DEV_HEADER_PREFIX_V2}${String(project || "").trim()}::${String(originLen || "")}::${String(devLen || "")}::${mode}`;
  }

  function loadDevHeadersCache(project, originLen, devLen, calendar) {
    try {
      const raw = localStorage.getItem(devHeaderKey(project, originLen, devLen, calendar)) || "";
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.labels)) return parsed.labels.map(String);
    } catch {
      // ignore
    }
    return null;
  }

  function saveDevHeadersCache(project, originLen, devLen, calendar, labels) {
    try {
      localStorage.setItem(devHeaderKey(project, originLen, devLen, calendar), JSON.stringify({ labels }));
    } catch {
      // ignore
    }
  }

  function getCurrentOriginLength() {
    const n = parseInt(document.getElementById("originLenSelect")?.value, 10);
    return Number.isFinite(n) && n > 0 ? n : 12;
  }

  function getCurrentDevLength() {
    const n = parseInt(document.getElementById("devLenSelect")?.value, 10);
    return Number.isFinite(n) && n > 0 ? n : 12;
  }

  async function fetchHeadersViaGetDataset(
    projectName,
    periodLength,
    timeoutSec = 6.0,
    periodType = 0,
    transposed = false,
    calendar = false,
  ) {
    const resp = await fetch("/arcrho/headers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ProjectName: projectName,
        PeriodLength: periodLength,
        timeout_sec: timeoutSec,
        periodType,
        Transposed: !!transposed,
        Calendar: !!calendar,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      throw new Error(String(data?.detail || data?.error || data?.message || data?.status || `headers failed: ${resp.status}`));
    }
    const labels = Array.isArray(data?.labels)
      ? data.labels
      : (Array.isArray(data?.headers)
        ? data.headers
        : (Array.isArray(data?.origin_labels) ? data.origin_labels : null));
    if (periodType === 0) {
      const result = validateDatasetOriginLabels(labels, {
        originLen: periodLength,
        requireMatchingPeriod: true,
      });
      if (!result.ok) {
        throw new Error(
          `Cannot load origin labels for project '${projectName}': ${result.error}. `
          + "Set a valid Origin Start Date in Project Settings, then try again.",
        );
      }
      return result.labels;
    }
    const normalized = Array.isArray(labels) ? labels.map((label) => String(label ?? "").trim()) : [];
    if (!normalized.length || normalized.some((label) => !label)) {
      throw new Error(`Cannot load development labels for project '${projectName}'.`);
    }
    return normalized;
  }

  function clearHeaderStateMemory() {
    headerRequestSequence += 1;
    devHeaderRequestSequence += 1;
    state.headerLabels = [];
    state.devHeaderLabels = [];
    lastHeaderKey = "";
    lastDevHeaderKey = "";
  }

  function clearLocalHeadersCache(project, options = {}) {
    const p = String(project || "").trim();
    const clearAll = !p;
    const originLen = parseInt(options?.originLen, 10);
    const devLen = parseInt(options?.devLen, 10);
    const hasTargetLengths = Number.isFinite(originLen) && originLen > 0 && Number.isFinite(devLen) && devLen > 0;

    if (!clearAll && hasTargetLengths) {
      try {
        localStorage.removeItem(headerKey(p, originLen));
        localStorage.removeItem(devHeaderKey(p, originLen, devLen, false));
        localStorage.removeItem(devHeaderKey(p, originLen, devLen, true));
      } catch {
        // ignore
      }
      return;
    }

    const oldPrefixes = clearAll
      ? [HEADER_PREFIX_V1, DEV_HEADER_PREFIX_V1]
      : [`${HEADER_PREFIX_V1}${p}::`, `${DEV_HEADER_PREFIX_V1}${p}::`];
    const newPrefixes = clearAll
      ? [HEADER_PREFIX_V2, DEV_HEADER_PREFIX_V2]
      : [`${HEADER_PREFIX_V2}${p}::`, `${DEV_HEADER_PREFIX_V2}${p}::`];
    const prefixes = oldPrefixes.concat(newPrefixes);

    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i) || "";
        if (!key) continue;
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // ignore
    }
  }

  async function clearHeadersCacheForProject(project, options = {}) {
    const p = String(project || "").trim();
    const remote = !!options?.remote;
    const keepInMemory = !!options?.keepInMemory;
    const originLen = parseInt(options?.originLen, 10);
    const devLen = parseInt(options?.devLen, 10);
    const hasTargetLengths = Number.isFinite(originLen) && originLen > 0 && Number.isFinite(devLen) && devLen > 0;

    clearLocalHeadersCache(p, hasTargetLengths ? { originLen, devLen } : {});
    if (!keepInMemory) {
      clearHeaderStateMemory();
    } else {
      headerRequestSequence += 1;
      devHeaderRequestSequence += 1;
    }

    if (!remote || !p) return;

    const payload = { ProjectName: p };
    if (hasTargetLengths) {
      payload.OriginLength = originLen;
      payload.DevelopmentLength = devLen;
    }

    const resp = await fetch("/arcrho/headers/cache/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`headers cache clear failed: ${resp.status}`);
    }
  }

  async function ensureHeadersForProject(project, options = {}) {
    const requestSequence = ++headerRequestSequence;
    const requestIsCurrent = () => requestSequence === headerRequestSequence
      && (typeof options?.isCurrent !== "function" || options.isCurrent());
    const p = String(project || "").trim();
    if (!p) {
      if (requestIsCurrent()) {
        state.headerLabels = [];
        lastHeaderKey = "";
      }
      return [];
    }
    const forceRefresh = !!options?.forceRefresh;
    const originLen = getCurrentOriginLength();
    const key = `${p}||${originLen}`;
    if (!requestIsCurrent()) return [];
    if (forceRefresh || key !== lastHeaderKey) {
      state.headerLabels = [];
      lastHeaderKey = "";
    }
    const current = validateDatasetOriginLabels(state.headerLabels, {
      originLen,
      requireMatchingPeriod: true,
    });
    if (!forceRefresh && key === lastHeaderKey && current.ok) {
      return state.headerLabels;
    }

    if (!forceRefresh) {
      // Try cache first
      const cached = loadHeadersCache(p, originLen);
      const cachedResult = validateDatasetOriginLabels(cached, {
        originLen,
        requireMatchingPeriod: true,
      });
      if (!requestIsCurrent()) return [];
      if (cachedResult.ok) {
        state.headerLabels = cachedResult.labels;
        lastHeaderKey = key;
        return state.headerLabels;
      }
    }

    // Send request + wait (like VBA GetDataset)
    setStatus(forceRefresh ? "Refreshing year labels (cache cleared)..." : "Refreshing year labels...");
    let lastError = null;
    for (let i = 0; i < 2; i++) {
      try {
        const labels = await fetchHeadersViaGetDataset(p, originLen, 6.0, 0, false);
        if (!requestIsCurrent()) return [];
        state.headerLabels = labels;
        saveHeadersCache(p, originLen, labels);
        lastHeaderKey = key;
        return state.headerLabels;
      } catch (err) {
        if (!requestIsCurrent()) return [];
        lastError = err;
      }
    }
    if (!requestIsCurrent()) return [];
    state.headerLabels = [];
    lastHeaderKey = "";
    if (options?.throwOnError) throw (lastError || new Error(`Cannot load origin labels for project '${p}'.`));
    return [];
  }

  async function ensureDevHeadersForProject(project, options = {}) {
    const requestSequence = ++devHeaderRequestSequence;
    const requestIsCurrent = () => requestSequence === devHeaderRequestSequence
      && (typeof options?.isCurrent !== "function" || options.isCurrent());
    const p = String(project || "").trim();
    if (!p) {
      if (requestIsCurrent()) {
        state.devHeaderLabels = [];
        lastDevHeaderKey = "";
      }
      return [];
    }
    const forceRefresh = !!options?.forceRefresh;
    const originLen = getCurrentOriginLength();
    const devLen = getCurrentDevLength();
    const calendar = getCurrentCalendarMode();
    const key = `${p}||${originLen}||${devLen}||${calendar}`;
    if (!requestIsCurrent()) return [];
    if (forceRefresh || key !== lastDevHeaderKey) {
      state.devHeaderLabels = [];
      lastDevHeaderKey = "";
    }
    if (!forceRefresh && key === lastDevHeaderKey && Array.isArray(state.devHeaderLabels) && state.devHeaderLabels.length) {
      return state.devHeaderLabels;
    }

    if (!forceRefresh) {
      // Try cache first
      const cached = loadDevHeadersCache(p, originLen, devLen, calendar);
      if (!requestIsCurrent()) return [];
      if (Array.isArray(cached) && cached.length) {
        state.devHeaderLabels = cached;
        lastDevHeaderKey = key;
        return state.devHeaderLabels;
      }
    }

    // periodType=1, Transposed=true (csv is still one line)
    setStatus(forceRefresh ? "Refreshing column labels (cache cleared)..." : "Refreshing column labels...");
    for (let i = 0; i < 2; i++) {
      try {
        // periodType=1, Transposed=true (csv is still one line)
        // For dev headers, PeriodLength follows the UI "Development Length" selector.
        const labels = await fetchHeadersViaGetDataset(p, devLen, 6.0, 1, true, calendar);
        if (!requestIsCurrent()) return [];
        if (Array.isArray(labels)) {
          state.devHeaderLabels = labels;
          saveDevHeadersCache(p, originLen, devLen, calendar, labels);
          lastDevHeaderKey = key;
          return state.devHeaderLabels;
        }
      } catch {
        if (!requestIsCurrent()) return [];
        // ignore
      }
    }
    if (!requestIsCurrent()) return [];
    state.devHeaderLabels = [];
    lastDevHeaderKey = "";
    return [];
  }

  return {
    getCurrentOriginLength,
    getCurrentDevLength,
    clearHeadersCacheForProject,
    ensureHeadersForProject,
    ensureDevHeadersForProject,
  };
}
