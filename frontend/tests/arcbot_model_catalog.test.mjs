import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import {
  CLAUDE_MODEL_OPTIONS,
  MODEL_OPTIONS,
  applyAssistantModelCatalog,
  assistantModelSupportsReasoning,
  getAssistantModelLabelFor,
  getAssistantModelOptions,
  getAssistantReasoningOptionsForModel,
  getDefaultAssistantModel,
  getDefaultAssistantReasoningEffort,
  isClaudeAssistantModel,
  normalizeAssistantModel,
  normalizeAssistantReasoningEffort,
  reconcileAssistantReasoningEffort,
  shouldShowTokenAlertFor,
} from "../ui/ai-assistant/models.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const {
  buildClaudeModelCatalog,
  buildCodexModelCatalog,
  getFallbackClaudeModelCatalog,
} = require("../electron/arcbot_model_catalog.js");

function resetCatalog() {
  applyAssistantModelCatalog([]);
}

test("ArcBot starts with only the legacy Codex sentinel until the host catalog arrives", () => {
  resetCatalog();

  const options = getAssistantModelOptions();
  assert.deepEqual(
    options.filter((option) => option.provider === "openai").map((option) => option.value),
    ["codex"],
  );
  assert.equal(getDefaultAssistantModel(), "codex");
  assert.equal(normalizeAssistantReasoningEffort(""), "medium");
});

