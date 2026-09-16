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
  restoreNotesPanelSize();
  return { resize: scheduleNotesPanelSizeSave };
`);

function createStorage(size) {
  let value = size ? JSON.stringify(size) : null;
  const writes = [];
  return {
    writes,
    getItem() { return value; },
    setItem(_key, next) {
      value = next;
      writes.push(JSON.parse(next));
    },
    read() { return value ? JSON.parse(value) : null; },
  };
}

function mount(storage, { width = 0, height = 0 } = {}) {
  const timers = new Set();
  const panel = {
    style: { width: "", height: "" },
    offsetWidth: width,
    offsetHeight: height,
  };
  const controller = createSizing({
    localStorage: storage,
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  }, panel);
  return {
    ...controller,
    panel,
    flush() {
      for (const callback of Array.from(timers)) {
        timers.delete(callback);
        callback();
      }
    },
  };
}

test("mounting a hidden Notes tab preserves the saved size for the next page", () => {
  const saved = { width: 840, height: 420 };
  const storage = createStorage(saved);
  const hidden = mount(storage);
  hidden.resize();
  hidden.flush();

  assert.deepEqual(storage.read(), saved);
  assert.equal(storage.writes.length, 0);
  assert.deepEqual(mount(storage).panel.style, { width: "840px", height: "420px" });
});

test("a narrow host or tab hide never replaces the preferred dimensions", () => {
  const saved = { width: 840, height: 420 };
  const storage = createStorage(saved);
  const tab = mount(storage, { width: 360, height: 420 });
  tab.resize();
  tab.flush();
  tab.panel.offsetWidth = 0;
  tab.panel.offsetHeight = 0;
  tab.resize();
  tab.flush();

  assert.deepEqual(storage.read(), saved);
  assert.equal(storage.writes.length, 0);
});

test("a grip resize persists its inline dimensions even if hidden before the save", () => {
  const storage = createStorage({ width: 840, height: 420 });
  const tab = mount(storage, { width: 840, height: 420 });
  tab.panel.style.width = "760px";
  tab.panel.style.height = "460px";
  tab.resize();
  tab.panel.style.width = "780px";
  tab.resize();
  tab.panel.offsetWidth = 0;
  tab.panel.offsetHeight = 0;
  tab.resize();
  tab.flush();

  assert.deepEqual(storage.writes, [{ width: 780, height: 460 }]);
  assert.deepEqual(mount(storage).panel.style, { width: "780px", height: "460px" });
});

test("an older open tab cannot overwrite the size dragged in another page", () => {
  const storage = createStorage({ width: 840, height: 420 });
  const oldTab = mount(storage, { width: 840, height: 420 });
  const newTab = mount(storage, { width: 900, height: 500 });
  newTab.panel.style.width = "900px";
  newTab.panel.style.height = "500px";
  newTab.resize();
  newTab.flush();
  oldTab.resize();
  oldTab.flush();

  assert.deepEqual(storage.read(), { width: 900, height: 500 });
  assert.equal(storage.writes.length, 1);
});

test("a panel with no saved or dragged size leaves its defaults in CSS", () => {
  const storage = createStorage();
  const tab = mount(storage, { width: 960, height: 360 });
  tab.resize();
  tab.flush();

  assert.deepEqual(tab.panel.style, { width: "", height: "" });
  assert.equal(storage.read(), null);
});
