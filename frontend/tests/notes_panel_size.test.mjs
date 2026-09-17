import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../ui/shared/tabs/notes/notes_tab.js", import.meta.url),
  "utf8",
);

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

// Run the production sizing closures with controlled layout and timers. The
// observer fires for hidden tabs and host resizes as well as native grip drags.
const createSizing = new Function("windowObject", "inputWrap", `
  const destroyed = false;
  ${sourceSlice("const NOTES_FONT_SIZE_STORAGE_KEY", "const AUTO_CLOSE_PAIRS")}
  ${sourceSlice("function clampInteger", "function rgbStringToHex")}
  ${sourceSlice("let panelSizeSaveTimer = null;", "// Where the mouse")}
  ${sourceSlice("const clearPanelSizeSaveTimer", "const setPlainTextMode")}
  return restoreNotesPanelSize().then(() => ({ resize: scheduleNotesPanelSizeSave }));
`);

// The desktop host's preference file, written whole on every save.
function createHost(size) {
  let stored = size ? { ...size } : null;
  const writes = [];
  return {
    writes,
    read: () => stored,
    async loadNotesPanelPreferences() {
      return { ok: true, exists: !!stored, preferences: stored || {} };
    },
    saveNotesPanelPreferences(next) {
      stored = { ...next };
      writes.push({ ...next });
      return { ok: true };
    },
  };
}

async function mount(host, { width = 0, height = 0, nested = false } = {}) {
  const timers = new Set();
  const panel = {
    style: { width: "", height: "" },
    offsetWidth: width,
    offsetHeight: height,
  };
  const windowObject = {
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  };
  if (nested) windowObject.top = { ADAHost: host };
  else windowObject.ADAHost = host;
  const controller = await createSizing(windowObject, panel);
  const resize = () => {
    controller.resize();
  };
  // The observer reports the rendered box once when it starts observing.
  resize();
  return {
    panel,
    resize,
    flush() {
      for (const callback of Array.from(timers)) {
        timers.delete(callback);
        callback();
      }
    },
  };
}

test("mounting a hidden Notes tab preserves the saved size for the next page", async () => {
  const saved = { width: 840, height: 420 };
  const host = createHost(saved);
  const hidden = await mount(host);
  hidden.resize();
  hidden.flush();

  assert.deepEqual(host.read(), saved);
  assert.equal(host.writes.length, 0);
  assert.deepEqual((await mount(host)).panel.style, { width: "840px", height: "420px" });
});

test("a nested page reaches the host through its top window", async () => {
  const host = createHost({ width: 840, height: 420 });
  const tab = await mount(host, { width: 840, height: 420, nested: true });

  assert.deepEqual(tab.panel.style, { width: "840px", height: "420px" });
  tab.panel.style.height = "500px";
  tab.resize();
  tab.flush();
  assert.deepEqual(host.writes, [{ width: 840, height: 500 }]);
});

test("without the desktop host the panel keeps its stylesheet size", async () => {
  const tab = await mount(null, { width: 960, height: 360 });
  tab.panel.style.height = "500px";
  tab.resize();
  tab.flush();

  assert.deepEqual(tab.panel.style, { width: "", height: "500px" });
});

test("a narrow host or tab hide never replaces the preferred dimensions", async () => {
  const saved = { width: 840, height: 420 };
  const host = createHost(saved);
  const tab = await mount(host, { width: 360, height: 420 });
  tab.resize();
  tab.flush();
  tab.panel.offsetWidth = 0;
  tab.panel.offsetHeight = 0;
  tab.resize();
  tab.flush();

  assert.deepEqual(host.read(), saved);
  assert.equal(host.writes.length, 0);
});

test("a grip resize persists its inline dimensions even if hidden before the save", async () => {
  const host = createHost({ width: 840, height: 420 });
  const tab = await mount(host, { width: 840, height: 420 });
  tab.panel.style.width = "760px";
  tab.panel.style.height = "460px";
  tab.panel.offsetWidth = 760;
  tab.resize();
  tab.panel.style.width = "780px";
  tab.panel.offsetWidth = 780;
  tab.resize();
  tab.panel.offsetWidth = 0;
  tab.panel.offsetHeight = 0;
  tab.resize();
  tab.flush();

  assert.deepEqual(host.writes, [{ width: 780, height: 460 }]);
  assert.deepEqual((await mount(host)).panel.style, { width: "780px", height: "460px" });
});

test("a height-only drag stores no width, so the next page keeps the stylesheet width", async () => {
  const host = createHost();
  const tab = await mount(host, { width: 960, height: 360 });
  tab.panel.style.height = "460px";
  tab.panel.offsetHeight = 460;
  tab.resize();
  tab.flush();

  assert.deepEqual(host.writes, [{ width: 0, height: 460 }]);
  assert.deepEqual((await mount(host)).panel.style, { width: "", height: "460px" });
});

test("a height adjustment in a window that clamps the panel keeps the remembered width", async () => {
  const host = createHost({ width: 840, height: 420 });
  const tab = await mount(host, { width: 500, height: 420 });
  // The browser sizes the drag from the 500px box the host rendered.
  tab.panel.style.width = "503px";
  tab.panel.style.height = "480px";
  tab.panel.offsetWidth = 500;
  tab.resize();
  tab.panel.style.width = "497px";
  tab.panel.offsetWidth = 497;
  tab.resize();
  tab.flush();

  assert.deepEqual(host.writes, [{ width: 840, height: 480 }]);
  assert.deepEqual(tab.panel.style, { width: "840px", height: "480px" });
  tab.panel.offsetWidth = 500;
  tab.resize();
  tab.flush();
  assert.equal(host.writes.length, 1);
});

test("a drag clearly narrower than the clamped width is a new width", async () => {
  const host = createHost({ width: 840, height: 420 });
  const tab = await mount(host, { width: 500, height: 420 });
  tab.panel.style.width = "300px";
  tab.panel.offsetWidth = 300;
  tab.resize();
  tab.flush();

  assert.deepEqual(host.writes, [{ width: 300, height: 420 }]);
  assert.equal(tab.panel.style.width, "300px");
});

test("an older open tab cannot overwrite the size dragged in another page", async () => {
  const host = createHost({ width: 840, height: 420 });
  const oldTab = await mount(host, { width: 840, height: 420 });
  const newTab = await mount(host, { width: 900, height: 500 });
  newTab.panel.style.width = "900px";
  newTab.panel.style.height = "500px";
  newTab.resize();
  newTab.flush();
  oldTab.resize();
  oldTab.flush();

  assert.deepEqual(host.read(), { width: 900, height: 500 });
  assert.equal(host.writes.length, 1);
});

test("a panel with no saved or dragged size leaves its defaults in CSS", async () => {
  const host = createHost();
  const tab = await mount(host, { width: 960, height: 360 });
  tab.resize();
  tab.flush();

  assert.deepEqual(tab.panel.style, { width: "", height: "" });
  assert.equal(host.read(), null);
});
