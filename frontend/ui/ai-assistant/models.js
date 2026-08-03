const LEGACY_CODEX_MODEL = "codex";

const LEGACY_CODEX_OPTION_BASE = Object.freeze({
  value: LEGACY_CODEX_MODEL,
  label: "Codex default",
  provider: "openai",
  supportsReasoning: true,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "",
  isDefault: false,
  available: true,
  legacy: true,
});

export const CLAUDE_MODEL_OPTIONS = Object.freeze([
  Object.freeze({
    value: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
    defaultReasoningEffort: "high",
    isDefault: false,
    available: true,
    highTokenUse: true,
  }),
  Object.freeze({
    value: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
    defaultReasoningEffort: "high",
    isDefault: false,
    available: true,
  }),
  Object.freeze({
    value: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    supportsReasoning: false,
    supportedReasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: "",
    isDefault: false,
    available: true,
  }),
]);

export const REASONING_OPTIONS = Object.freeze([
  Object.freeze({ value: "none", label: "None" }),
  Object.freeze({ value: "minimal", label: "Minimal" }),
  Object.freeze({ value: "low", label: "Low" }),
  Object.freeze({ value: "medium", label: "Medium" }),
  Object.freeze({ value: "high", label: "High" }),
  Object.freeze({ value: "xhigh", label: "Extra high" }),
  Object.freeze({ value: "max", label: "Max" }),
  Object.freeze({ value: "ultra", label: "Ultra" }),
]);

const REASONING_VALUES = new Set(REASONING_OPTIONS.map((option) => option.value));
const SAFE_MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
let discoveredOpenAiOptions = [];
let defaultAssistantModel = LEGACY_CODEX_MODEL;

// Keep this live export for existing consumers while the OpenAI portion is populated at runtime.
export const MODEL_OPTIONS = [];

function cloneModelOption(option) {
  return {
    ...option,
    supportedReasoningEfforts: [...(option.supportedReasoningEfforts || [])],
  };
}

function modelKey(value) {
  return String(value || "").trim().toLowerCase();
}

function createLegacyCodexOption() {
  const runtimeDefault = discoveredOpenAiOptions.find((option) => (
    modelKey(option.value) === modelKey(defaultAssistantModel)
  ));
  if (!runtimeDefault) return { ...LEGACY_CODEX_OPTION_BASE };
  return {
    ...LEGACY_CODEX_OPTION_BASE,
    supportsReasoning: runtimeDefault.supportsReasoning,
    supportedReasoningEfforts: [...runtimeDefault.supportedReasoningEfforts],
    defaultReasoningEffort: runtimeDefault.defaultReasoningEffort,
  };
}

function refreshLiveModelOptions() {
  MODEL_OPTIONS.splice(
    0,
    MODEL_OPTIONS.length,
    ...discoveredOpenAiOptions.map(cloneModelOption),
    cloneModelOption(createLegacyCodexOption()),
    ...CLAUDE_MODEL_OPTIONS.map(cloneModelOption),
  );
}

function normalizeReasoningValue(value, fallback = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return REASONING_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeSupportedReasoningEfforts(entry) {
  const raw = entry?.supportedReasoningEfforts ?? entry?.reasoningEfforts;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const efforts = [];
  for (const item of raw) {
    const value = normalizeReasoningValue(
      typeof item === "string"
        ? item
        : item?.reasoningEffort ?? item?.value ?? item?.id,
    );
    if (!value || seen.has(value)) continue;
    seen.add(value);
    efforts.push(value);
  }
  return efforts;
}

function readCatalogPayload(catalogLike) {
  if (Array.isArray(catalogLike)) return { entries: catalogLike, defaultModel: "" };
  if (!catalogLike || typeof catalogLike !== "object") return null;

  const nested = catalogLike.catalog && typeof catalogLike.catalog === "object"
    && !Array.isArray(catalogLike.catalog)
    ? catalogLike.catalog
    : null;
  const entries = [
    catalogLike.models,
    catalogLike.data,
    Array.isArray(catalogLike.catalog) ? catalogLike.catalog : null,
    catalogLike.options,
    nested?.models,
    nested?.data,
    nested?.options,
  ].find(Array.isArray);
  if (!entries) return null;
  return {
    entries,
    defaultModel: String(catalogLike.defaultModel ?? nested?.defaultModel ?? "").trim(),
  };
}

function normalizeCatalogEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.hidden === true) return null;
  const value = String(entry.value ?? entry.model ?? entry.id ?? "").trim();
  if (!isSafeAssistantModelSlug(value)) return null;
  const key = modelKey(value);
  if (key === LEGACY_CODEX_MODEL || key.startsWith("claude-")) return null;

  const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(entry);
  const defaultReasoningEffort = normalizeReasoningValue(
    entry.defaultReasoningEffort ?? entry.defaultEffort,
  );
  const supportsReasoning = typeof entry.supportsReasoning === "boolean"
    ? entry.supportsReasoning
    : supportedReasoningEfforts.length > 0 || !!defaultReasoningEffort;
  const displayLabel = String(
    entry.label ?? entry.displayLabel ?? entry.displayName ?? entry.name ?? value,
  ).trim() || value;
  const available = entry.available !== false;

  return {
    value,
    label: available ? displayLabel : `${displayLabel} (unavailable)`,
    provider: "openai",
    supportsReasoning,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: entry.isDefault === true || entry.defaultModel === true,
    available,
    ...(available ? {} : { unavailable: true }),
    ...(entry.highTokenUse === true ? { highTokenUse: true } : {}),
  };
}