test("the host offers the current Claude models, with Sonnet as the Claude default", () => {
  const fallback = getFallbackClaudeModelCatalog();
  assert.equal(fallback.verified, false);
  assert.equal(fallback.defaultModel, "claude-sonnet-5-5");
  assert.deepEqual(
    fallback.models.map((model) => [model.value, model.label, model.defaultReasoningEffort]),
    [
      ["claude-fable-5-1", "Claude Fable 5.1", "medium"],
      ["claude-opus-5-5", "Claude Opus 5.5", "medium"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", "medium"],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5", ""],
    ],
  );
  assert.deepEqual(
    fallback.models[2].supportedReasoningEfforts.map((option) => option.value),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(fallback.models[3].supportsReasoning, false);
});

test("Claude discovery keeps the newest model of each family and reads effort capabilities", () => {
  const effort = (levels) => ({
    supported: levels.length > 0,
    ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((level) => [
      level, { supported: levels.includes(level) },
    ])),
  });
  const catalog = buildClaudeModelCatalog([
    { id: "claude-sonnet-6", display_name: "Claude Sonnet 6", created_at: "2027-01-01T00:00:00Z", capabilities: { effort: effort(["low", "medium", "high"]) } },
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-08-01T00:00:00Z", capabilities: { effort: effort(["low", "medium"]) } },
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-08-01T00:00:00Z", capabilities: { effort: effort(["high", "max"]) } },
    { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", capabilities: { effort: effort([]) } },
    { id: "claude-mythos-5-1", display_name: "Claude Mythos 5.1", created_at: "2026-09-01T00:00:00Z" },
  ]);
  assert.equal(catalog.verified, true);
  assert.deepEqual(catalog.models.map((model) => model.value), [
    "claude-opus-5-5",
    "claude-sonnet-6",
    "claude-haiku-4-5-20251001",
  ]);
  assert.equal(catalog.defaultModel, "claude-sonnet-6");
  assert.equal(catalog.models[0].defaultReasoningEffort, "high");
  assert.equal(catalog.models[0].highTokenUse, true);
  assert.equal(catalog.models[2].supportsReasoning, false);
  assert.equal(buildClaudeModelCatalog([]).verified, false);
});

test("a new chat defaults to GPT-6.1-Sol at medium effort when Codex advertises it", () => {
  const sol = (model, isDefault = false) => ({
    model,
    displayName: model,
    isDefault,
    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: "low",
  });
  const codex = buildCodexModelCatalog([sol("gpt-6-sol", true), sol("gpt-6.1-sol"), sol("gpt-5.6-sol")]);
  assert.equal(codex.defaultModel, "gpt-6.1-sol");
  assert.equal(codex.defaultReasoningEffort, "medium");
  assert.equal(buildCodexModelCatalog([sol("gpt-6.1-sol"), sol("gpt-7-sol", true)]).defaultModel, "gpt-7-sol");

  applyAssistantModelCatalog({ ...codex, claude: getFallbackClaudeModelCatalog() });
  assert.equal(getDefaultAssistantModel(), "gpt-6.1-sol");
  assert.equal(getDefaultAssistantReasoningEffort("gpt-6.1-sol"), "medium");
  assert.equal(getDefaultAssistantReasoningEffort("claude-sonnet-5-5"), "medium");
  assert.deepEqual(
    CLAUDE_MODEL_OPTIONS.map((option) => [option.value, option.isDefault]),
    [
      ["claude-fable-5-1", false],
      ["claude-opus-5-5", false],
      ["claude-sonnet-5-5", true],
      ["claude-haiku-4-5-20251001", false],
    ],
  );
  const options = getAssistantModelOptions();
  assert.equal(options.some((option) => option.value === "codex"), false);
  assert.equal(getAssistantModelOptions("codex").some((option) => option.value === "codex"), true);
  assert.equal(assistantModelSupportsReasoning("claude-haiku-4-5-20251001"), false);
  assert.equal(shouldShowTokenAlertFor("claude-opus-5-5", "low"), true);
  resetCatalog();
});

test("ArcBot normalizes host model catalogs and honors their declared default", () => {
  resetCatalog();
  applyAssistantModelCatalog({
    models: [
      {
        value: "runtime-by-value",
        displayLabel: "Runtime Value",
        supportedReasoningEfforts: ["low", { reasoningEffort: "max" }, "low"],
        defaultReasoningEffort: "low",
      },
      {
        model: "runtime-by-model",
        displayName: "Runtime Model",
        supportedReasoningEfforts: [{ value: "medium" }, { value: "high" }],
        defaultEffort: "medium",
        isDefault: true,
      },
      {
        id: "runtime-by-id",
        label: "Runtime ID",
        supportedReasoningEfforts: ["none"],
      },
      { model: "hidden-runtime", displayName: "Hidden", hidden: true },
      { model: "unsafe runtime", displayName: "Unsafe" },
    ],
    defaultModel: "runtime-by-id",
  });

  const options = getAssistantModelOptions();
  const runtimeOptions = options.filter((option) => option.provider === "openai");
  assert.deepEqual(runtimeOptions.map((option) => option.value), [
    "runtime-by-value",
    "runtime-by-model",
    "runtime-by-id",
  ]);
  assert.equal(runtimeOptions[0].label, "Runtime Value");
  assert.deepEqual(runtimeOptions[0].supportedReasoningEfforts, ["low", "max"]);
  assert.equal(runtimeOptions[0].defaultReasoningEffort, "low");
  assert.equal(runtimeOptions[1].label, "Runtime Model");
  assert.equal(runtimeOptions[2].label, "Runtime ID");
  assert.equal(getDefaultAssistantModel(), "runtime-by-id");
  assert.deepEqual(
    MODEL_OPTIONS.filter((option) => !option.legacy).map((option) => option.value),
    options.map((option) => option.value),
  );

  applyAssistantModelCatalog({
    data: [
      { id: "first-runtime", displayName: "First" },
      { id: "marked-runtime", displayName: "Marked", defaultModel: true },
    ],
  });
  assert.equal(getDefaultAssistantModel(), "marked-runtime");
});

test("ArcBot retains safe saved model slugs without making them the runtime default", () => {
  applyAssistantModelCatalog({
    models: [
      { model: "runtime-default", displayName: "Runtime Default", isDefault: true },
    ],
  });

  const savedModel = "gpt-legacy-private";
  assert.equal(normalizeAssistantModel(savedModel), savedModel);
  assert.equal(getDefaultAssistantModel(), "runtime-default");
  assert.equal(getAssistantModelLabelFor(savedModel), `${savedModel} (unavailable)`);

  const unavailable = getAssistantModelOptions(savedModel).find((option) => option.value === savedModel);
  assert.deepEqual(unavailable, {
    value: savedModel,
    label: `${savedModel} (unavailable)`,
    provider: "openai",
    supportsReasoning: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "",
    isDefault: false,
    available: false,
    unavailable: true,
  });
  assert.equal(normalizeAssistantModel("not a safe model"), "runtime-default");
  assert.equal(
    getAssistantModelOptions("not a safe model").some((option) => option.value === "not a safe model"),
    false,
  );
});

test("ArcBot reconciles reasoning only when the selected effort is unsupported", () => {
  applyAssistantModelCatalog({
    models: [
      {
        model: "runtime-reasoning",
        displayName: "Runtime Reasoning",
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "max" },
          { reasoningEffort: "ultra" },
        ],
        defaultReasoningEffort: "medium",
      },
    ],
  });

  assert.equal(reconcileAssistantReasoningEffort("runtime-reasoning", "low"), "low");
  assert.equal(reconcileAssistantReasoningEffort("runtime-reasoning", "max"), "max");
  assert.equal(reconcileAssistantReasoningEffort("runtime-reasoning", "high"), "medium");
  assert.equal(reconcileAssistantReasoningEffort("codex", "minimal"), "medium");
  assert.equal(reconcileAssistantReasoningEffort("saved-model-not-in-catalog", "xhigh"), "xhigh");
  assert.equal(normalizeAssistantReasoningEffort("max"), "max");
  assert.equal(normalizeAssistantReasoningEffort("ultra"), "ultra");
  assert.deepEqual(
    getAssistantReasoningOptionsForModel("runtime-reasoning").map((option) => option.value),
    ["low", "medium", "max", "ultra"],
  );
  assert.equal(assistantModelSupportsReasoning("runtime-reasoning"), true);
  assert.equal(shouldShowTokenAlertFor("runtime-reasoning", "max"), true);
});

