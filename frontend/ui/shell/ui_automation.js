import { shell } from "./shell_context.js?v=20260510a";

const API_BASE = window.location.origin;
const POLL_CLIENT_ID = `shell_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const RESULT_MESSAGE_TYPE = "arcrho:automation-command-result";
const TASK_DESIGNER_COMMAND_MESSAGE = "arcrho:task-designer-automation-command";
const TASK_DESIGNER_RESULT_MESSAGE = "arcrho:task-designer-automation-result";

let automationStarted = false;
let automationStopped = false;
let messageBoxPromise = null;

function toText(value) {
  return value == null ? "" : String(value).trim();
}

function installAutomationStyles() {
  if (document.getElementById("arcrho-ui-automation-style")) return;
  const style = document.createElement("style");
  style.id = "arcrho-ui-automation-style";
  style.textContent = `
    .uiAutomationOverlay {
      position: fixed;
      inset: 0;
      z-index: 20000;
      display: none;
      background: rgba(15, 23, 42, 0.22);
    }
    .uiAutomationOverlay.open { display: block; }
    .uiAutomationOverlay.floating {
      background: transparent;
      pointer-events: none;
    }
    .uiAutomationDialog {
      position: absolute;
      width: min(460px, calc(100vw - 40px));
      max-height: calc(100vh - 48px);
      background: #ffffff;
      border: 1px solid #cfd7e3;
      border-radius: 8px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.22);
      color: #1f2937;
      overflow: hidden;
    }
    .uiAutomationOverlay.floating .uiAutomationDialog {
      width: min(360px, calc(100vw - 40px));
      pointer-events: auto;
    }
    .uiAutomationDialogHeader {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px 10px;
      border-bottom: 1px solid #e3e8f0;
      cursor: move;
      user-select: none;
    }
    .uiAutomationDialogIcon {
      width: 22px;
      height: 22px;
      flex: 0 0 auto;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      background: #2563eb;
    }
    .uiAutomationDialogIcon.warning { background: #b45309; }
    .uiAutomationDialogIcon.error { background: #b91c1c; }
    .uiAutomationDialogIcon.question { background: #047857; }
    .uiAutomationDialogTitle {
      min-width: 0;
      font-size: 15px;
      font-weight: 650;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .uiAutomationDialogBody {
      padding: 14px 16px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 13px;
      line-height: 1.45;
      color: #374151;
      max-height: min(360px, calc(100vh - 180px));
      overflow: auto;
    }
    .uiAutomationDialogActions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px 14px;
      border-top: 1px solid #e3e8f0;
      background: #f8fafc;
    }
    .uiAutomationDialogBtn {
      min-width: 76px;
      height: 30px;
      border-radius: 6px;
      border: 1px solid #b9c4d4;
      background: #ffffff;
      color: #1f2937;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .uiAutomationDialogBtn.primary {
      border-color: #1d4ed8;
      background: #2563eb;
      color: #ffffff;
    }
    .uiAutomationOverlay.dragging,
    .uiAutomationOverlay.dragging * {
      cursor: move !important;
      user-select: none !important;
    }
  `;
  document.head.appendChild(style);
}

function getMessageBoxIcon(kind) {
  const normalized = toText(kind).toLowerCase();
  if (normalized === "warning") return { text: "!", cls: "warning" };
  if (normalized === "error") return { text: "x", cls: "error" };
  if (normalized === "question") return { text: "?", cls: "question" };
  return { text: "i", cls: "" };
}

function clampDialogPosition(dialog, left, top) {
  const margin = 12;
  const width = dialog.offsetWidth || 460;
  const height = dialog.offsetHeight || 180;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(margin, Number(left) || margin), maxLeft),
    top: Math.min(Math.max(margin, Number(top) || margin), maxTop),
  };
}

function positionDialogInCenter(dialog) {
  const rect = dialog.getBoundingClientRect();
  const left = Math.round((window.innerWidth - rect.width) / 2);
  const top = Math.round((window.innerHeight - rect.height) / 2);
  const next = clampDialogPosition(dialog, left, top);
  dialog.style.left = `${next.left}px`;
  dialog.style.top = `${next.top}px`;
}

function enableDialogDrag(overlay, dialog) {
  const header = dialog.querySelector(".uiAutomationDialogHeader");
  if (!header) return () => {};
  let drag = null;

  const applyPosition = (left, top) => {
    const next = clampDialogPosition(dialog, left, top);
    dialog.style.left = `${next.left}px`;
    dialog.style.top = `${next.top}px`;
  };
  const onPointerMove = (event) => {
    if (!drag) return;
    event.preventDefault();
    applyPosition(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  };
  const stopDrag = () => {
    if (!drag) return;
    drag = null;
    overlay.classList.remove("dragging");
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", stopDrag, true);
    window.removeEventListener("pointercancel", stopDrag, true);
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const rect = dialog.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    overlay.classList.add("dragging");
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", stopDrag, true);
    window.addEventListener("pointercancel", stopDrag, true);
    event.preventDefault();
  };
  const onResize = () => {
    const rect = dialog.getBoundingClientRect();
    applyPosition(rect.left, rect.top);
  };

  header.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("resize", onResize);
  return () => {
    stopDrag();
    header.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("resize", onResize);
  };
}

export function showAutomationMessageBox(args = {}) {
  if (messageBoxPromise) return messageBoxPromise;
  installAutomationStyles();
  const overlay = document.createElement("div");
  overlay.className = "uiAutomationOverlay host-nodrag";
  if (args.presentation === "floating") overlay.classList.add("floating");
  overlay.setAttribute("role", "presentation");
  const buttons = Array.isArray(args.buttons) && args.buttons.length
    ? args.buttons.map((item) => toText(item)).filter(Boolean).slice(0, 4)
    : ["OK"];
  const icon = getMessageBoxIcon(args.kind);
  overlay.innerHTML = `
    <section class="uiAutomationDialog" role="dialog" aria-modal="true" aria-labelledby="uiAutomationDialogTitle">
      <div class="uiAutomationDialogHeader">
        <span class="uiAutomationDialogIcon ${icon.cls}" aria-hidden="true">${icon.text}</span>
        <div class="uiAutomationDialogTitle" id="uiAutomationDialogTitle"></div>
      </div>
      <div class="uiAutomationDialogBody"></div>
      <div class="uiAutomationDialogActions"></div>
    </section>
  `;
  overlay.querySelector(".uiAutomationDialogTitle").textContent = toText(args.title) || "ArcRho";
  overlay.querySelector(".uiAutomationDialogBody").textContent = String(args.message || "");
  const actions = overlay.querySelector(".uiAutomationDialogActions");
  for (const [index, label] of buttons.entries()) {
    const button = document.createElement("button");
    button.className = `uiAutomationDialogBtn${index === 0 ? " primary" : ""}`;
    button.type = "button";
    button.textContent = label;
    button.dataset.button = label;
    actions.appendChild(button);
  }
  document.body.appendChild(overlay);
  overlay.classList.add("open");
  const dialog = overlay.querySelector(".uiAutomationDialog");
  positionDialogInCenter(dialog);
  const cleanupDrag = enableDialogDrag(overlay, dialog);

  messageBoxPromise = new Promise((resolve) => {
    const cleanup = () => {
      overlay.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey, true);
      cleanupDrag();
      overlay.remove();
      messageBoxPromise = null;
    };
    const finish = (button) => {
      cleanup();
      resolve({ button: button || buttons[0] || "OK" });
    };
    const onClick = (event) => {
      const button = event.target?.closest?.(".uiAutomationDialogBtn");
      if (button) {
        event.preventDefault();
        finish(toText(button.dataset.button));
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(buttons.includes("Cancel") ? "Cancel" : buttons[buttons.length - 1]);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        finish(buttons[0]);
      }
    };
    overlay.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey, true);
    setTimeout(() => {
      try { overlay.querySelector(".uiAutomationDialogBtn.primary")?.focus(); } catch {}
    }, 0);
  });
  return messageBoxPromise;
}

function findActiveProjectInstanceTab() {
  const active = shell.state?.tabs?.find?.((tab) => tab.id === shell.state.activeId);
  if (active?.type === "project_instance") return active;
  return null;
}

function getProjectInstanceAutomationMessageType(commandName) {
  if (commandName === "projectInstance.openDataset") return "arcrho:automation-open-dataset";
  if (
    commandName === "projectInstance.windowAction"
    || commandName === "projectInstance.windowProperties"
    || commandName === "projectInstance.activeWindow"
  ) {
    return "arcrho:automation-window-command";
  }
  return "";
}

function sendCommandToProjectInstance(command) {
  const tab = findActiveProjectInstanceTab();
  if (!tab) {
    return Promise.resolve({ ok: false, error: "Activate a Project Instance page before running this UI command." });
  }
  shell.ensureIframe?.(tab);
  const iframe = tab.iframe;
  if (!iframe?.contentWindow) {
    return Promise.resolve({ ok: false, error: "The active Project Instance page is not ready." });
  }
  const messageType = getProjectInstanceAutomationMessageType(toText(command?.command));
  if (!messageType) {
    return Promise.resolve({ ok: false, error: `Unsupported Project Instance command: ${toText(command?.command)}` });
  }

  return new Promise((resolve) => {
    const requestId = `ui_auto_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(payload || { ok: false, error: "Project Instance command failed." });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data || {};
      if (msg.type !== RESULT_MESSAGE_TYPE || msg.requestId !== requestId) return;
      finish({ ok: !!msg.ok, result: msg.result || {}, error: toText(msg.error) });
    };
    window.addEventListener("message", onMessage);
    try {
      iframe.contentWindow.postMessage({
        type: messageType,
        requestId,
        args: command.args || {},
      }, "*");
    } catch (err) {
      finish({ ok: false, error: toText(err?.message) || "Failed to send Project Instance command." });
      return;
    }
    setTimeout(() => finish({ ok: false, error: "Timed out waiting for Project Instance." }), 10000);
  });
}

