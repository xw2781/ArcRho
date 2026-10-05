"use strict";

// Lets an agent drive one Arco window, and nothing outside it, while the person at the desk
// watches and can take over at any moment.
//
// - Input goes straight into the window's page through `webContents.sendInputEvent`, so it can
//   never reach another application and the real mouse pointer never moves.
// - The window shows an edge glow, the agent's own pointer, and a banner (agent_overlay.js).
// - Real input is told apart from the agent's exactly: Chromium reports every input event
//   synchronously while `sendInputEvent` runs, so an event that arrives at any other moment came
//   from the person. A click, key press, or wheel turn in the window pauses the agent, and so does
//   the global stop key. Only the banner's Resume button lets it continue.
//
// An agent reaches this through tools/arco_window_control, which reads the port and token this
// host publishes and posts one command at a time to a loopback-only HTTP endpoint.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { ensureCapturable } = require("../ui_automation_host");
const { publishAppEntry, unpublishAppEntry } = require("../backend_port");

const ENTRY_FORMAT = "arcrho.agent_window_control.v1";
const OVERLAY_WORLD_ID = 1907;
const FRAME_MS = 16;
const PAUSE_POLL_MS = 250;
const STOP_HOTKEY = "Control+Alt+Escape";
const STOP_HOTKEY_LABEL = "Ctrl+Alt+Esc";
const DEFAULT_IDLE_EXIT_MINUTES = 20;
const POSITIONS = new Set(["TopCenter", "TopRight", "BottomCenter", "BottomRight"]);
// Input types that mean a person is acting. Moves are left out so a pointer passing over the
// window does not pause the agent; Chromium's derived gesture events are left out too.
const USER_INPUT_TYPES = new Set(["mouseDown", "rawKeyDown", "keyDown", "mouseWheel"]);
// While the agent holds the button for a drag, any real pointer motion over the window ends
// Chromium's drag, so it counts as the person acting too.
const POINTER_MOTION_TYPES = new Set(["mouseMove", "mouseEnter", "mouseLeave"]);
const MODIFIER_ALIASES = {
  ctrl: "control",
  control: "control",
  shift: "shift",
  alt: "alt",
  meta: "meta",
  win: "meta",
  cmd: "meta",
};
const KEY_ALIASES = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

// Exit codes the command-line client hands back to the agent; the same meanings as
// tools/agent_screen_control.
const CODE = { done: 0, usage: 2, user: 3, refused: 4 };

function result(code, message, extra = {}) {
  return { ok: code === CODE.done, code, message, ...extra };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// One journey of the agent's pointer: a gently bowed cubic curve travelled with the
// minimum-jerk speed profile of a human reach, taking longer for longer distances.
// The same curve as tools/agent_screen_control, in window pixels.
function createGlide(x0, y0, x3, y3, random = Math.random) {
  const dx = x3 - x0;
  const dy = y3 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1) return { durationMs: 0, at: () => ({ x: x3, y: y3 }) };
  const durationMs = Math.max(180, Math.min(950, 200 + 115 * Math.log2(1 + d / 35)));
  const nx = -dy / d;
  const ny = dx / d;
  const side = dx >= 0 ? -1 : 1;
  const arc = Math.min(0.14 * d, 110) * side * (0.7 + 0.6 * random());
  const x1 = x0 + dx * 0.28 + nx * arc;
  const y1 = y0 + dy * 0.28 + ny * arc;
  const x2 = x0 + dx * 0.78 + nx * arc * 0.55;
  const y2 = y0 + dy * 0.78 + ny * arc * 0.55;
  return {
    durationMs,
    at(elapsedMs) {
      const t = Math.max(0, Math.min(1, elapsedMs / durationMs));
      const s = t * t * t * (10 - 15 * t + 6 * t * t);
      const u = 1 - s;
      return {
        x: u * u * u * x0 + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3,
        y: u * u * u * y0 + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3,
      };
    },
  };
}