test("ArcBot keeps unavailable legacy Claude selections on the Anthropic path", () => {
  resetCatalog();
  const model = "claude-legacy-private";

  assert.equal(normalizeAssistantModel(model), model);
  assert.equal(isClaudeAssistantModel(model), true);
  assert.equal(getAssistantModelOptions(model).at(-1).provider, "anthropic");
});

test("ArcBot connects runtime model discovery through preload and the dynamic picker", () => {
  const preload = read("../electron/preload.js");
  const assistant = read("../ui/ai-assistant/index.js");
  const template = read("../ui/ai-assistant/template.js");

  assert.match(preload, /codexAssistantModels: \(payload\) => invoke\("codex-assistant-models", payload\)/u);
  assert.match(assistant, /host\.codexAssistantModels\(\{ refresh: options\.refresh === true \}\)/u);
  assert.match(assistant, /applyAssistantModelCatalog\(result\)/u);
  assert.match(assistant, /renderAssistantModelOptions\(\)/u);
  assert.match(assistant, /getAssistantReasoningOptionsForModel\(assistantModel\)/u);
  assert.match(assistant, /status\?\.modelUpgradeRequired/u);
  assert.match(assistant, /status\?\.modelCatalogVerified === false/u);
  assert.match(assistant, /assistantModelDefaultVerified/u);
  assert.match(assistant, /result\?\.needsRepair/u);
  assert.match(template, /option\.textContent = "Detecting Codex models\.\.\."/u);
  assert.match(assistant, /installAssistantSelectMenu\(\$\("aiAssistantSettingsModelSelect"\)\)/u);
  assert.match(assistant, /option\.dataset\.note = "Default"/u);
});
