// Normalizes downstream refresh failures returned by dataset-save propagation.

const METHOD_REPORTS = [
  ["DFM", "dfm_updates"],
  ["Result Selection", "result_selection_updates"],
  ["Bornhuetter Ferguson", "bornhuetter_ferguson_updates"],
  ["Cape Cod", "cape_cod_updates"],
];

function cleanText(value) {
  return String(value ?? "").trim();
}

function uniqueTexts(values) {
  const seen = new Set();
  return values.map(cleanText).filter((value) => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isFailedStep(step) {
  const status = cleanText(step?.status).toLowerCase();
  return step?.ok === false
    || step?.skipped === true
    || ["error", "failed", "skipped"].includes(status);
}

function failureFromEntry(entry, scope = "Downstream") {
  if (typeof entry === "string") {
    return { scope, datasetName: "", reason: cleanText(entry), errors: [] };
  }
  const item = entry && typeof entry === "object" ? entry : {};
  return {
    scope,
    datasetName: cleanText(
      item.dataset_name
      || item.dataset_type_name
      || item.dataset_type
      || item.instance_name
      || item.name,
    ),
    reason: cleanText(item.reason || item.error || item.detail || item.message),
    errors: uniqueTexts(Array.isArray(item.errors) ? item.errors : []),
  };
}

export function collectDatasetPropagationFailures(report) {
  if (!report || typeof report !== "object") return [];
  const failures = [];
  const seenFailures = new Set();
  const visitedReports = new Set();

  const addFailure = (entry, scope) => {
    const failure = failureFromEntry(entry, scope);
    if (!failure.reason && !failure.errors.length) return;
    const key = [
      failure.scope,
      failure.datasetName,
      failure.reason,
      ...failure.errors,
    ].map((value) => cleanText(value).toLowerCase()).join("\u001f");
    if (seenFailures.has(key)) return;
    seenFailures.add(key);
    failures.push(failure);
  };

  const visit = (payload, scope = "Downstream") => {
    if (!payload || typeof payload !== "object" || visitedReports.has(payload)) return;
    visitedReports.add(payload);

    if (payload.ok === false && cleanText(payload.reason)) addFailure(payload, scope);
    for (const error of Array.isArray(payload.errors) ? payload.errors : []) {
      addFailure(error, scope);
      if (error && typeof error === "object" && error.cascade) {
        visit(error.cascade, `${scope} downstream`);
      }
    }
    for (const step of Array.isArray(payload.steps) ? payload.steps : []) {
      if (isFailedStep(step)) addFailure(step, scope === "Downstream" ? "Calculated dataset" : scope);
    }
    for (const chain of Array.isArray(payload.chains) ? payload.chains : []) {
      visit(chain, scope === "Downstream" ? "Calculated dataset" : scope);
    }
    if (payload.ok === false) {
      for (const skipped of Array.isArray(payload.skipped) ? payload.skipped : []) {
        const item = skipped && typeof skipped === "object"
          ? { ...skipped, skipped: true }
          : skipped;
        addFailure(item, scope === "Downstream" ? "Calculated dataset" : scope);
      }
    }
    for (const [methodScope, key] of METHOD_REPORTS) {
      if (payload[key] && typeof payload[key] === "object") visit(payload[key], methodScope);
    }
  };

  visit(report);
  if (!failures.length && report.ok === false) {
    failures.push({
      scope: "Downstream",
      datasetName: "",
      reason: "The server did not return a specific refresh error.",
      errors: [],
    });
  }
  return failures;
}

export function datasetPropagationFailureStep(failure) {
  const scope = cleanText(failure?.scope) || "Downstream";
  const datasetName = cleanText(failure?.datasetName);
  const displayName = scope === "Calculated dataset" && datasetName
    ? datasetName
    : (datasetName ? `${scope}: ${datasetName}` : `${scope} refresh`);
  return {
    ok: false,
    skipped: true,
    status: "failed",
    dataset_type_name: displayName,
    reason: cleanText(failure?.reason) || "refresh_failed",
    errors: uniqueTexts(failure?.errors || []),
  };
}

export function buildDatasetSaveStatus(payload = {}) {
  const report = payload?.calculated_updates;
  if (payload?.propagation_ok !== false && report?.ok !== false) {
    return { text: "Dataset settings saved.", tone: "" };
  }
  const failures = collectDatasetPropagationFailures(report);
  const details = failures.map((failure) => {
    const label = [failure.scope, failure.datasetName].map(cleanText).filter(Boolean).join(" ");
    const reasons = uniqueTexts([failure.reason, ...(failure.errors || [])]);
    return `${label || "Downstream refresh"}: ${reasons.join("; ") || "refresh failed"}`;
  });
  return {
    text: details.length
      ? `Dataset saved, but downstream refresh failed: ${details.join(" | ")}`
      : "Dataset saved, but downstream refresh failed.",
    tone: "warn",
  };
}
