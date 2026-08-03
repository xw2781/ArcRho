import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  isClaudeAssistantModel,
  normalizeAssistantModel,
  normalizeAssistantReasoningEffort,
  reconcileAssistantReasoningEffort,
  shouldShowTokenAlertFor,
} from "../ui/ai-assistant/models.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function resetCatalog() {
  applyAssistantModelCatalog([]);
}

test("ArcBot starts with only the legacy Codex sentinel and the Claude registry", () => {
  resetCatalog();

  const options = getAssistantModelOptions();
  assert.deepEqual(
    options.filter((option) => option.provider === "openai").map((option) => option.value),
    ["codex"],
  );
  assert.deepEqual(
    options.filter((option) => option.provider === "anthropic").map((option) => option.value),
    CLAUDE_MODEL_OPTIONS.map((option) => option.value),
  );
  assert.equal(getDefaultAssistantModel(), "codex");
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
  const runtimeOptions = options.filter((option) => option.provider === "openai" && option.value !== "codex");
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
  assert.deepEqual(MODEL_OPTIONS.map((option) => option.value), options.map((option) => option.value));

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
});
