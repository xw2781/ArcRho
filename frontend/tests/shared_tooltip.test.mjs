import assert from "node:assert/strict";
import test from "node:test";

import { attachArcrhoTooltip } from "../ui/shared/components/tooltip/tooltip.js";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

function createTooltipDocument() {
  const byId = new Map();
  const timers = [];
  const doc = {
    defaultView: {
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout(timerId) {
        timers[timerId - 1] = null;
      },
      innerWidth: 1200,
      innerHeight: 800,
    },
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    head: {},
    body: {
      appendChild(element) {
        element.isConnected = true;
        if (element.id) byId.set(element.id, element);
      },
    },
    getElementById(id) {
      return byId.get(id) || null;
    },
    querySelectorAll() {
      return [{ getAttribute: () => "/ui/shared/styles/tooltips.css" }];
    },
    createElement() {
      return {
        id: "",
        className: "",
        classList: new FakeClassList(),
        isConnected: false,
        style: {},
        textContent: "",
        attributes: new Map(),
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        getBoundingClientRect() {
          return { width: 80, height: 20 };
        },
      };
    },
    runNextTimer() {
      const callback = timers.shift();
      callback?.();
    },
  };
  return doc;
}

test("shared tooltips resolve dynamic text for hover and keyboard focus", async () => {
  const doc = createTooltipDocument();
  const listeners = new Map();
  const attributes = new Map();
  const target = {
    ownerDocument: doc,
    isConnected: true,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getBoundingClientRect() {
      return { left: 100, top: 100, right: 220, bottom: 120, width: 120, height: 20 };
    },
  };

  let calls = 0;
  attachArcrhoTooltip(target, async () => {
    calls += 1;
    return 1.0026;
  }, { document: doc });

  listeners.get("mouseenter")();
  doc.runNextTimer();
  await Promise.resolve();
  await Promise.resolve();

  const tooltip = doc.getElementById("arcrho-shared-tooltip");
  assert.equal(calls, 1);
  assert.equal(tooltip.textContent, "1.0026");
  assert.equal(tooltip.classList.contains("is-open"), true);
  assert.equal(attributes.get("aria-description"), "1.0026");

  listeners.get("mouseleave")();
  listeners.get("focus")();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(tooltip.textContent, "1.0026");
});
