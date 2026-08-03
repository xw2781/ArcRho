import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellMessagesSource = await readFile(new URL("../ui/shell/shell_messages.js", import.meta.url), "utf8");
let shellMessagesTestSource = shellMessagesSource
  .replace(
    /import \{ shell \} from "\.\/shell_context\.js\?v=[^"]+";/u,
    "const shell = globalThis.__projectSettingsProgressShell;",
  )
  .replace(
    /import \{ normalizeBrowsingHistoryEntry \} from "\/ui\/shell\/browsing_history\.js";/u,
    "const normalizeBrowsingHistoryEntry = (value) => value;",
  )
  .replace(
    /import \{ normalizeProjectInstanceState, normalizeShellActivityEntry \} from "\/ui\/shell\/shell_activity_history\.js";/u,
    "const normalizeProjectInstanceState = (value) => value; const normalizeShellActivityEntry = (value) => value;",
  )
  .replace(
    /import \{\s*closeAutomationProgress,\s*openAutomationProgress,\s*updateAutomationProgress,\s*\} from "\.\/ui_automation\.js\?v=[^"]+";/u,
    "const { closeAutomationProgress, openAutomationProgress, updateAutomationProgress } = globalThis.__projectSettingsProgressActions;",
  );

const projectSettingsFrame = {};
const unrelatedFrame = {};
const calls = [];
globalThis.__projectSettingsProgressShell = {
  state: {
    tabs: [
      { id: "ps-1", type: "project_settings", iframe: { contentWindow: projectSettingsFrame } },
      { type: "workflow", iframe: { contentWindow: unrelatedFrame } },
    ],
  },
};
globalThis.__projectSettingsProgressActions = {
  openAutomationProgress: (args) => calls.push(["open", args]),
  updateAutomationProgress: (args) => calls.push(["update", args]),
  closeAutomationProgress: (args) => calls.push(["close", args]),
};
const { handleProjectSettingsProgressMessage } = await import(
  `data:text/javascript;base64,${Buffer.from(shellMessagesTestSource).toString("base64")}`
);
delete globalThis.__projectSettingsProgressShell;
delete globalThis.__projectSettingsProgressActions;

test("only a registered Project Settings iframe can route shell progress", () => {
  const message = {
    type: "arcrho:project-settings-progress",
    action: "open",
    progressId: "duplicate-1",
    label: "Starting...",
    total: 0,
  };
  assert.equal(handleProjectSettingsProgressMessage(unrelatedFrame, message), false);
  assert.equal(handleProjectSettingsProgressMessage({}, message), false);
  assert.equal(calls.length, 0);

  assert.equal(handleProjectSettingsProgressMessage(projectSettingsFrame, message), true);
  handleProjectSettingsProgressMessage(projectSettingsFrame, { ...message, action: "update", total: 4, completed: 2 });
  handleProjectSettingsProgressMessage(projectSettingsFrame, { ...message, action: "close", autoCloseMs: 850 });
  assert.deepEqual(calls.map(([action]) => action), ["open", "update", "close"]);
  assert.equal(calls[0][1].progressId, "ps-1:duplicate-1");
  assert.equal(calls[1][1].completed, 2);
  assert.equal(calls[2][1].autoCloseMs, 850);
});

test("Project Settings progress rejects a mismatched message origin", () => {
  const priorLocation = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://arcrho.local" },
  });
  try {
    const accepted = handleProjectSettingsProgressMessage(
      projectSettingsFrame,
      {
        type: "arcrho:project-settings-progress",
        action: "open",
        progressId: "spoofed",
      },
      "https://untrusted.example",
    );
    assert.equal(accepted, false);
  } finally {
    if (priorLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: priorLocation });
  }
});

test("automation progress helpers are exported and support reduced-motion indeterminate state", async () => {
  const automationSource = await readFile(new URL("../ui/shell/ui_automation.js", import.meta.url), "utf8");
  assert.match(automationSource, /export function openAutomationProgress\(/u);
  assert.match(automationSource, /export function updateAutomationProgress\(/u);
  assert.match(automationSource, /export function closeAutomationProgress\(/u);
  assert.match(automationSource, /classList\.toggle\("indeterminate", total <= 0\)/u);
  assert.match(automationSource, /@keyframes uiAutomationProgressSweep/u);
  assert.match(automationSource, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(automationSource, /removeProperty\("width"\)/u);
});
