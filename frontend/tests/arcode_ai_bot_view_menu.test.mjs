import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Arcode View menu controls the shared AI assistant launcher", () => {
  const html = read("../ui/arcode/main.html");
  const shell = read("../ui/arcode/main.js");
  const assistantAdapter = read("../ui/ai-assistant/arcode.js");

  assert.match(html, /data-action="toggle-ai-bot-icon"/);
  assert.match(shell, /isAiAssistantLauncherVisible\(\)\s*\?\s*"Hide AI Bot Icon"\s*:\s*"Show AI Bot Icon"/);
  assert.match(shell, /action === "toggle-ai-bot-icon"[\s\S]*?toggleAiAssistantLauncherVisible\(\)/);
  assert.match(shell, /updateViewMenuState:\s*updateMenuState/);
  assert.match(assistantAdapter, /toggleAiAssistantLauncherVisible/);
});