// "Ctrl+Shift+S" -> { keyCode: "S", modifiers: ["control", "shift"] }.
function parseKeyChord(text) {
  const pieces = String(text || "").split("+").map((piece) => piece.trim()).filter(Boolean);
  if (!pieces.length) return null;
  const last = pieces.pop();
  const modifiers = [];
  for (const piece of pieces) {
    const modifier = MODIFIER_ALIASES[piece.toLowerCase()];
    if (!modifier) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const alias = KEY_ALIASES[last.toLowerCase()];
  const keyCode = alias || (last.length === 1 ? last.toUpperCase() : last);
  return { keyCode, modifiers };
}

// The events that type one character: key down, the character itself, key up.
function charEvents(ch) {
  if (ch === "\n" || ch === "\r") {
    return [
      { type: "keyDown", keyCode: "Enter" },
      { type: "char", keyCode: "\r" },
      { type: "keyUp", keyCode: "Enter" },
    ];
  }
  if (ch === "\t") return [{ type: "keyDown", keyCode: "Tab" }, { type: "keyUp", keyCode: "Tab" }];
  const keyCode = ch === " " ? "Space" : ch;
  // A capital letter reports Shift, as it would from a keyboard.
  const modifiers = ch !== ch.toLowerCase() ? ["shift"] : [];
  return [
    { type: "keyDown", keyCode, modifiers },
    { type: "char", keyCode: ch, modifiers },
    { type: "keyUp", keyCode, modifiers },
  ];
}

function isUserInput(inputEvent, { dragging = false } = {}) {
  const type = String(inputEvent?.type || "");
  return USER_INPUT_TYPES.has(type) || (dragging && POINTER_MOTION_TYPES.has(type));
}

function describeUserInput(type) {
  if (type === "mouseDown") return "You clicked in this window.";
  if (POINTER_MOTION_TYPES.has(type)) return "You moved the pointer during a drag.";
  if (type === "mouseWheel") return "You scrolled in this window.";
  return "You typed in this window.";
}

function readAssets() {
  const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
  return {
    script: read("agent_overlay.js"),
    css: read("agent_overlay.css"),
    svg: read("agent_pointer.svg"),
  };
}

function createAgentWindowControl(deps = {}) {
  const {
    BrowserWindow,
    globalShortcut,
    screen,
    getMainWindow,
    getArcodeWindow,
    entryPath,
    appMode = "arcrho",
    log = () => {},
  } = deps;

  let assets = null;
  let session = null;
  let injecting = false;
  let server = null;
  let token = "";
  let queue = Promise.resolve();

  // ---- windows ----

  function liveWindows() {
    return BrowserWindow.getAllWindows().filter((item) => !item.isDestroyed());
  }

  function windowRole(target) {
    if (target === getMainWindow?.()) return "main";
    if (target === getArcodeWindow?.()) return "arcode";
    return "";
  }

  function resolveWindow(selector) {
    const text = String(selector ?? "").trim();
    if (!text || text.toLowerCase() === "main") return getMainWindow?.() || null;
    if (text.toLowerCase() === "arcode") return getArcodeWindow?.() || null;
    if (/^\d+$/.test(text)) return BrowserWindow.fromId(Number(text)) || null;
    const needle = text.toLowerCase();
    return liveWindows().find((item) => item.getTitle().toLowerCase().includes(needle)) || null;
  }

  function contentSize(target) {
    const bounds = target.getContentBounds();
    return { width: bounds.width, height: bounds.height };
  }

  function describeWindow(target) {
    return {
      id: target.id,
      role: windowRole(target),
      title: target.getTitle(),
      visible: target.isVisible(),
      minimized: target.isMinimized(),
      focused: target.isFocused(),
      content: target.getContentBounds(),
    };
  }

  // ---- overlay ----

  async function runInOverlay(target, code) {
    return target.webContents.executeJavaScriptInIsolatedWorld(OVERLAY_WORLD_ID, [{ code }]);
  }

  async function callOverlay(method, arg) {
    const target = session?.window;
    if (!target || target.isDestroyed()) return null;
    const call = `window.__agentOverlay ? window.__agentOverlay.${method}(${JSON.stringify(arg ?? null)}) : "__missing__"`;
    try {
      let value = await runInOverlay(target, call);
      if (value === "__missing__") {
        assets = assets || readAssets();
        await runInOverlay(target, assets.script);
        await runInOverlay(target, `window.__agentOverlay.install(${JSON.stringify({ css: assets.css, svg: assets.svg })})`);
        value = await runInOverlay(target, call);
      }
      return value;
    } catch (err) {
      log(`Agent window control: overlay ${method} failed`, err);
      return null;
    }
  }

  function overlayState() {
    return {
      agent: session.agent,
      action: session.action,
      position: session.position,
      paused: session.paused,
      pauseReason: session.pauseReason,
      startedAt: session.startedAt,
      lastCommandAt: session.lastCommandAt,
      showPointer: session.showPointer,
      hotkey: session.hotkeyRegistered ? STOP_HOTKEY_LABEL : "",
      zoom: session.window.webContents.getZoomFactor(),
      pointer: session.pointer,
    };
  }

  async function pushOverlay() {
    if (!session || session.ended) return;
    const rect = await callOverlay("apply", overlayState());
    if (rect) session.bannerRect = rect;
  }

  // ---- session ----

  function inject(event) {
    injecting = true;
    try {
      session.window.webContents.sendInputEvent(event);
    } finally {
      injecting = false;
    }
  }

  function onInputEvent(_event, inputEvent) {
    if (injecting || !session || session.paused || session.ended) return;
    if (!isUserInput(inputEvent, { dragging: session.dragging })) return;
    pause(describeUserInput(inputEvent.type));
  }

  function onPageLoaded() {
    // A reload wipes the overlay with the page; bring it back.
    if (session && !session.ended) void pushOverlay();
  }

  function onWindowClosed() {
    if (session) teardown("The window was closed.");
  }

  function pause(reason) {
    if (!session || session.paused || session.ended) return;
    session.paused = true;
    session.pauseReason = reason;
    log(`Agent window control: paused. ${reason}`);
    void pushOverlay();
    if (!session.pollTimer) session.pollTimer = setInterval(pollBanner, PAUSE_POLL_MS);
  }

  // While paused, the banner's buttons decide what happens next.
  async function pollBanner() {
    if (!session || session.ended) return;
    const choice = await callOverlay("takeRequest");
    if (!session || !session.paused) return;
    if (choice === "resume") {
      session.paused = false;
      session.pauseReason = "";
      session.lastCommandAt = Date.now();
      clearInterval(session.pollTimer);
      session.pollTimer = null;
      log("Agent window control: resumed by the user.");
      void pushOverlay();
    } else if (choice === "end") {
      log("Agent window control: ended by the user.");
      endByUser();
    }
  }

  // The person ended the agent's control. The overlay goes, but the session stays marked so
  // the agent learns of it on its next command; only the agent's own stop clears it.
  function endByUser() {
    const target = session.window;
    detach(target);
    session.ended = true;
    session.paused = true;
    session.pauseReason = "You ended the agent's control of this window.";
    void runInOverlay(target, "window.__agentOverlay && window.__agentOverlay.remove()").catch(() => {});
  }

  function attach(target) {
    target.webContents.on("input-event", onInputEvent);
    target.webContents.on("did-finish-load", onPageLoaded);
    target.once("closed", onWindowClosed);
    try {
      session.hotkeyRegistered = !!globalShortcut?.register(STOP_HOTKEY, () => pause(`You pressed ${STOP_HOTKEY_LABEL}.`));
    } catch {
      session.hotkeyRegistered = false;
    }
  }

  function detach(target) {
    if (session?.pollTimer) clearInterval(session.pollTimer);
    if (session?.idleTimer) clearTimeout(session.idleTimer);
    if (session) {
      session.pollTimer = null;
      session.idleTimer = null;
    }
    if (session?.hotkeyRegistered) {
      try {
        globalShortcut.unregister(STOP_HOTKEY);
      } catch {
        // The key is released when the app quits either way.
      }
      session.hotkeyRegistered = false;
    }
    if (!target || target.isDestroyed()) return;
    target.webContents.off("input-event", onInputEvent);
    target.webContents.off("did-finish-load", onPageLoaded);
    target.off("closed", onWindowClosed);
  }

  function teardown(reason) {
    if (!session) return;
    const target = session.window;
    detach(target);
    if (!session.ended && target && !target.isDestroyed()) {
      void runInOverlay(target, "window.__agentOverlay && window.__agentOverlay.remove()").catch(() => {});
    }
    log(`Agent window control: stopped. ${reason}`);
    session = null;
  }

  // Every command is a heartbeat. An agent that stops sending them loses the window after the
  // idle limit, so an overlay can never outlive the agent behind it.
  function touch() {
    session.lastCommandAt = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => teardown("No command arrived within the idle limit."),
      session.idleExitMs
    );
  }

  function blocked() {
    if (!session) return result(CODE.usage, "Not started. Run start first.");
    if (session.ended) return result(CODE.user, "The user ended the agent's control of Arco. Run stop and hand back.");
    if (session.paused) return result(CODE.user, `The user paused the agent. ${session.pauseReason}`.trim());
    return null;
  }

  function startingPointer(target) {
    const bounds = target.getContentBounds();
    const cursor = screen?.getCursorScreenPoint?.();
    if (cursor) {
      const x = cursor.x - bounds.x;
      const y = cursor.y - bounds.y;
      if (x >= 0 && y >= 0 && x < bounds.width && y < bounds.height) return { x, y };
    }
    return { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2) };
  }

  async function start(args) {
    if (session?.ended) return blocked();
    if (session?.paused) return blocked();
    const target = resolveWindow(args.window);
    if (!target || target.isDestroyed()) return result(CODE.refused, `No Arco window matches "${args.window || "main"}".`);
    if (session && session.window !== target) teardown("Moved to another window.");
    const position = POSITIONS.has(String(args.position)) ? String(args.position) : "TopCenter";
    const idleMinutes = toNumber(args.idleExitMinutes) || DEFAULT_IDLE_EXIT_MINUTES;
    if (!session) {
      session = {
        window: target,
        startedAt: Date.now(),
        pointer: startingPointer(target),
        paused: false,
        pauseReason: "",
        ended: false,
        bannerRect: null,
      };
      attach(target);
    }
    Object.assign(session, {
      agent: String(args.agent || "Agent"),
      action: String(args.action || ""),
      position,
      showPointer: args.noPointer !== true,
      idleExitMs: idleMinutes * 60000,
    });
    touch();
    await ensureCapturable(target);
    await pushOverlay();
    log(`Agent window control: ${session.agent} took window ${target.id}.`);
    return result(CODE.done, `In control of window ${target.id} (${target.getTitle()}).`, { window: describeWindow(target) });
  }

  async function stop() {
    if (!session) return result(CODE.done, "Not in control.");
    teardown("The agent stopped.");
    return result(CODE.done, "Control handed back.");
  }

  function status() {
    if (!session) return result(CODE.usage, "Not started.");
    const info = {
      agent: session.agent,
      action: session.action,
      paused: session.paused,
      ended: session.ended,
      reason: session.pauseReason,
      window: session.window.isDestroyed() ? null : describeWindow(session.window),
      pointer: session.pointer,
      stopKey: session.hotkeyRegistered ? STOP_HOTKEY_LABEL : "",
      seconds: Math.round((Date.now() - session.startedAt) / 1000),
    };
    const stopped = blocked();
    return stopped ? { ...stopped, ...info } : result(CODE.done, "In control.", info);
  }

  async function setAction(args) {
    const stopped = blocked();
    if (stopped) return stopped;
    if (args.action != null) session.action = String(args.action);
    await pushOverlay();
    return result(CODE.done, "Action updated.");
  }

  // ---- pointer ----

  function checkPoint(x, y, label = "Point") {
    if (x == null || y == null) return result(CODE.usage, `${label} needs -X and -Y.`);
    const size = contentSize(session.window);
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
      return result(CODE.refused, `${label} (${x}, ${y}) is outside the window, which is ${size.width} x ${size.height}.`);
    }
    const r = session.bannerRect;
    if (r && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height) {
      return result(CODE.refused, `${label} (${x}, ${y}) is under the agent banner. Move it with start -Position.`);
    }
    return null;
  }

  // Glides the pointer to a point, moving the page's pointer with it so hover states follow.
  // Returns false when the person paused the agent on the way.
  async function glideTo(x, y, { holding = false } = {}) {
    const from = session.pointer;
    const glide = createGlide(from.x, from.y, x, y);
    const startedAt = Date.now();
    for (;;) {
      if (session.paused || session.ended) return false;
      const elapsed = Date.now() - startedAt;
      const p = glide.at(elapsed);
      session.pointer = { x: p.x, y: p.y };
      const event = { type: "mouseMove", x: Math.round(p.x), y: Math.round(p.y), modifiers: [] };
      if (holding) Object.assign(event, { button: "left", modifiers: ["leftButtonDown"] });
      inject(event);
      void callOverlay("frame", session.pointer);
      if (elapsed >= glide.durationMs) return true;
      await sleep(FRAME_MS);
    }
  }

  async function hit(x, y) {
    return (await callOverlay("describe", { x, y })) || { element: "", frames: [] };
  }

  async function pointerCommand(args, run) {
    const stopped = blocked();
    if (stopped) return stopped;
    if (args.action != null) session.action = String(args.action);
    await pushOverlay();
    return run();
  }

  async function move(args) {
    const x = toNumber(args.x);
    const y = toNumber(args.y);
    return pointerCommand(args, async () => {
      const bad = checkPoint(x, y);
      if (bad) return bad;
      if (!(await glideTo(x, y))) return blocked();
      return result(CODE.done, `Pointer at (${x}, ${y}).`, { hit: await hit(x, y) });
    });
  }

  async function click(args) {
    const x = toNumber(args.x);
    const y = toNumber(args.y);
    const kind = String(args.button || "Left").toLowerCase();
    if (!["left", "right", "double"].includes(kind)) return result(CODE.usage, "-Button must be Left, Right, or Double.");
    return pointerCommand(args, async () => {
      const bad = checkPoint(x, y);
      if (bad) return bad;
      if (!(await glideTo(x, y))) return blocked();
      const target = await hit(x, y);
      if (session.paused || session.ended) return blocked();
      const button = kind === "right" ? "right" : "left";
      void callOverlay("press");
      const presses = kind === "double" ? 2 : 1;
      for (let count = 1; count <= presses; count += 1) {
        inject({ type: "mouseDown", x, y, button, clickCount: count });
        await sleep(55);
        inject({ type: "mouseUp", x, y, button, clickCount: count });
        if (count < presses) await sleep(70);
      }
      return result(CODE.done, `${args.button || "Left"} click at (${x}, ${y}).`, { hit: target });
    });
  }

  async function drag(args) {
    const x = toNumber(args.x);
    const y = toNumber(args.y);
    const toX = toNumber(args.toX);
    const toY = toNumber(args.toY);
    return pointerCommand(args, async () => {
      const bad = checkPoint(x, y, "Start") || checkPoint(toX, toY, "End");
      if (bad) return bad;
      if (!(await glideTo(x, y))) return blocked();
      const from = await hit(x, y);
      void callOverlay("press");
      inject({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      session.dragging = true;
      await sleep(80);
      const finished = await glideTo(toX, toY, { holding: true });
      session.dragging = false;
      // Let go wherever the pointer is, so a paused drag never leaves the button held.
      const at = { x: Math.round(session.pointer.x), y: Math.round(session.pointer.y) };
      inject({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
      if (!finished) return { ...blocked(), message: `${blocked().message} The drag was let go at (${at.x}, ${at.y}).` };
      return result(CODE.done, `Dragged from (${x}, ${y}) to (${toX}, ${toY}).`, { hit: from });
    });
  }

  async function scroll(args) {
    const x = toNumber(args.x);
    const y = toNumber(args.y);
    const delta = toNumber(args.delta) ?? 0;
    return pointerCommand(args, async () => {
      const bad = checkPoint(x, y);
      if (bad) return bad;
      if (!delta) return result(CODE.usage, "scroll needs -Delta (positive scrolls down).");
      if (!(await glideTo(x, y))) return blocked();
      // Chromium counts wheel deltas upward; the client counts them downward like a page.
      inject({ type: "mouseWheel", x, y, deltaX: 0, deltaY: -delta, canScroll: true });
      return result(CODE.done, `Scrolled ${delta} at (${x}, ${y}).`, { hit: await hit(x, y) });
    });
  }

  // ---- keyboard ----

  async function typeText(args) {
    const text = String(args.text ?? "");
    if (!text) return result(CODE.usage, "type needs -Text.");
    return pointerCommand(args, async () => {
      let typed = 0;
      for (const ch of text) {
        if (session.paused || session.ended) {
          return { ...blocked(), message: `${blocked().message} Typed ${typed} of ${[...text].length} characters.` };
        }
        for (const event of charEvents(ch)) inject(event);
        typed += 1;
        await sleep(18);
      }
      return result(CODE.done, `Typed ${typed} characters.`);
    });
  }

  async function pressKey(args) {
    const chord = parseKeyChord(args.key);
    if (!chord) return result(CODE.usage, `Cannot read key "${args.key || ""}". Use a form such as Enter, Ctrl+S, or Shift+Tab.`);
    return pointerCommand(args, async () => {
      const { keyCode, modifiers } = chord;
      inject({ type: "keyDown", keyCode, modifiers });
      // Enter also needs its character for a text box or a form to act on it.
      if (keyCode === "Enter" && !modifiers.some((m) => m === "control" || m === "alt" || m === "meta")) {
        inject({ type: "char", keyCode: "\r", modifiers });
      }
      inject({ type: "keyUp", keyCode, modifiers });
      return result(CODE.done, `Pressed ${args.key}.`);
    });
  }

  // ---- looking ----

  function listWindows() {
    return result(CODE.done, "Arco windows.", { windows: liveWindows().map(describeWindow) });
  }

  async function screenshot(args) {
    const target = session && !session.window.isDestroyed() && !args.window ? session.window : resolveWindow(args.window);
    if (!target || target.isDestroyed()) return result(CODE.refused, `No Arco window matches "${args.window || "main"}".`);
    const outPath = String(args.out || "").trim();
    if (!outPath) return result(CODE.usage, "screenshot needs -Out <png>.");
    const zoomOut = toNumber(args.zoom) || 1;
    const size = contentSize(target);
    let rect = null;
    if (args.width != null || args.height != null) {
      rect = {
        x: Math.max(0, Math.round(toNumber(args.x) || 0)),
        y: Math.max(0, Math.round(toNumber(args.y) || 0)),
        width: Math.round(toNumber(args.width) || 0),
        height: Math.round(toNumber(args.height) || 0),
      };
      if (rect.width <= 0 || rect.height <= 0) return result(CODE.usage, "A region needs a positive -Width and -Height.");
    }
    const hideOverlay = session && session.window === target && !session.ended && args.showOverlay !== true;
    await ensureCapturable(target);
    if (hideOverlay) await callOverlay("setCaptureHidden", true);
    let image;
    try {
      image = rect ? await target.webContents.capturePage(rect) : await target.webContents.capturePage();
    } finally {
      if (hideOverlay) void callOverlay("setCaptureHidden", false);
    }
    // Save at window pixels times the zoom, so a point in an unzoomed image is the point to click.
    const logical = rect || { x: 0, y: 0, ...size };
    const width = Math.max(1, Math.round(logical.width * zoomOut));
    const height = Math.max(1, Math.round(logical.height * zoomOut));
    const captured = image.getSize();
    if (!captured.width || !captured.height) return result(CODE.refused, "Captured an empty frame. Is the window on screen?");
    if (captured.width !== width || captured.height !== height) image = image.resize({ width, height, quality: "best" });
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, image.toPNG());
    if (session && session.window === target) touch();
    return result(CODE.done, `Saved ${width} x ${height}.`, {
      path: path.resolve(outPath),
      origin: { x: logical.x, y: logical.y },
      zoom: zoomOut,
      window: describeWindow(target),
    });
  }

  // ---- transport ----

  const COMMANDS = {
    windows: listWindows,
    screenshot,
    start,
    stop,
    status,
    action: setAction,
    move,
    click,
    drag,
    scroll,
    type: typeText,
    key: pressKey,
  };
  // Commands that act for the agent count as a heartbeat; looking does not need a session.
  const HEARTBEAT = new Set(["status", "action", "move", "click", "drag", "scroll", "type", "key"]);

  async function runCommand(payload) {
    const name = String(payload?.command || "").trim();
    const handler = COMMANDS[name];
    if (!handler) return result(CODE.usage, `Unknown command "${name}".`);
    if (HEARTBEAT.has(name) && session && !session.ended) touch();
    try {
      return await handler(payload || {});
    } catch (err) {
      log(`Agent window control: ${name} failed`, err);
      return result(CODE.refused, String(err?.message || err || `${name} failed.`));
    }
  }

  function tokenMatches(header) {
    const given = Buffer.from(String(header || ""));
    const expected = Buffer.from(token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  function handleRequest(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/command") return reply(404, result(CODE.usage, "Not found."));
    if (!tokenMatches(req.headers["x-agent-control-token"])) return reply(403, result(CODE.usage, "Bad token."));
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return reply(400, result(CODE.usage, "The request body is not JSON."));
      }
      // One command at a time, in arrival order.
      queue = queue.then(() => runCommand(payload)).then((answer) => reply(200, answer));
    });
  }

  function listen() {
    token = crypto.randomBytes(24).toString("hex");
    server = http.createServer(handleRequest);
    server.on("error", (err) => log("Agent window control: endpoint failed", err));
    server.listen(0, "127.0.0.1", () => {
      try {
        publishAppEntry(entryPath, {
          format: ENTRY_FORMAT,
          app: appMode,
          pid: process.pid,
          port: server.address().port,
          token,
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        log("Agent window control: could not publish the endpoint", err);
      }
    });
  }

  function dispose() {
    if (session) teardown("Arco is closing.");
    if (server) server.close();
    server = null;
    unpublishAppEntry(entryPath, process.pid);
  }

  return { listen, dispose, runCommand };
}

module.exports = {
  createAgentWindowControl,
  // Exported for tests.
  createGlide,
  parseKeyChord,
  charEvents,
  isUserInput,
  CODE,
  ENTRY_FORMAT,
};