function waitForIframeReady(iframe, timeoutMs = 5000) {
  if (!iframe) return Promise.resolve(false);
  try {
    const ready = iframe.contentDocument?.readyState;
    if (ready === "interactive" || ready === "complete") return Promise.resolve(true);
  } catch {}
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      iframe.removeEventListener("load", onLoad);
      window.clearTimeout(timer);
      resolve(!!ok);
    };
    const onLoad = () => finish(true);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    iframe.addEventListener("load", onLoad, { once: true });
  });
}

async function sendCommandToTaskDesigner(command) {
  const args = command?.args || {};
  const name = toText(command?.command);
  let tab = shell.state.tabs.find((item) => item.type === "task_designer");
  if (!tab || name === "taskDesigner.open") {
    tab = shell.openTaskDesigner?.({
      title: args.title || "Task Designer",
      contextLabel: args.context || args.contextLabel || "Active DFM validation",
      macroId: args.macroId || args.macro_id || "",
      autoRun: false,
    }) || tab;
  }
  if (!tab) return { ok: false, error: "Could not open Task Designer." };
  shell.ensureIframe?.(tab);
  const iframe = tab.iframe;
  if (!iframe?.contentWindow) return { ok: false, error: "Task Designer page is not ready." };
  await waitForIframeReady(iframe);

  return new Promise((resolve) => {
    const requestId = `task_designer_auto_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(payload || { ok: false, error: "Task Designer command failed." });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data || {};
      if (msg.type !== TASK_DESIGNER_RESULT_MESSAGE || msg.requestId !== requestId) return;
      finish({ ok: !!msg.ok, result: msg.result || {}, error: toText(msg.error) });
    };
    window.addEventListener("message", onMessage);
    try {
      iframe.contentWindow.postMessage({
        type: TASK_DESIGNER_COMMAND_MESSAGE,
        requestId,
        command: name,
        args,
      }, "*");
    } catch (err) {
      finish({ ok: false, error: toText(err?.message) || "Failed to send Task Designer command." });
      return;
    }
    window.setTimeout(() => finish({ ok: false, error: "Timed out waiting for Task Designer." }), 10000);
  });
}

async function executeAutomationCommand(command) {
  const name = toText(command?.command);
  if (name === "ui.messageBox") {
    const result = await showAutomationMessageBox(command.args || {});
    return { ok: true, result };
  }
  if (name.startsWith("taskDesigner.")) {
    return sendCommandToTaskDesigner(command);
  }
  if (name === "projectInstance.openDataset") {
    return sendCommandToProjectInstance(command);
  }
  if (
    name === "projectInstance.windowAction"
    || name === "projectInstance.windowProperties"
    || name === "projectInstance.activeWindow"
  ) {
    return sendCommandToProjectInstance(command);
  }
  return { ok: false, error: `Unsupported UI automation command: ${name}` };
}

async function completeCommand(commandId, payload) {
  try {
    await fetch(`${API_BASE}/ui_automation/commands/${encodeURIComponent(commandId)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: !!payload?.ok,
        result: payload?.result || {},
        error: toText(payload?.error),
      }),
    });
  } catch (err) {
    shell.updateStatusBar?.(`UI automation response failed: ${toText(err?.message) || err}`, { tone: "error" });
  }
}

async function pollOnce() {
  const response = await fetch(`${API_BASE}/ui_automation/commands/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: POLL_CLIENT_ID, timeout_sec: 20 }),
  });
  const payload = await response.json();
  const command = payload?.command;
  if (!command?.id) return;
  let result = null;
  try {
    result = await executeAutomationCommand(command);
  } catch (err) {
    result = { ok: false, error: toText(err?.message) || String(err || "UI automation command failed.") };
  }
  await completeCommand(command.id, result);
}

async function pollLoop() {
  while (!automationStopped) {
    try {
      await pollOnce();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }
}

export function initUiAutomation() {
  if (automationStarted) return;
  automationStarted = true;
  automationStopped = false;
  void pollLoop();
}
