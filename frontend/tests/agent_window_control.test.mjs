import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createAgentWindowControl,
  createGlide,
  parseKeyChord,
  charEvents,
  isUserInput,
  CODE,
} = require("../electron/agent_control/agent_control_host.js");

// A window whose page reports every input event synchronously while it is being sent, as
// Chromium does, and whose overlay answers the calls the host makes.
function fakeWindow({ width = 800, height = 600 } = {}) {
  const contents = new EventEmitter();
  contents.sent = [];
  contents.sendInputEvent = (event) => {
    contents.sent.push(event);
    contents.emit("input-event", {}, { type: event.type === "keyDown" ? "rawKeyDown" : event.type });
  };
  contents.getZoomFactor = () => 1;
  contents.setBackgroundThrottling = () => {};
  contents.executeJavaScriptInIsolatedWorld = async (_world, [{ code }]) => {
    if (code.includes(".apply(")) return { x: 300, y: 40, width: 200, height: 30 };
    if (code.includes(".describe(")) return { element: "button#ok", frames: [] };
    return true;
  };
  const target = new EventEmitter();
  Object.assign(target, {
    id: 7,
    webContents: contents,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getTitle: () => "Arco Workspace",
    getContentBounds: () => ({ x: 0, y: 0, width, height }),
  });
  return target;
}

function setup() {
  const target = fakeWindow();
  const control = createAgentWindowControl({
    BrowserWindow: { getAllWindows: () => [target], fromId: () => target },
    globalShortcut: { register: () => true, unregister: () => {} },
    screen: null,
    getMainWindow: () => target,
    getArcodeWindow: () => null,
  });
  // The person's own input reaches the page outside any send.
  const userInput = (type) => target.webContents.emit("input-event", {}, { type });
  return { target, control, run: (payload) => control.runCommand(payload), userInput };
}

test("a glide starts and ends where asked and takes longer for longer reaches", () => {
  const short = createGlide(0, 0, 40, 0, () => 0.5);
  const long = createGlide(0, 0, 1200, 300, () => 0.5);
  assert.deepEqual(short.at(0), { x: 0, y: 0 });
  const end = long.at(long.durationMs);
  assert.ok(Math.abs(end.x - 1200) < 1e-9 && Math.abs(end.y - 300) < 1e-9);
  assert.ok(short.durationMs < long.durationMs);
  assert.ok(short.durationMs >= 180 && long.durationMs <= 950);
  assert.equal(createGlide(5, 5, 5, 5).durationMs, 0);
});

test("key chords and typed characters become Chromium key events", () => {
  assert.deepEqual(parseKeyChord("Ctrl+Shift+s"), { keyCode: "S", modifiers: ["control", "shift"] });
  assert.deepEqual(parseKeyChord("esc"), { keyCode: "Escape", modifiers: [] });
  assert.equal(parseKeyChord("Hyper+X"), null);
  assert.deepEqual(charEvents("A").map((e) => e.modifiers), [["shift"], ["shift"], ["shift"]]);
  assert.deepEqual(charEvents("\n").map((e) => e.keyCode), ["Enter", "\r", "Enter"]);
});

test("only clicks, keys and wheel turns count as a person acting, plus motion during a drag", () => {
  assert.equal(isUserInput({ type: "mouseDown" }), true);
  assert.equal(isUserInput({ type: "rawKeyDown" }), true);
  assert.equal(isUserInput({ type: "mouseWheel" }), true);
  assert.equal(isUserInput({ type: "mouseMove" }), false);
  assert.equal(isUserInput({ type: "gestureScrollBegin" }), false);
  assert.equal(isUserInput({ type: "mouseMove" }, { dragging: true }), true);
});

test("the agent's own input never pauses it; the person's click does", async () => {
  const { target, run, userInput } = setup();
  assert.equal((await run({ command: "click", x: 400, y: 300 })).code, CODE.usage);
  assert.equal((await run({ command: "start", agent: "Test" })).code, CODE.done);

  const clicked = await run({ command: "click", x: 400, y: 300 });
  assert.equal(clicked.code, CODE.done);
  assert.deepEqual(clicked.hit, { element: "button#ok", frames: [] });
  assert.deepEqual(target.webContents.sent.slice(-2).map((e) => e.type), ["mouseDown", "mouseUp"]);
  assert.equal((await run({ command: "key", key: "Enter" })).code, CODE.done);
  assert.equal((await run({ command: "status" })).paused, false);

  userInput("mouseMove");
  assert.equal((await run({ command: "status" })).paused, false);

  userInput("mouseDown");
  const sentBefore = target.webContents.sent.length;
  const refused = await run({ command: "click", x: 400, y: 300 });
  assert.equal(refused.code, CODE.user);
  assert.match(refused.message, /You clicked/);
  assert.equal(target.webContents.sent.length, sentBefore);

  assert.equal((await run({ command: "stop" })).code, CODE.done);
  assert.equal((await run({ command: "status" })).code, CODE.usage);
});

test("points outside the window or under the banner are refused", async () => {
  const { run } = setup();
  await run({ command: "start" });
  assert.equal((await run({ command: "click", x: 900, y: 10 })).code, CODE.refused);
  assert.equal((await run({ command: "click", x: 350, y: 50 })).code, CODE.refused);
  await run({ command: "stop" });
});
