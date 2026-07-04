import { state } from "/ui/shared/state.js";

export function createDatasetDependencyGuard(deps) {
  const {
    state: appState = {},
    normalizeProjectText,
    getResolvedProjectValue,
    getTriInputs,
    precheckArcRhoTriCsv,
    precheckArcRhoVecCsv,
    setInputInvalid,
    clearInputInvalid,
    setStatus,
  } = deps;

  const dependencyModelCache = new Map();
  const dependencyModelInFlight = new Map();
  let lastDatasetDependencyAlertSig = "";

  function parseCalculatedFlag(rawValue) {
    if (typeof rawValue === "boolean") return rawValue;
    if (typeof rawValue === "number") return rawValue !== 0;
    const text = String(rawValue || "").trim().toLowerCase();
    return text === "true" || text === "1" || text === "yes" || text === "y";
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseDatasetTypeRows(payload) {
    const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    const columns = Array.isArray(payload?.data?.columns) ? payload.data.columns : [];
    const sourceColIdx = columns.findIndex((col) => normalizeProjectText(col) === "source");
    const out = [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        const name = String(row[0] ?? "").trim();
        if (!name) continue;
        out.push({
          name,
          dataFormat: String(row[1] ?? "").trim(),
          calculated: parseCalculatedFlag(row[3]),
          formula: String(row[4] ?? "").trim(),
          source: String(
            sourceColIdx >= 0
              ? (row[sourceColIdx] ?? "")
              : (row[5] ?? ""),
          ).trim(),
        });
        continue;
      }
      if (row && typeof row === "object") {
        const name = String(row.Name ?? row.name ?? "").trim();
        if (!name) continue;
        out.push({
          name,
          dataFormat: String(row["Data Format"] ?? row.dataFormat ?? row.data_format ?? "").trim(),
          calculated: parseCalculatedFlag(row.Calculated ?? row.calculated),
          formula: String(row.Formula ?? row.formula ?? "").trim(),
          source: String(row.Source ?? row.source ?? "").trim(),
        });
      }
    }
    return out;
  }

  function parseDatasetTypeSourceMap(payload) {
    const byKey = new Map();
    const push = (name, source) => {
      const datasetName = String(name || "").trim();
      if (!datasetName) return;
      const key = normalizeProjectText(datasetName);
      if (!key) return;
      byKey.set(key, String(source || "").trim());
    };

    const explicit = payload?.data?.source_by_name;
    if (explicit && typeof explicit === "object") {
      for (const [name, source] of Object.entries(explicit)) {
        push(name, source);
      }
    }

    const columns = Array.isArray(payload?.data?.columns) ? payload.data.columns : [];
    const sourceColIdx = columns.findIndex((col) => normalizeProjectText(col) === "source");
    const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    for (const row of rows) {
      if (Array.isArray(row)) {
        const name = String(row[0] ?? "").trim();
        const source = String(
          sourceColIdx >= 0
            ? (row[sourceColIdx] ?? "")
            : (row[5] ?? ""),
        ).trim();
        push(name, source);
        continue;
      }
      if (row && typeof row === "object") {
        push(row.Name ?? row.name, row.Source ?? row.source);
      }
    }

    return byKey;
  }

  function parseDirectDatasetTypeKeysFromFieldMapping(payload) {
    const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    const keys = new Set();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const significance = String(row.significance ?? "").trim().toLowerCase();
      if (significance && significance !== "dataset") continue;
      const datasetType = String(row.dataset_type ?? row.datasetType ?? "").trim();
      if (!datasetType) continue;
      const key = normalizeProjectText(datasetType);
      if (!key) continue;
      keys.add(key);
    }
    return keys;
  }

  function extractFormulaDatasetTypeComponents(formula, knownNames) {
    const text = String(formula || "").trim();
    if (!text) return [];

    const quoted = [];
    const quotedSeen = new Set();
    const quotedRe = /"([^"]+)"/g;
    let mQuoted;
    while ((mQuoted = quotedRe.exec(text)) !== null) {
      const token = String(mQuoted[1] || "").trim();
      if (!token) continue;
      const key = normalizeProjectText(token);
      if (!key || quotedSeen.has(key)) continue;
      quotedSeen.add(key);
      quoted.push(token);
    }
    if (quoted.length) return quoted;

    const uniqueKnownNames = Array.from(
      new Set((Array.isArray(knownNames) ? knownNames : []).map((name) => String(name || "").trim()).filter(Boolean)),
    ).sort((a, b) => b.length - a.length);
    if (!uniqueKnownNames.length) return [];

    const matches = [];
    for (const name of uniqueKnownNames) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(name)})(?=$|[^A-Za-z0-9_])`, "gi");
      let m;
      while ((m = re.exec(text)) !== null) {
        const prefixLen = String(m[1] || "").length;
        const token = String(m[2] || "").trim();
        const start = m.index + prefixLen;
        const end = start + token.length;
        if (token) matches.push({ start, end, token });
        if (re.lastIndex === m.index) re.lastIndex += 1;
      }
    }

    matches.sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
    const used = [];
    const out = [];
    const seen = new Set();
    for (const hit of matches) {
      const overlaps = used.some((u) => hit.start < u.end && hit.end > u.start);
      if (overlaps) continue;
      used.push({ start: hit.start, end: hit.end });
      const key = normalizeProjectText(hit.token);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(hit.token);
    }
    return out;
  }

  async function loadDatasetTypeDependencyModel(projectName, options = {}) {
    const project = String(projectName || "").trim();
    if (!project) return { available: false };

    const cacheKey = normalizeProjectText(project);
    const forceReload = !!options?.forceReload;
    if (!forceReload && dependencyModelCache.has(cacheKey)) {
      return dependencyModelCache.get(cacheKey);
    }
    if (!forceReload && dependencyModelInFlight.has(cacheKey)) {
      return dependencyModelInFlight.get(cacheKey);
    }

    const loadPromise = (async () => {
      try {
        const [datasetResp, mappingResp] = await Promise.all([
          fetch(`/dataset_types?project_name=${encodeURIComponent(project)}`),
          fetch(`/field_mapping?project_name=${encodeURIComponent(project)}`),
        ]);
        if (!datasetResp.ok) {
          const model = { available: false };
          dependencyModelCache.set(cacheKey, model);
          return model;
        }
        const datasetPayload = await datasetResp.json().catch(() => ({}));
        const mappingPayload = mappingResp.ok ? await mappingResp.json().catch(() => ({})) : {};

        const rows = parseDatasetTypeRows(datasetPayload);
        const sourceByKey = parseDatasetTypeSourceMap(datasetPayload);
        const formulaByKey = new Map();
        const dataFormatByKey = new Map();
        const byKey = new Map();
        const knownNames = [];
        for (const row of rows) {
          const key = normalizeProjectText(row.name);
          if (!key) continue;
          if (!byKey.has(key)) knownNames.push(row.name);
          formulaByKey.set(key, String(row.formula || "").trim());
          dataFormatByKey.set(key, String(row.dataFormat || "").trim());
          byKey.set(key, {
            name: row.name,
            dataFormat: row.dataFormat || "",
            calculated: !!row.calculated,
            formula: row.formula || "",
            source: String(sourceByKey.get(key) || row.source || "").trim(),
          });
        }

        const directKeys = parseDirectDatasetTypeKeysFromFieldMapping(mappingPayload);
        const model = {
          available: true,
          byKey,
          knownNames,
          directKeys,
          sourceByKey,
          formulaByKey,
          dataFormatByKey,
        };
        appState.datasetTypeSourceByKey = sourceByKey instanceof Map ? new Map(sourceByKey) : new Map();
        appState.datasetTypeFormulaByKey = formulaByKey instanceof Map ? new Map(formulaByKey) : new Map();
        appState.datasetTypeDataFormatByKey = dataFormatByKey instanceof Map ? new Map(dataFormatByKey) : new Map();
        dependencyModelCache.set(cacheKey, model);
        return model;
      } catch {
        const model = { available: false };
        appState.datasetTypeSourceByKey = new Map();
        appState.datasetTypeFormulaByKey = new Map();
        appState.datasetTypeDataFormatByKey = new Map();
        dependencyModelCache.set(cacheKey, model);
        return model;
      }
    })();

    dependencyModelInFlight.set(cacheKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (dependencyModelInFlight.get(cacheKey) === loadPromise) {
        dependencyModelInFlight.delete(cacheKey);
      }
    }
  }

  function evaluateDatasetTypeDependencyReadiness(model, datasetType) {
    const targetKey = normalizeProjectText(datasetType);
    if (!targetKey || !(model?.byKey instanceof Map)) {
      return { ok: false, missing: [String(datasetType || "").trim()].filter(Boolean) };
    }

    const memo = new Map();
    const resolving = new Set();
    const resolveMissing = (datasetKey) => {
      if (!datasetKey) return new Set();
      if (memo.has(datasetKey)) return new Set(memo.get(datasetKey) || []);
      if (resolving.has(datasetKey)) {
        const cyc = model.byKey.get(datasetKey)?.name || datasetKey;
        return new Set([cyc]);
      }

      resolving.add(datasetKey);
      let missing = new Set();

      if (model.directKeys instanceof Set && model.directKeys.has(datasetKey)) {
        missing = new Set();
      } else {
        const row = model.byKey.get(datasetKey);
        if (!row) {
          missing = new Set([datasetKey]);
        } else if (!row.calculated || !String(row.formula || "").trim()) {
          missing = new Set([row.name || datasetKey]);
        } else {
          const components = extractFormulaDatasetTypeComponents(row.formula, model.knownNames || []);
          for (const comp of components) {
            const compKey = normalizeProjectText(comp);
            if (!compKey || !model.byKey.has(compKey)) {
              missing.add(String(comp || "").trim() || compKey || "");
              continue;
            }
            const depMissing = resolveMissing(compKey);
            depMissing.forEach((item) => missing.add(item));
          }
        }
      }

      resolving.delete(datasetKey);
      const cleaned = new Set(Array.from(missing).map((v) => String(v || "").trim()).filter(Boolean));
      memo.set(datasetKey, cleaned);
      return new Set(cleaned);
    };

    const missing = Array.from(resolveMissing(targetKey));
    missing.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
    return { ok: missing.length === 0, missing };
  }

  async function validateDatasetTypeDependencies(datasetType, options = {}) {
    const showMessage = !!options?.showMessage;
    const checkExistingCsvFallback = options?.checkExistingCsvFallback !== false;
    const input = document.getElementById("triInput");
    const project = getResolvedProjectValue();
    const datasetName = String(datasetType || "").trim();
    if (!project || !datasetName) return { ok: true };

    const model = await loadDatasetTypeDependencyModel(project, options);
    if (!model?.available) return { ok: true };

    const evalResult = evaluateDatasetTypeDependencyReadiness(model, datasetName);
    if (evalResult.ok) {
      if (input) clearInputInvalid(input);
      lastDatasetDependencyAlertSig = "";
      return { ok: true };
    }

    if (checkExistingCsvFallback) {
      const triInputsRaw = options?.precheckInputs && typeof options.precheckInputs === "object"
        ? options.precheckInputs
        : getTriInputs();
      const targetKey = normalizeProjectText(datasetName);
      const targetRow = model.byKey instanceof Map ? model.byKey.get(targetKey) : null;
      const dataFormat = String(targetRow?.dataFormat || "").trim().toLowerCase();
      const precheckExistingCsv = dataFormat === "vector" && typeof precheckArcRhoVecCsv === "function"
        ? precheckArcRhoVecCsv
        : precheckArcRhoTriCsv;
      const precheckResult = await precheckExistingCsv({
        ...(triInputsRaw || {}),
        project: triInputsRaw?.project || project,
        tri: triInputsRaw?.tri || datasetName,
      });
      if (precheckResult.hasExistingCsv) {
        if (input) clearInputInvalid(input);
        lastDatasetDependencyAlertSig = "";
        return {
          ok: true,
          bypassedByExistingCsv: true,
          dataPath: String(precheckResult?.data?.data_path || ""),
        };
      }
    }

    const msg = `Dataset Type "${datasetName}" cannot be generated because dependencies are missing: ${evalResult.missing.join(", ")}.`;
    if (input) setInputInvalid(input, msg);
    setStatus(`Dataset Type "${datasetName}" cannot be generated due to missing dependencies.`);

    if (showMessage) {
      const sig = `${normalizeProjectText(project)}::${normalizeProjectText(datasetName)}::${evalResult.missing.map((m) => normalizeProjectText(m)).join("|")}`;
      if (sig !== lastDatasetDependencyAlertSig) {
        lastDatasetDependencyAlertSig = sig;
        try { alert(msg); } catch {}
      }
      try { input?.reportValidity(); } catch {}
    }

    return { ok: false, missing: evalResult.missing };
  }

  function clearProjectCache(projectName) {
    const key = normalizeProjectText(projectName);
    if (!key) return;
    dependencyModelCache.delete(key);
    dependencyModelInFlight.delete(key);
  }

  return {
    clearProjectCache,
    loadDatasetTypeDependencyModel,
    validateDatasetTypeDependencies,
  };
}
