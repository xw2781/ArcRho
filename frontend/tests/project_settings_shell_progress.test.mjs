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
  assert.equal("cancellable" in calls[0][1], false, "a page that says nothing about cancel gets no button");
  assert.equal("onCancel" in calls[0][1], false);
});

test("a cancellable progress window hands Cancel back to the owning Project Settings tab", () => {
  calls.length = 0;
  const posted = [];
  projectSettingsFrame.postMessage = (message, origin) => posted.push([message, origin]);
  try {
    handleProjectSettingsProgressMessage(projectSettingsFrame, {
      type: "arcrho:project-settings-progress",
      action: "open",
      progressId: "duplicate-2",
      label: "Copying...",
      cancellable: true,
    });
    handleProjectSettingsProgressMessage(projectSettingsFrame, {
      type: "arcrho:project-settings-progress",
      action: "update",
      progressId: "duplicate-2",
      label: "Finalizing...",
      cancellable: false,
    });
    assert.equal(calls[0][1].cancellable, true);
    assert.equal(typeof calls[0][1].onCancel, "function");
    assert.equal(calls[1][1].cancellable, false);

    calls[0][1].onCancel();
    assert.deepEqual(posted, [[
      { type: "arcrho:project-settings-progress-cancel", progressId: "duplicate-2" },
      globalThis.location?.origin || "*",
    ]]);
  } finally {
    delete projectSettingsFrame.postMessage;
  }
});

test("the shell progress window carries a Cancel button that follows the cancellable flag", async () => {
  const automationSource = await readFile(new URL("../ui/shell/ui_automation.js", import.meta.url), "utf8");
  assert.match(automationSource, /class="uiAutomationDialogBtn uiAutomationProgressCancel"/u);
  assert.match(automationSource, /function applyProgressCancelState\(/u);
  assert.match(automationSource, /actionsEl\.hidden = !cancellable/u);
  assert.match(automationSource, /buttonEl\.textContent = "Cancelling\.\.\."/u);
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

test("the automation dialog drags under pointer capture so a fast drag cannot escape it", async () => {
  const automationSource = await readFile(new URL("../ui/shell/ui_automation.js", import.meta.url), "utf8");
  // A fast drag outruns hit-testing when the move listeners sit on window, so
  // the header captures the pointer and listens on itself (ArcRho UI rule L16).
  assert.match(automationSource, /header\.setPointerCapture\?\.\(event\.pointerId\)/u);
  assert.match(automationSource, /header\.addEventListener\("pointermove", onPointerMove\)/u);
  assert.match(automationSource, /header\.addEventListener\("pointerup", stopDrag\)/u);
  assert.match(automationSource, /header\.addEventListener\("pointercancel", stopDrag\)/u);
  assert.match(automationSource, /header\.addEventListener\("lostpointercapture", stopDrag\)/u);
  assert.match(automationSource, /event\.pointerId !== drag\.pointerId/u);
  assert.doesNotMatch(automationSource, /window\.addEventListener\("pointermove"/u);
  assert.doesNotMatch(automationSource, /window\.addEventListener\("pointerup"/u);
});

test("the shell progress window resizes from a corner grip that keeps it on screen", async () => {
  const automationSource = await readFile(new URL("../ui/shell/ui_automation.js", import.meta.url), "utf8");
  // A grip in the bottom-right corner, captured the same way the header drag
  // is so a fast pull cannot escape it (ArcRho UI rule L16).
  assert.match(automationSource, /handle\.className = "uiAutomationResizeHandle"/u);
  assert.match(automationSource, /\.uiAutomationResizeHandle \{/u);
  assert.match(automationSource, /cursor: nwse-resize/u);
  assert.match(automationSource, /handle\.setPointerCapture\?\.\(event\.pointerId\)/u);
  assert.match(automationSource, /handle\.addEventListener\("pointermove", onPointerMove\)/u);
  assert.match(automationSource, /handle\.addEventListener\("lostpointercapture", stopResize\)/u);
  assert.match(automationSource, /event\.pointerId !== resize\.pointerId/u);
  // The window never shrinks below its own minimum nor grows past the app
  // window, and it is re-clamped when the app window itself changes size.
  assert.match(automationSource, /function clampDialogSize\(dialog, left, top, width, height\)/u);
  assert.match(automationSource, /min-width: 280px/u);
  assert.match(automationSource, /min-height: 150px/u);
  assert.match(automationSource, /window\.addEventListener\("resize", onWindowResize\)/u);
  // Resizing the app window redraws the progress window at the size it is
  // meant to hold rather than at the size it is currently shown at, and that
  // size is measured against the whole app window because the window is free
  // to slide back towards the top-left corner. A narrower app window can
  // therefore borrow room from it and give it all back, instead of trimming
  // it a little more every time.
  assert.match(automationSource, /function clampDialogSizeToAppWindow\(dialog, width, height\)/u);
  assert.match(automationSource, /window\.innerWidth - margin \* 2/u);
  assert.match(automationSource, /draw\(wanted\.width, wanted\.height, false\)/u);
  assert.doesNotMatch(automationSource, /applySize\(rect\.width, rect\.height\)/u);
  // The size the user pulled to is reused by the next progress window.
  assert.match(automationSource, /let progressWindowSize = null/u);
  assert.match(automationSource, /if \(progressWindowSize\) resizer\.applySize\(/u);
  assert.match(automationSource, /entry\.cleanupResize\?\.\(\)/u);
});
