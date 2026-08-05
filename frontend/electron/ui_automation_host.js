"use strict";

// Electron-side host support for the ArcRho UI regression harness.
//
// Two capabilities the renderer cannot provide on its own:
//   1. `webContents.capturePage()` screenshots of any app window.
//   2. `webContents.sendInputEvent()` synthetic input that goes through Chromium's real
//      hit-testing, so a click that lands on an occluded or collapsed control fails the way a
//      user's click would.
//
// Both are reachable from the shell through the existing `/ui_automation/commands` bus, so an
// out-of-process Python harness needs no new transport and no credentials.

const fs = require("fs");
const path = require("path");

const MOUSE_BUTTONS = new Set(["left", "middle", "right"]);
const MOUSE_TYPES = new Set(["mouseDown", "mouseUp", "mouseMove", "mouseEnter", "mouseLeave"]);
const KEY_TYPES = new Set(["keyDown", "keyUp", "char"]);
const MODIFIER_KEYS = new Set([
  "shift",
  "control",
  "alt",
  "meta",
  "isKeypad",
  "isAutoRepeat",
  "leftButtonDown",
  "middleButtonDown",
  "rightButtonDown",
  "capsLock",
  "numLock",
]);

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function normalizeModifiers(value) {
  if (!Array.isArray(value)) return [];
  const seen = [];
  for (const item of value) {
    const name = String(item || "").trim();
    if (MODIFIER_KEYS.has(name) && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

function normalizeRect(value) {
  if (!value || typeof value !== "object") return null;
  const width = toInt(value.width, 0);
  const height = toInt(value.height, 0);
  if (width <= 0 || height <= 0) return null;
  return { x: toInt(value.x, 0), y: toInt(value.y, 0), width, height };
}

// A window created with `show: false`, minimized, or fully occluded can hand back an empty or
// black frame, and Chromium throttles painting for hidden windows. Make the target paintable
// before capturing rather than returning an unusable image.
async function ensureCapturable(targetWindow) {
  let restoredVisibility = false;
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
    restoredVisibility = true;
  }
  if (!targetWindow.isVisible()) {
    targetWindow.showInactive();
    restoredVisibility = true;
  }
  try {
    targetWindow.webContents.setBackgroundThrottling(false);
  } catch {
    // Not fatal - capture may still succeed.
  }
  if (restoredVisibility) {
    // Give the compositor a frame to paint before we read pixels back.
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return restoredVisibility;
}

function registerUiAutomationIpc(deps = {}) {
  const { ipcMain, BrowserWindow, getMainWindow, getArcodeWindow, getSplashWindow } = deps;
  if (!ipcMain || !BrowserWindow) {
    throw new Error("registerUiAutomationIpc requires ipcMain and BrowserWindow.");
  }

  function resolveWindow(event, payload) {
    const selector = String(payload?.window || "").trim().toLowerCase();
    if (payload?.windowId != null) {
      const byId = BrowserWindow.fromId(toInt(payload.windowId, -1));
      if (byId && !byId.isDestroyed()) return byId;
      return null;
    }
    if (selector === "arcode") return getArcodeWindow?.() || null;
    if (selector === "splash") return getSplashWindow?.() || null;
    if (selector === "main") return getMainWindow?.() || null;
    const sender = BrowserWindow.fromWebContents(event?.sender);
    return sender || getMainWindow?.() || null;
  }

  ipcMain.handle("automation-window-list", () =>
    BrowserWindow.getAllWindows()
      .filter((item) => !item.isDestroyed())
      .map((item) => ({
        id: item.id,
        title: item.getTitle(),
        url: item.webContents?.getURL?.() || "",
        visible: item.isVisible(),
        minimized: item.isMinimized(),
        focused: item.isFocused(),
        bounds: item.getBounds(),
      }))
  );

  ipcMain.handle("automation-capture-page", async (event, payload) => {
    const targetWindow = resolveWindow(event, payload);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: false, error: "Target window is not available." };
    }
    try {
      await ensureCapturable(targetWindow);
      const rect = normalizeRect(payload?.rect);
      const image = rect
        ? await targetWindow.webContents.capturePage(rect)
        : await targetWindow.webContents.capturePage();
      const size = image.getSize();
      if (!size.width || !size.height) {
        return { ok: false, error: "Captured an empty frame." };
      }

      const outPath = String(payload?.path || "").trim();
      if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, image.toPNG());
        return { ok: true, path: outPath, width: size.width, height: size.height };
      }
      return {
        ok: true,
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || "Capture failed.") };
    }
  });

  ipcMain.handle("automation-send-input", (event, payload) => {
    const targetWindow = resolveWindow(event, payload);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: false, error: "Target window is not available." };
    }
    const events = Array.isArray(payload?.events) ? payload.events : [payload?.event];
    const sent = [];
    try {
      for (const item of events) {
        if (!item || typeof item !== "object") continue;
        const type = String(item.type || "").trim();
        const modifiers = normalizeModifiers(item.modifiers);

        if (MOUSE_TYPES.has(type)) {
          const button = MOUSE_BUTTONS.has(String(item.button || "")) ? String(item.button) : "left";
          targetWindow.webContents.sendInputEvent({
            type,
            x: toInt(item.x, 0),
            y: toInt(item.y, 0),
            button,
            clickCount: Math.max(0, toInt(item.clickCount, type === "mouseMove" ? 0 : 1)),
            modifiers,
          });
          sent.push(type);
          continue;
        }

        if (type === "mouseWheel") {
          targetWindow.webContents.sendInputEvent({
            type,
            x: toInt(item.x, 0),
            y: toInt(item.y, 0),
            deltaX: toInt(item.deltaX, 0),
            deltaY: toInt(item.deltaY, 0),
            canScroll: item.canScroll !== false,
            modifiers,
          });
          sent.push(type);
          continue;
        }

        if (KEY_TYPES.has(type)) {
          const keyCode = String(item.keyCode || "");
          if (!keyCode) continue;
          targetWindow.webContents.sendInputEvent({ type, keyCode, modifiers });
          sent.push(type);
          continue;
        }
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err || "sendInputEvent failed."), sent };
    }
    if (!sent.length) return { ok: false, error: "No recognized input events were supplied." };
    return { ok: true, sent };
  });

  ipcMain.handle("automation-window-focus", (event, payload) => {
    const targetWindow = resolveWindow(event, payload);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: false, error: "Target window is not available." };
    }
    if (targetWindow.isMinimized()) targetWindow.restore();
    targetWindow.show();
    targetWindow.focus();
    return { ok: true, id: targetWindow.id };
  });

  return { resolveWindow };
}

module.exports = {
  registerUiAutomationIpc,
  // Exported for tests.
  normalizeModifiers,
  normalizeRect,
  MOUSE_TYPES,
  KEY_TYPES,
};
