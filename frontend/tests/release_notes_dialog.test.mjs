import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A minimal element/document stub: enough of the DOM for the dialog to build its
// tree, so the note nesting and section layout are exercised for real rather
// than asserted against the source text.
class StubElement {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.open = false;
    this.scrollTop = 0;
    this.listeners = new Map();
    this.focused = false;
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }

  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) { (this.listeners.get(type) || []).forEach((handler) => handler(event)); }
  focus() { this.focused = true; }
  scrollTo() {}

  get childElementCount() { return this.children.length; }

  // Every node's text with its class, so a test can assert both what a line says
  // and the level it was rendered at.
  flatten(out = []) {
    const own = String(this.textContent || "").trim();
    if (own) out.push({ className: this.className, tag: this.tagName, text: own });
    this.children.forEach((child) => child.flatten(out));
    return out;
  }
}

const dialogIds = [
  "releaseNotesOverlay", "releaseNotesTitle", "releaseNotesSummary",
  "releaseNotesScroll", "releaseNotesSourceNote", "releaseNotesLaterBtn",
  "releaseNotesUpdateBtn", "releaseNotesCloseBtn",
];
const dom = new Map(dialogIds.map((id) => [id, new StubElement("div")]));
const documentListeners = new Map();

globalThis.window = {};
globalThis.document = {
  getElementById: (id) => dom.get(id) || null,
  createElement: (tag) => new StubElement(tag),
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
};

let source = await readFile(new URL("../ui/shell/release_notes_dialog.js", import.meta.url), "utf8");
source = source.replace(
  /import \{ shell \} from "\.\/shell_context\.js\?v=[^"]+";/u,
  "const shell = globalThis.__releaseNotesShell;"
);
globalThis.__releaseNotesShell = {};
const { initReleaseNotesDialog, openReleaseHistory } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
initReleaseNotesDialog();

// The host reaches the dialog through this global, so the test drives it the
// same way rather than calling an export the main process cannot see.
const showUpdateDialog = globalThis.window.__arcrho_show_update_dialog;
assert.equal(typeof showUpdateDialog, "function");

function entries(...items) {
  return items.map(([kind, text]) => ({ kind, text }));
}

const twoVersionPayload = {
  currentVersion: "1.4.0",
  version: "1.4.2",
  assetName: "ArcRho-Setup-1.4.2.exe",
  mandatory: false,
  releasesUrl: "https://github.com/example/ArcRho/releases",
  releases: [
    {
      version: "1.4.2",
      releasedOn: "2026-08-18",
      entries: entries(
        ["title", "Improvements"],
        ["bullet", "dataset: Added a subtotal command."],
        ["nested", "Applies per dataset."]
      ),
    },
    {
      version: "1.4.1",
      releasedOn: "2026-08-15",
      entries: entries(["title", "Fixes"], ["bullet", "dfm: Fixed a save error."]),
    },
  ],
};

function scrollText() {
  return dom.get("releaseNotesScroll").flatten();
}

test("the update dialog lists each skipped version as its own section, newest open", () => {
  const pending = showUpdateDialog(twoVersionPayload);

  const scroll = dom.get("releaseNotesScroll");
  const sections = scroll.children.filter((child) => child.className === "releaseNotesRelease");
  assert.equal(sections.length, 2, "one section per version the user has not installed");
  assert.equal(sections[0].open, true, "the newest release is expanded on open");
  assert.equal(sections[1].open, false, "older releases stay collapsed but reachable");

  const lines = scrollText();
  assert.ok(lines.some((line) => line.className === "releaseNotesVersion" && line.text === "1.4.2"));
  assert.ok(lines.some((line) => line.className === "releaseNotesDate" && line.text === "2026-08-18"));
  assert.ok(lines.some((line) => line.className === "releaseNotesGroup" && line.text === "Improvements"));
  assert.ok(lines.some((line) => line.text === "dataset: Added a subtotal command."));
  assert.ok(lines.some((line) => line.text === "Fixes"), "the skipped version's notes render too");
  assert.ok(lines.some((line) => line.text === "dfm: Fixed a save error."));

  const summary = dom.get("releaseNotesSummary").flatten();
  assert.ok(summary.some((line) => line.text === "1.4.0"));
  assert.ok(summary.some((line) => line.text === "1.4.2"));
  assert.ok(summary.some((line) => /Includes 1 earlier release you have not installed/.test(line.text)));
  assert.equal(
    dom.get("releaseNotesSourceNote").textContent,
    "All releases: https://github.com/example/ArcRho/releases"
  );

  dom.get("releaseNotesLaterBtn").dispatch("click");
  return pending.then((answer) => assert.deepEqual(answer, { choice: "later" }));
});

