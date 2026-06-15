export const MODEL_OPTIONS = [
  { value: "codex", label: "Codex default", provider: "openai", supportsReasoning: true },
  { value: "gpt-5.5", label: "GPT-5.5", provider: "openai", supportsReasoning: true },
  { value: "gpt-5.4", label: "GPT-5.4", provider: "openai", supportsReasoning: true },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", provider: "openai", supportsReasoning: false },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic", supportsReasoning: true },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", supportsReasoning: true },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", supportsReasoning: false },
];

export const REASONING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

export function normalizeAssistantModel(model) {
  const value = String(model || "codex").trim().toLowerCase();
  return MODEL_OPTIONS.some((option) => option.value === value) ? value : "codex";
}

export function normalizeAssistantReasoningEffort(effort) {
  const value = String(effort || "high").trim().toLowerCase();
  return REASONING_OPTIONS.some((option) => option.value === value) ? value : "high";
}

export function getAssistantModelLabelFor(model) {
  return MODEL_OPTIONS.find((option) => option.value === normalizeAssistantModel(model))?.label || "Codex default";
}

export function getAssistantReasoningLabelFor(effort) {
  return REASONING_OPTIONS.find((option) => option.value === normalizeAssistantReasoningEffort(effort))?.label || "High";
}

export function isClaudeAssistantModel(model) {
  return MODEL_OPTIONS.find((option) => option.value === normalizeAssistantModel(model))?.provider === "anthropic";
}

export function assistantModelSupportsReasoning(model) {
  return !!MODEL_OPTIONS.find((option) => option.value === normalizeAssistantModel(model))?.supportsReasoning;
}

export function shouldShowTokenAlertFor(model, reasoningEffort) {
  const normalizedModel = normalizeAssistantModel(model);
  const normalizedEffort = normalizeAssistantReasoningEffort(reasoningEffort);
  if (normalizedModel === "gpt-5.5" || normalizedModel === "claude-opus-4-8") return true;
  return assistantModelSupportsReasoning(normalizedModel) && (normalizedEffort === "high" || normalizedEffort === "xhigh");
}
