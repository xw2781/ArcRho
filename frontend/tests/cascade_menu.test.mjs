import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const declarationsFor = (css, selector) => [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1].trim() === selector)
  .map((match) => match[2])
  .join("\n");

class StubClassList {
  constructor(owner) {
    this.owner = owner;
  }

  contains(name) {
    return this.owner.classes.has(name);
  }

  add(name) {
    this.owner.classes.add(name);
  }

  remove(name) {
    this.owner.classes.delete(name);
  }

  toggle(name, force) {
    if (force) this.add(name);
    else this.remove(name);
  }
}

class StubElement {
  constructor(classes = [], rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) {
    this.classes = new Set(classes);
    this.classList = new StubClassList(this);
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.rect = rect;
    this.customProperties = new Map();
    this.style = {
      setProperty: (name, value) => this.customProperties.set(name, value),
      removeProperty: (name) => this.customProperties.delete(name),
    };
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  matchesClasses(selector) {
    return selector
      .split(".")
      .filter(Boolean)
      .every((name) => this.classes.has(name));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matchesClasses(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    const wanted = selector.replace(":scope > ", "");
    return this.children.find((child) => child.matchesClasses(wanted)) || null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}

/**
 * Loads the controller into a stubbed document so the grace period and the
 * approach corridor can be driven deterministically.
 */
function loadController() {
  const source = read("../ui/shared/components/cascade_menu/cascade_menu.js").replace(/^export /gm, "");
  const listeners = new Map();
  const timers = [];
  let nextTimerId = 1;

  const windowStub = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
  };
  const documentStub = {
    defaultView: windowStub,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };

  const context = vm.createContext({
    document: documentStub,
    window: windowStub,
    Element: StubElement,
    setTimeout: (callback, delayMs) => {
      const id = nextTimerId++;
      timers.push({ id, callback, delayMs });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  vm.runInContext(source, context);
  vm.runInContext("initCascadeMenus()", context);

  return {
    window: windowStub,
    pendingDelay: () => (timers.length === 0 ? null : timers[timers.length - 1].delayMs),
    runTimers: () => {
      while (timers.length > 0) timers.shift().callback();
    },
    fire: (type, target, point = { x: 0, y: 0 }) => {
      listeners.get(type)?.({ target, clientX: point.x, clientY: point.y });
    },
  };
}

function buildMenu() {
  const dropdown = new StubElement(["menuDropdown"], { left: 100, right: 360, top: 100, bottom: 300, width: 260, height: 200 });
  const parentItem = new StubElement(["menuItem", "hasSubmenu"], { left: 106, right: 354, top: 106, bottom: 139, width: 248, height: 33 });
  parentItem.setAttribute("aria-expanded", "false");
  const submenu = new StubElement(["menuSubmenu"], { left: 366, right: 646, top: 100, bottom: 210, width: 280, height: 110 });
  const siblingItem = new StubElement(["menuItem"], { left: 106, right: 354, top: 145, bottom: 178, width: 248, height: 33 });
  dropdown.append(parentItem);
  dropdown.append(siblingItem);
  parentItem.append(submenu);
  return { dropdown, parentItem, submenu, siblingItem };
}

test("cascade geometry and the hover bridge have one owner", () => {
  const cascade = read("../ui/shared/styles/cascade_menu.css");
  const shell = read("../ui/shell/shell.css");
  const arcode = read("../ui/arcode/main.css");

  const submenuRules = declarationsFor(cascade, ".menuSubmenu");
  assert.match(submenuRules, /position:\s*absolute/);
  assert.match(submenuRules, /left:\s*100%/);
  assert.match(submenuRules, /margin-left:\s*var\(--ar-menu-cascade-gap\)/);

  // The gap between the parent row and the submenu is painted, never a dead
  // pointer zone: the bridge belongs to the submenu's own hit area.
  const bridge = declarationsFor(cascade, ".menuSubmenu::before");
  assert.match(bridge, /right:\s*100%/);
  assert.match(bridge, /width:\s*calc\(var\(--ar-menu-cascade-gap\) \+ 2px\)/);
  assert.match(cascade, /\.menuItem\.hasSubmenu\.menuSubmenuOpen:not\(\.disabled\) > \.menuSubmenu \{\s*display: block;/);

  for (const [name, css] of [["shell.css", shell], ["arcode/main.css", arcode]]) {
    const local = declarationsFor(css, ".menuSubmenu");
    assert.doesNotMatch(local, /position:/, `${name} leaves cascade placement to the shared owner`);
    assert.doesNotMatch(local, /(^|\s)left:/, `${name} leaves cascade placement to the shared owner`);
    assert.doesNotMatch(local, /(^|\s)top:/, `${name} leaves cascade placement to the shared owner`);
  }
});

test("both application shells load the shared cascade stylesheet and controller", () => {
  for (const path of ["../ui/index.html", "../ui/arcode/main.html"]) {
    assert.match(read(path), /shared\/styles\/cascade_menu\.css\?v=20260817a/);
  }
  assert.match(read("../ui/shell/shell_menus.js"), /initCascadeMenus\(\)/);
  assert.match(read("../ui/shell/shell_menus.js"), /closeAllShellMenus\(\) \{\s*closeAllCascadeSubmenus\(\);/);
  assert.match(read("../ui/arcode/main.js"), /initCascadeMenus\(\)/);
  assert.match(read("../ui/arcode/main.js"), /closeAllShellMenus\(\) \{\s*closeAllCascadeSubmenus\(\);/);
  // Pointer and keyboard opening share one state class.
  assert.match(read("../ui/shared/services/color_theme.js"), /THEME_MENU_OPEN_CLASS = "menuSubmenuOpen"/);
});

test("hovering a parent row opens its submenu and marks it expanded", () => {
  const controller = loadController();
  const { parentItem, submenu } = buildMenu();

  controller.fire("pointerover", parentItem, { x: 200, y: 120 });

  assert.ok(parentItem.classList.contains("menuSubmenuOpen"));
  assert.equal(parentItem.getAttribute("aria-expanded"), "true");
  assert.ok(!submenu.classList.contains("menuSubmenuFlip"), "a submenu that fits stays on the right");
});

test("leaving the parent row keeps the submenu open through the grace period", () => {
  const controller = loadController();
  const { parentItem, siblingItem } = buildMenu();

  controller.fire("pointerover", parentItem, { x: 200, y: 120 });
  controller.fire("pointerover", siblingItem, { x: 200, y: 160 });

  assert.ok(parentItem.classList.contains("menuSubmenuOpen"), "the submenu survives a momentary exit");
  assert.equal(controller.pendingDelay(), 260);

  controller.runTimers();
  assert.ok(!parentItem.classList.contains("menuSubmenuOpen"));
  assert.equal(parentItem.getAttribute("aria-expanded"), "false");
});

test("a diagonal approach across sibling rows re-arms the grace period", () => {
  const controller = loadController();
  const { parentItem, siblingItem } = buildMenu();

  controller.fire("pointerover", parentItem, { x: 200, y: 120 });
  controller.fire("pointerover", siblingItem, { x: 250, y: 150 });
  assert.equal(controller.pendingDelay(), 260);

  // Down and to the right, aimed at the lower rows of the submenu.
  controller.fire("pointermove", siblingItem, { x: 250, y: 150 });
  controller.fire("pointermove", siblingItem, { x: 300, y: 175 });

  assert.equal(controller.pendingDelay(), 320, "the corridor extends the grace period");
  assert.ok(parentItem.classList.contains("menuSubmenuOpen"));
});

test("moving away from the submenu does not extend the grace period", () => {
  const controller = loadController();
  const { parentItem, siblingItem } = buildMenu();

  controller.fire("pointerover", parentItem, { x: 200, y: 120 });
  controller.fire("pointerover", siblingItem, { x: 250, y: 150 });

  controller.fire("pointermove", siblingItem, { x: 250, y: 150 });
  controller.fire("pointermove", siblingItem, { x: 180, y: 175 });

  assert.equal(controller.pendingDelay(), 260, "a pointer heading away closes on the normal delay");
});

test("reaching the submenu cancels the pending close", () => {
  const controller = loadController();
  const { parentItem, submenu, siblingItem } = buildMenu();

  controller.fire("pointerover", parentItem, { x: 200, y: 120 });
  controller.fire("pointerover", siblingItem, { x: 250, y: 150 });
  assert.equal(controller.pendingDelay(), 260);

  controller.fire("pointerover", submenu, { x: 400, y: 160 });
  assert.equal(controller.pendingDelay(), null, "no close is pending once the pointer arrives");
  assert.ok(parentItem.classList.contains("menuSubmenuOpen"));
});

test("a submenu that would leave the window flips to the other side of its parent", () => {
  const controller = loadController();
  const { parentItem, submenu } = buildMenu();
  parentItem.rect = { left: 900, right: 1150, top: 106, bottom: 139, width: 250, height: 33 };
  submenu.rect = { left: 1162, right: 1442, top: 100, bottom: 210, width: 280, height: 110 };

  controller.fire("pointerover", parentItem, { x: 1000, y: 120 });

  assert.ok(submenu.classList.contains("menuSubmenuFlip"));
});

test("a pointer press outside the open branch closes the cascade at once", () => {
  const controller = loadController();
  const { parentItem, siblingItem } = buildMenu();

  controller.fire("pointerover", parentItem, { x: 200, y: 120 });
  controller.fire("pointerdown", siblingItem, { x: 200, y: 160 });

  assert.ok(!parentItem.classList.contains("menuSubmenuOpen"));
  assert.equal(controller.pendingDelay(), null);
});