function findModelOption(model) {
  const key = modelKey(model);
  return MODEL_OPTIONS.find((option) => modelKey(option.value) === key) || null;
}

function createUnavailableModelOption(value) {
  return {
    value,
    label: `${value} (unavailable)`,
    provider: modelKey(value).startsWith("claude-") ? "anthropic" : "openai",
    supportsReasoning: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "",
    isDefault: false,
    available: false,
    unavailable: true,
  };
}

refreshLiveModelOptions();

export function isSafeAssistantModelSlug(model) {
  return SAFE_MODEL_SLUG.test(String(model || "").trim());
}

export function applyAssistantModelCatalog(catalogLike) {
  const payload = readCatalogPayload(catalogLike);
  if (!payload) return getAssistantModelOptions();

  const seen = new Set([LEGACY_CODEX_MODEL, ...CLAUDE_MODEL_OPTIONS.map((option) => modelKey(option.value))]);
  const nextOptions = [];
  for (const entry of payload.entries) {
    const option = normalizeCatalogEntry(entry);
    const key = modelKey(option?.value);
    if (!option || seen.has(key)) continue;
    seen.add(key);
    nextOptions.push(option);
  }

  discoveredOpenAiOptions = nextOptions;
  const explicitDefaultKey = modelKey(payload.defaultModel);
  const explicitDefault = nextOptions.find((option) => (
    option.available && modelKey(option.value) === explicitDefaultKey
  ));
  const markedDefault = nextOptions.find((option) => option.available && option.isDefault);
  defaultAssistantModel = (explicitDefault || markedDefault)?.value || LEGACY_CODEX_MODEL;
  refreshLiveModelOptions();
  return getAssistantModelOptions();
}

export function getAssistantModelOptions(selectedModel = "") {
  const options = MODEL_OPTIONS.map(cloneModelOption);
  const selectedValue = typeof selectedModel === "object" && selectedModel !== null
    ? String(selectedModel.selectedModel ?? selectedModel.model ?? "").trim()
    : String(selectedModel || "").trim();
  if (
    selectedValue
    && isSafeAssistantModelSlug(selectedValue)
    && !options.some((option) => modelKey(option.value) === modelKey(selectedValue))
  ) {
    options.push(createUnavailableModelOption(selectedValue));
  }
  return options;
}

export function getDefaultAssistantModel() {
  return defaultAssistantModel;
}

export function normalizeAssistantModel(model) {
  const value = String(model || "").trim();
  if (!value || !isSafeAssistantModelSlug(value)) return getDefaultAssistantModel();
  return findModelOption(value)?.value || value;
}

export function normalizeAssistantReasoningEffort(effort) {
  return normalizeReasoningValue(effort, "high");
}

export function reconcileAssistantReasoningEffort(model, effort) {
  const normalizedEffort = normalizeAssistantReasoningEffort(effort);
  const option = findModelOption(normalizeAssistantModel(model));
  const supported = option?.supportedReasoningEfforts || [];
  if (!supported.length || supported.includes(normalizedEffort)) return normalizedEffort;
  if (option.defaultReasoningEffort && supported.includes(option.defaultReasoningEffort)) {
    return option.defaultReasoningEffort;
  }
  return supported[0];
}

export function getAssistantReasoningOptionsForModel(model) {
  const option = findModelOption(normalizeAssistantModel(model));
  if (!option?.supportsReasoning) return [];
  if (!option.supportedReasoningEfforts.length) {
    return REASONING_OPTIONS.map((reasoningOption) => ({ ...reasoningOption }));
  }
  const supported = new Set(option.supportedReasoningEfforts);
  return REASONING_OPTIONS
    .filter((reasoningOption) => supported.has(reasoningOption.value))
    .map((reasoningOption) => ({ ...reasoningOption }));
}

export function getAssistantModelLabelFor(model) {
  const normalized = normalizeAssistantModel(model);
  return findModelOption(normalized)?.label || createUnavailableModelOption(normalized).label;
}

export function getAssistantReasoningLabelFor(effort) {
  const normalized = normalizeAssistantReasoningEffort(effort);
  return REASONING_OPTIONS.find((option) => option.value === normalized)?.label || "High";
}

export function isClaudeAssistantModel(model) {
  return modelKey(normalizeAssistantModel(model)).startsWith("claude-");
}

export function assistantModelSupportsReasoning(model) {
  return !!findModelOption(normalizeAssistantModel(model))?.supportsReasoning;
}

export function shouldShowTokenAlertFor(model, reasoningEffort) {
  const option = findModelOption(normalizeAssistantModel(model));
  const normalizedEffort = normalizeAssistantReasoningEffort(reasoningEffort);
  if (option?.highTokenUse) return true;
  return !!option?.supportsReasoning && ["high", "xhigh", "max", "ultra"].includes(normalizedEffort);
}
