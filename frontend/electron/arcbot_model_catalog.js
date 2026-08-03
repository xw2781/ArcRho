"use strict";

const ARCBOT_RUNTIME_CONTRACT = require("./arcbot_runtime_contract.json");

const DEFAULT_CODEX_MODEL_ID = ARCBOT_RUNTIME_CONTRACT.minimumDefaultModel;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

function normalizeModelId(model, fallback = "codex") {
  const value = String(model || "").trim().toLowerCase();
  return MODEL_ID_PATTERN.test(value) ? value : fallback;
}

function normalizeReasoningEffort(effort, fallback = "high") {
  const value = String(effort || "").trim().toLowerCase();
  return REASONING_EFFORTS.has(value) ? value : fallback;
}

function formatReasoningLabel(value) {
  const labels = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
    ultra: "Ultra",
  };
  return labels[value] || value;
}

function normalizeReasoningOptions(options) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(options) ? options : []) {
    const value = normalizeReasoningEffort(entry?.reasoningEffort || entry?.value, "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push({
      value,
      label: formatReasoningLabel(value),
      description: String(entry?.description || "").trim(),
    });
  }
  return normalized;
}

function normalizeCodexModelEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.hidden === true) return null;
  const value = normalizeModelId(entry.model || entry.id, "");
  if (!value || value.startsWith("claude-")) return null;
  const supportedReasoningEfforts = normalizeReasoningOptions(entry.supportedReasoningEfforts);
  const requestedDefaultEffort = normalizeReasoningEffort(entry.defaultReasoningEffort, "");
  const defaultReasoningEffort = supportedReasoningEfforts.some((option) => option.value === requestedDefaultEffort)
    ? requestedDefaultEffort
    : supportedReasoningEfforts[0]?.value || "";
  return {
    value,
    label: String(entry.displayName || entry.label || entry.model || entry.id || value).trim() || value,
    description: String(entry.description || "").trim(),
    provider: "openai",
    supportsReasoning: supportedReasoningEfforts.length > 0,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: entry.isDefault === true,
  };
}

function compareGptModelVersion(model, baseline) {
  const readVersion = (value) => {
    const match = String(value || "").match(/^gpt-(\d+)(?:\.(\d+))?/u);
    return match ? [Number(match[1]), Number(match[2] || 0)] : null;
  };
  const candidate = readVersion(model);
  const expected = readVersion(baseline);
  if (!candidate || !expected) return null;
  if (candidate[0] !== expected[0]) return candidate[0] > expected[0] ? 1 : -1;
  if (candidate[1] !== expected[1]) return candidate[1] > expected[1] ? 1 : -1;
  return 0;
}

function buildCodexModelCatalog(entries) {
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeCodexModelEntry(entry);
    if (!normalized || seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    models.push(normalized);
  }
  if (!models.length) {
    return getFallbackCodexModelCatalog();
  }
  const detectedDefault = models.find((model) => model.isDefault) || models[0];
  const detectedDefaultVersion = compareGptModelVersion(detectedDefault?.value, DEFAULT_CODEX_MODEL_ID);
  const advertisedMinimum = models.find((model) => model.value === DEFAULT_CODEX_MODEL_ID)
    || models.find((model) => {
      const version = compareGptModelVersion(model.value, DEFAULT_CODEX_MODEL_ID);
      return version === 0;
    });
  const selectedDefault = detectedDefaultVersion === 0 || detectedDefaultVersion === 1
    ? detectedDefault
    : advertisedMinimum || detectedDefault;
  const defaultModel = selectedDefault.value;
  const defaultVersion = compareGptModelVersion(defaultModel, DEFAULT_CODEX_MODEL_ID);
  const meetsMinimum = defaultVersion === 0 || defaultVersion === 1;
  for (const model of models) model.isDefault = model.value === defaultModel;
  return {
    models,
    defaultModel,
    minimumDefaultModel: DEFAULT_CODEX_MODEL_ID,
    meetsMinimum,
    upgradeRequired: !meetsMinimum,
    verified: true,
    source: "codex-app-server",
  };
}

function getFallbackCodexModelCatalog() {
  return {
    models: [],
    defaultModel: "codex",
    minimumDefaultModel: DEFAULT_CODEX_MODEL_ID,
    meetsMinimum: false,
    upgradeRequired: false,
    verified: false,
    source: "fallback",
  };
}

module.exports = {
  DEFAULT_CODEX_MODEL_ID,
  MODEL_ID_PATTERN,
  buildCodexModelCatalog,
  compareGptModelVersion,
  getFallbackCodexModelCatalog,
  normalizeCodexModelEntry,
  normalizeModelId,
  normalizeReasoningEffort,
};
