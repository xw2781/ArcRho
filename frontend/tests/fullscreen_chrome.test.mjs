import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readFileSync } from "node:fs";

// Full screen hides the shell title bar, menu bar and tab strip, and brings them back over the
// page while the pointer rests on the top edge.

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  toggle(name, on) { if (on) this.add(name); else this.remove(name); }
  contains(name) { return this.names.has(name); }
}

class FakeElement {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(fn); }
  dispatch(type, event = {}) { (this.listeners.get(type) || []).slice().forEach((fn) => fn(event)); }
  contains(node) { return node === this; }
}

const elements = {
  customTitlebar: new FakeElement(),
  menubar: new FakeElement(),
};
const topbar = new FakeElement();
let openMenu = null;

const documentListeners = new FakeElement();
globalThis.window = {};
globalThis.document = {
  body: { classList: new FakeClassList() },
  activeElement: null,
  getElementById: (id) => elements[id] || null,
  querySelector: (selector) => (selector === ".topbar" ? topbar : openMenu),
  addEventListener: (type, fn) => documentListeners.addEventListener(type, fn),
};

const { initFullscreenChrome, isFullscreenChromeActive, setFullscreenChrome } =
  await import("../ui/shell/fullscreen_chrome.js");

const body = globalThis.document.body.classList;
const menubar = elements.menubar;
const tabStrip = topbar;
const movePointerTo = (clientY) => documentListeners.dispatch("pointermove", { clientY });

initFullscreenChrome();

test("entering full screen takes the chrome out of the page and leaving puts it back", () => {
  setFullscreenChrome(true);
  assert.equal(isFullscreenChromeActive(), true);
  assert.equal(body.contains("app-fullscreen"), true);
  assert.equal(body.contains("chrome-revealed"), false);

  setFullscreenChrome(false);
  assert.equal(body.contains("app-fullscreen"), false);
});

test("the top edge reveals the chrome and moving away hides it again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { setFullscreenChrome(false); mock.timers.reset(); });

  setFullscreenChrome(true);
  movePointerTo(40);
  assert.equal(body.contains("chrome-revealed"), false, "the pointer must reach the top edge");
  movePointerTo(1);
  assert.equal(body.contains("chrome-revealed"), true);

  menubar.dispatch("pointerenter");
  menubar.dispatch("pointerleave");
  assert.equal(body.contains("chrome-revealed"), true, "the chrome waits before hiding");

  t.mock.timers.tick(1000);
  assert.equal(body.contains("chrome-revealed"), false);
});

test("the tab strip joins the chrome and keeps it in place while the pointer is on it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { setFullscreenChrome(false); mock.timers.reset(); });

  setFullscreenChrome(true);
  movePointerTo(1);
  tabStrip.dispatch("pointerenter");
  t.mock.timers.tick(5000);
  assert.equal(body.contains("chrome-revealed"), true, "the tab strip holds the chrome open");

  tabStrip.dispatch("pointerleave");
  t.mock.timers.tick(1000);
  assert.equal(body.contains("chrome-revealed"), false);
});

test("a tab being dragged keeps the chrome in place", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { body.remove("tab-dragging"); setFullscreenChrome(false); mock.timers.reset(); });

  setFullscreenChrome(true);
  movePointerTo(1);
  body.add("tab-dragging");
  tabStrip.dispatch("pointerenter");
  tabStrip.dispatch("pointerleave");
  t.mock.timers.tick(5000);
  assert.equal(body.contains("chrome-revealed"), true, "a dragged tab holds the chrome open");

  body.remove("tab-dragging");
  t.mock.timers.tick(1000);
  assert.equal(body.contains("chrome-revealed"), false);
});

test("an open menu keeps the chrome in place until the menu closes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => { openMenu = null; setFullscreenChrome(false); mock.timers.reset(); });

  setFullscreenChrome(true);
  movePointerTo(1);
  openMenu = new FakeElement();
  menubar.dispatch("pointerenter");
  menubar.dispatch("pointerleave");

  t.mock.timers.tick(5000);
  assert.equal(body.contains("chrome-revealed"), true, "a dropped-down menu holds the chrome open");

  openMenu = null;
  t.mock.timers.tick(1000);
  assert.equal(body.contains("chrome-revealed"), false);
});

test("leaving full screen while the chrome is revealed clears both states", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  setFullscreenChrome(true);
  movePointerTo(1);
  setFullscreenChrome(false);
  assert.equal(body.contains("app-fullscreen"), false);
  assert.equal(body.contains("chrome-revealed"), false);
});

test("the host tells the page when the window enters or leaves full screen", () => {
  const main = read("../electron/main.js");
  // Each event carries its own answer: the window still reports the state it is leaving here.
  assert.match(main, /targetWindow\.on\("enter-full-screen", \(\) => sendFullscreenState\(true\)\)/u);
  assert.match(main, /targetWindow\.on\("leave-full-screen", \(\) => sendFullscreenState\(false\)\)/u);
  assert.doesNotMatch(main, /fullscreen: targetWindow\.isFullScreen\(\)/u);
  assert.match(main, /\$\{prefix\}:fullscreen-change/u);

  const preload = read("../electron/preload.js");
  assert.match(preload, /ipcRenderer\.on\("arcrho:fullscreen-change"/u);
  assert.match(preload, /ipcRenderer\.on\("arcode:fullscreen-change"/u);

  const messages = read("../ui/shell/shell_messages.js");
  assert.match(messages, /arcrho:fullscreen-change.*setFullscreenChrome/u);
});

test("the stylesheet floats the chrome over the page only in full screen", () => {
  const css = read("../ui/shell/shell.css");
  assert.match(css, /body\.app-fullscreen \{\s*padding-top: 0;/u);
  assert.match(css, /body\.app-fullscreen #customTitlebar,\s*body\.app-fullscreen \.menubar,\s*body\.app-fullscreen \.topbar \{[^}]*position: fixed;/u);
  assert.match(css, /transform: translateY\(calc\(-1 \* var\(--shell-chrome-h\)\)\)/u);
  assert.match(css, /body\.app-fullscreen \.topbar \{[^}]*top: calc\(var\(--titlebar-h\) \+ var\(--menubar-h\)\);/u);
  assert.match(css, /body\.app-fullscreen\.chrome-revealed #customTitlebar,\s*body\.app-fullscreen\.chrome-revealed \.menubar,\s*body\.app-fullscreen\.chrome-revealed \.topbar \{[^}]*transform: translateY\(0\)/u);
  // The row heights stay one value each, shared by the docked layout and the full-screen slide.
  assert.match(css, /--titlebar-h: 30px;/u);
  assert.match(css, /--menubar-h: 25px;/u);
  assert.match(css, /--topbar-h: 34px;/u);
  assert.match(css, /--shell-chrome-h: calc\(var\(--titlebar-h\) \+ var\(--menubar-h\) \+ var\(--topbar-h\)\);/u);

  // Nothing is pinned over the top edge, so a click on the top pixels of a tab still lands.
  const index = read("../ui/index.html");
  assert.doesNotMatch(index, /fullscreenPeekZone/u);
});
