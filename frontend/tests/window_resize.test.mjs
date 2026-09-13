import assert from "node:assert/strict";
import test from "node:test";

// The shared floating-window resize helper: a dragged edge moves while the
// opposite edge stays put, the stylesheet's minimum bounds the shrink, and
// the viewport bounds the growth.

class FakeElement {
  constructor() { this.listeners = new Map(); this.children = []; this.captured = null; this.removed = false; }
  addEventListener(type, fn) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); }
  dispatch(type, event) { (this.listeners.get(type) || []).slice().forEach((fn) => fn(event)); }
  appendChild(child) { this.children.push(child); }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
  remove() { this.removed = true; }
}

globalThis.window = { innerWidth: 1000, innerHeight: 700 };
globalThis.document = { createElement: () => new FakeElement() };
globalThis.getComputedStyle = () => ({ minWidth: "520px", minHeight: "460px" });
const { makeWindowResizable } = await import("../ui/shared/components/floating_window/window_resize.js");

function setup() {
  const win = new FakeElement();
  win.getBoundingClientRect = () => ({ left: 100, top: 80, width: 600, height: 500 });
  const frames = [];
  const dispose = makeWindowResizable(win, { onFrame: (frame) => frames.push(frame) });
  const handle = (dir) => win.children.find((h) => h.className.endsWith(`arWindowResize-${dir}`));
  const drag = (dir, dx, dy) => {
    const h = handle(dir);
    h.dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    h.dispatch("pointermove", { pointerId: 7, clientX: dx, clientY: dy });
    h.dispatch("pointerup", { pointerId: 7 });
    return frames.at(-1);
  };
  return { win, frames, dispose, handle, drag };
}

test("every edge and corner gets a handle that captures its pointer", () => {
  const { win, handle, dispose } = setup();
  assert.equal(win.children.length, 8);
  const h = handle("se");
  h.dispatch("pointerdown", { button: 0, pointerId: 3, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
  assert.equal(h.captured, 3);
  // A second pointer cannot steer the drag.
  h.dispatch("pointermove", { pointerId: 4, clientX: 50, clientY: 50 });
  h.dispatch("pointerup", { pointerId: 3 });
  assert.equal(h.captured, null);
  dispose();
  assert.ok(win.children.every((child) => child.removed));
});

test("the dragged edge moves and the opposite edge stays put", () => {
  const { drag } = setup();
  assert.deepEqual(drag("e", 40, 0), { left: 100, top: 80, width: 640, height: 500 });
  assert.deepEqual(drag("w", 40, 0), { left: 140, top: 80, width: 560, height: 500 });
  assert.deepEqual(drag("n", 0, -30), { left: 100, top: 50, width: 600, height: 530 });
  assert.deepEqual(drag("sw", -20, 25), { left: 80, top: 80, width: 620, height: 525 });
});

test("the stylesheet minimum bounds the shrink and the viewport bounds the growth", () => {
  const { drag } = setup();
  // Shrinking past 520px wide from the west edge stops at 520 with the right edge at 700.
  assert.deepEqual(drag("w", 300, 0), { left: 180, top: 80, width: 520, height: 500 });
  assert.deepEqual(drag("s", 0, -200), { left: 100, top: 80, width: 600, height: 460 });
  // Growing east cannot pass the viewport's right edge (1000 - 100).
  assert.deepEqual(drag("e", 900, 0), { left: 100, top: 80, width: 900, height: 500 });
  // Growing north cannot pass the top of the viewport.
  assert.deepEqual(drag("n", 0, -500), { left: 100, top: 0, width: 600, height: 580 });
});