test("a detail bullet renders under the change it belongs to", () => {
  const pending = showUpdateDialog(twoVersionPayload);
  const scroll = dom.get("releaseNotesScroll");
  const [newest] = scroll.children.filter((child) => child.className === "releaseNotesRelease");
  const body = newest.children.find((child) => child.className === "releaseNotesReleaseBody");
  const list = body.children.find((child) => child.className === "releaseNotesList");
  const item = list.children[0];
  const sublist = item.children.find((child) => child.className === "releaseNotesSubList");

  assert.equal(item.textContent, "dataset: Added a subtotal command.");
  assert.ok(sublist, "a nested bullet nests instead of becoming a sibling change");
  assert.equal(sublist.children[0].textContent, "Applies per dataset.");

  dom.get("releaseNotesLaterBtn").dispatch("click");
  return pending;
});

test("a single new version renders its notes without a section header", () => {
  const pending = showUpdateDialog({ ...twoVersionPayload, releases: [twoVersionPayload.releases[0]] });
  const scroll = dom.get("releaseNotesScroll");
  assert.equal(scroll.children.filter((child) => child.className === "releaseNotesRelease").length, 0);
  assert.ok(scrollText().some((line) => line.text === "dataset: Added a subtotal command."));
  assert.ok(!dom.get("releaseNotesSummary").flatten()
    .some((line) => /earlier release/.test(line.text)), "no skipped-version line when nothing was skipped");

  dom.get("releaseNotesLaterBtn").dispatch("click");
  return pending;
});

test("Update now resolves the host's request and a mandatory update says so", () => {
  const pending = showUpdateDialog({ ...twoVersionPayload, mandatory: true });
  assert.ok(dom.get("releaseNotesSummary").flatten()
    .some((line) => line.className === "releaseNotesMandatory"));
  assert.equal(dom.get("releaseNotesUpdateBtn").hidden, false);

  dom.get("releaseNotesUpdateBtn").dispatch("click");
  return pending.then((answer) => assert.deepEqual(answer, { choice: "update" }));
});

test("dismissing the dialog answers the waiting host with later", async () => {
  const overlay = dom.get("releaseNotesOverlay");
  for (const dismiss of [
    () => dom.get("releaseNotesCloseBtn").dispatch("click"),
    () => overlay.dispatch("click", { target: overlay }),
    () => (documentListeners.get("keydown") || [])
      .forEach((handler) => handler({ key: "Escape", stopPropagation() {} })),
  ]) {
    const pending = showUpdateDialog(twoVersionPayload);
    assert.equal(overlay.classList.contains("open"), true);
    dismiss();
    assert.deepEqual(await pending, { choice: "later" });
    assert.equal(overlay.classList.contains("open"), false);
  }
});

test("a second prompt answers the first instead of stranding the host", async () => {
  const first = showUpdateDialog(twoVersionPayload);
  const second = showUpdateDialog(twoVersionPayload);
  assert.deepEqual(await first, { choice: "later" });

  dom.get("releaseNotesUpdateBtn").dispatch("click");
  assert.deepEqual(await second, { choice: "update" });
});

test("release history marks the installed version and offers only a close action", async () => {
  globalThis.__releaseNotesShell.getHostApi = () => ({
    getReleaseHistory: async () => ({
      available: true,
      currentVersion: "1.4.1",
      releasesUrl: "https://github.com/example/ArcRho/releases",
      releases: [
        { version: "1.4.2", releasedOn: "2026-08-18", entries: entries(["bullet", "Newer than this build."]) },
        { version: "1.4.1", releasedOn: "2026-08-15", entries: entries(["bullet", "The installed build."]) },
      ],
    }),
  });

  await openReleaseHistory();

  assert.equal(dom.get("releaseNotesTitle").textContent, "ArcRho Release History");
  assert.equal(dom.get("releaseNotesUpdateBtn").hidden, true, "history never offers to install anything");
  assert.equal(dom.get("releaseNotesLaterBtn").textContent, "Close");

  const chips = scrollText().filter((line) => line.className === "releaseNotesChip");
  assert.deepEqual(chips.map((chip) => chip.text), ["Installed"]);
  assert.ok(dom.get("releaseNotesSummary").flatten()
    .some((line) => /Installed version 1\.4\.1/.test(line.text)));

  // Sections are used even for one release here, so every version stays labelled.
  assert.equal(scrollText().filter((line) => line.className === "releaseNotesVersion").length, 2);
});

test("release history reports a build with no bundled notes instead of showing an empty window", async () => {
  globalThis.__releaseNotesShell.getHostApi = () => ({
    getReleaseHistory: async () => ({ available: false, currentVersion: "1.4.1", releases: [] }),
  });

  await openReleaseHistory();
  assert.ok(scrollText().some((line) => /not bundled with this build/.test(line.text)));
});
