"use strict";

const ARCBOT_RUNTIME_CONTRACT = require("./arcbot_runtime_contract.json");

const DEFAULT_CODEX_MODEL_ID = ARCBOT_RUNTIME_CONTRACT.minimumDefaultModel;
const PREFERRED_CODEX_MODEL_ID = ARCBOT_RUNTIME_CONTRACT.defaultModel;
const DEFAULT_REASONING_EFFORT = ARCBOT_RUNTIME_CONTRACT.defaultReasoningEffort;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);
// Anthropic families ArcBot offers, in picker order; the newest model of each is shown.
const CLAUDE_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"];
const DEFAULT_CLAUDE_FAMILY = "sonnet";
const HIGH_TOKEN_CLAUDE_FAMILIES = new Set(["fable", "opus"]);
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Used when the Anthropic Models API cannot be reached with the signed-in Claude credentials.
const FALLBACK_CLAUDE_MODELS = Object.freeze([
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", supportedReasoningEfforts: CLAUDE_EFFORT_LEVELS },
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", supportedReasoningEfforts: CLAUDE_EFFORT_LEVELS },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", supportedReasoningEfforts: CLAUDE_EFFORT_LEVELS },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", supportedReasoningEfforts: [] },
]);

function normalizeModelId(model, fallback = "codex") {
  const value = String(model || "").trim().toLowerCase();
  return MODEL_ID_PATTERN.test(value) ? value : fallback;
}

function normalizeReasoningEffort(effort, fallback = DEFAULT_REASONING_EFFORT) {
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
  // The preferred model wins while advertised, unless Codex already defaults to a newer GPT version.
  const preferred = models.find((model) => model.value === PREFERRED_CODEX_MODEL_ID);
  const selectedDefault = preferred && compareGptModelVersion(detectedDefault.value, PREFERRED_CODEX_MODEL_ID) !== 1
    ? preferred
    : detectedDefaultVersion === 0 || detectedDefaultVersion === 1
      ? detectedDefault
      : advertisedMinimum || detectedDefault;
  const defaultModel = selectedDefault.value;
  const defaultVersion = compareGptModelVersion(defaultModel, DEFAULT_CODEX_MODEL_ID);
  const meetsMinimum = defaultVersion === 0 || defaultVersion === 1;
  for (const model of models) model.isDefault = model.value === defaultModel;
  return {
    models,
    defaultModel,
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
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
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    minimumDefaultModel: DEFAULT_CODEX_MODEL_ID,
    meetsMinimum: false,
    upgradeRequired: false,
    verified: false,
    source: "fallback",
  };
}

function readClaudeModelFamily(model) {
  const match = String(model || "").match(/^claude-([a-z]+)-/u);
  return match && CLAUDE_MODEL_FAMILIES.includes(match[1]) ? match[1] : "";
}

// Accepts an Anthropic Models API entry (`id`, `display_name`, `capabilities.effort`)
// or a fallback entry that lists its efforts directly.
function normalizeClaudeModelEntry(entry) {
  const value = normalizeModelId(entry?.id, "");
  const family = readClaudeModelFamily(value);
  if (!family) return null;
  const effortCapability = entry.capabilities?.effort;
  const efforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : CLAUDE_EFFORT_LEVELS.filter((level) => (
      effortCapability?.supported === true && effortCapability?.[level]?.supported === true
    ));
  const supportedReasoningEfforts = normalizeReasoningOptions(efforts.map((level) => ({ value: level })));
  const supported = supportedReasoningEfforts.map((option) => option.value);
  return {
    value,
    label: String(entry.display_name || value).trim() || value,
    provider: "anthropic",
    family,
    createdAt: String(entry.created_at || ""),
    supportsReasoning: supported.length > 0,
    supportedReasoningEfforts,
    defaultReasoningEffort: supported.includes(DEFAULT_REASONING_EFFORT) ? DEFAULT_REASONING_EFFORT : supported[0] || "",
    isDefault: false,
    ...(HIGH_TOKEN_CLAUDE_FAMILIES.has(family) ? { highTokenUse: true } : {}),
  };
}

// Keeps the newest model of each family, so a new Fable, Opus, Sonnet, or Haiku replaces its predecessor.
function buildClaudeModelCatalog(entries, source = "anthropic-models-api") {
  const newestByFamily = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = normalizeClaudeModelEntry(entry);
    if (!model) continue;
    const current = newestByFamily.get(model.family);
    if (!current || model.createdAt > current.createdAt) newestByFamily.set(model.family, model);
  }
  const models = CLAUDE_MODEL_FAMILIES
    .map((family) => newestByFamily.get(family))
    .filter(Boolean)
    .map(({ family, createdAt, ...model }) => ({ ...model, isDefault: family === DEFAULT_CLAUDE_FAMILY }));
  if (!models.length && source !== "fallback") return getFallbackClaudeModelCatalog();
  return {
    models,
    defaultModel: models.find((model) => model.isDefault)?.value || models[0]?.value || "",
    verified: source !== "fallback",
    source,
  };
}

function getFallbackClaudeModelCatalog() {
  return buildClaudeModelCatalog(FALLBACK_CLAUDE_MODELS, "fallback");
}

module.exports = {
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_REASONING_EFFORT,
  MODEL_ID_PATTERN,
  PREFERRED_CODEX_MODEL_ID,
  buildClaudeModelCatalog,
  buildCodexModelCatalog,
  compareGptModelVersion,
  getFallbackClaudeModelCatalog,
  getFallbackCodexModelCatalog,
  normalizeCodexModelEntry,
  normalizeModelId,
  normalizeReasoningEffort,
};
