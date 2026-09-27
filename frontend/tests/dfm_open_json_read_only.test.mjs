import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// "Open DFM JSON" shows the method read only (client_smb_retirement.md step 5):
// the Arcode window loads it through the hosted DFM load and has no way to
// save it, so it never writes a method file over the share.

// The framework polls a saved file's revision; an unref'd timer lets the run end.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");

function sliceFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

// A DOM just deep enough for the editor framework: every element the chrome
// names exists, records what is written to it, and answers its listeners.
function fakeElement() {
  const listeners = {};
  const element = {
    innerHTML: "",
    textContent: "",
    hidden: false,
    disabled: false,
    title: "",
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    getBoundingClientRect: () => ({ height: 400 }),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    querySelector: () => {
      element.child ||= fakeElement();
      return element.child;
    },
  };
  return element;
}

async function bootEditorPage({ readOnlySource = null, path = "" } = {}) {
  const calls = { save: [], read: [], revision: [], parent: [], status: [] };
  const elements = new Map();
  const windowListeners = { message: [], keydown: [] };
  let editorValue = "";
  let createOptions = null;
  const editor = {
    getValue: () => editorValue,
    setValue: (value) => { editorValue = String(value); },
    getModel: () => ({ getFullModelRange: () => ({}), getValueInRange: () => "" }),
    getSelection: () => null,
    executeEdits: (_source, edits) => { editorValue = String(edits[0].text); },
    pushUndoStop() {},
    onDidChangeModelContent() {},
    onDidChangeCursorSelection() {},
    updateOptions() {},
    layout() {},
  };
  globalThis.document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    querySelector: () => null,
    body: fakeElement(),
  };
  globalThis.window = {
    location: { search: path ? `?path=${encodeURIComponent(path)}` : "" },
    innerHeight: 800,
    addEventListener: (type, handler) => { (windowListeners[type] ||= []).push(handler); },
    ArcodeEditorShared: {
      sanitizeStorageId: (value) => String(value || ""),
      filenameFromPath: (value) => String(value || "").split(/[\\/]/).pop(),
      directoryFromPath: () => "",
      languageFromPath: (value) => (String(value || "").endsWith(".json") ? "json" : "plaintext"),
      postStatus: (text) => calls.status.push(text),
      postTabTitle() {},
      postDirty() {},
      postParentMessage: (message) => calls.parent.push(message),
      sameRevision: () => true,
      readTextFile: async (filePath) => {
        calls.read.push(filePath);
        return { ok: true, path: filePath, text: "{}\n" };
      },
      getFileRevision: async (filePath) => {
        calls.revision.push(filePath);
        return null;
      },
      saveTextFile: async (payload) => {
        calls.save.push(payload);
        return { path: payload.path || "C:/picked.json" };
      },
    },
    require: Object.assign(
      (_modules, ready) => {
        globalThis.window.monaco = {
          editor: {
            create: (_host, options) => {
              createOptions = options;
              return editor;
            },
            setModelLanguage() {},
          },
        };
        ready();
      },
      { config() {} },
    ),
  };
  const moduleUrl = new URL("../ui/arcode/shared/editor_framework.js", import.meta.url);
  moduleUrl.search = `?case=${Math.random()}`;
  const { createEditorPage } = await import(moduleUrl.href);
  const page = createEditorPage({ id: "python", defaultTitle: "Untitled", fileFilters: [], readOnlySource });
  await page.boot();
  const send = async (type, data) => {
    for (const handler of windowListeners[type]) await handler(data);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { page, calls, elements, createOptions, send, value: () => editorValue };
}

test("a DFM method opens read only and nothing in the window can save it", async () => {
  const text = '{\n  "json_format": "arcrho-dfm-v4"\n}\n';
  const { page, calls, elements, createOptions, send, value } = await bootEditorPage({
    readOnlySource: {
      name: "C 12 - CWP DFM w/ Selected LDFs.json",
      note: "Change this method in its DFM page.",
      load: async () => text,
    },
  });

  assert.equal(value(), text);
  assert.equal(createOptions.readOnly, true);
  assert.equal(createOptions.domReadOnly, true);
  assert.equal(createOptions.language, "json");
  const bar = elements.get("contextBar");
  assert.equal(bar.hidden, false);
  assert.match(bar.innerHTML, /<span class="ce-read-only-chip">Read only<\/span>/u);
  assert.equal(bar.child.textContent, "Change this method in its DFM page.");
  assert.equal(page.filename(), "C 12 - CWP DFM w/ Selected LDFs.json");

  assert.equal(await page.saveCurrentFile(), false);
  assert.equal(await page.saveCurrentFile({ saveAs: true }), false);
  await send("keydown", { key: "s", ctrlKey: true, preventDefault() {} });
  await send("keydown", { key: "S", ctrlKey: true, shiftKey: true, preventDefault() {} });
  await send("message", { data: { type: "arcode:scripting-save" } });
  await send("message", { data: { type: "arcode:scripting-save-as" } });
  assert.deepEqual(calls.save, []);
  assert.match(calls.status.at(-1), /^Read only\. Change this method in its DFM page\.$/u);

  // ArcBot cannot put an edit into it either.
  await send("message", { data: { type: "arcode:assistant-apply-json-edit", requestId: "r1", proposedText: "{}\n" } });
  const reply = calls.parent.find((message) => message.requestId === "r1");
  assert.equal(reply.ok, false);
  assert.match(reply.error, /is open read only/u);
  assert.equal(value(), text);

  // It never read, watched or wrote a path.
  assert.deepEqual(calls.read, []);
  assert.deepEqual(calls.revision, []);
});

test("a file opened from the explorer keeps its normal save", async () => {
  const { page, calls } = await bootEditorPage({ path: "C:/work/notes.json" });
  assert.equal(await page.saveCurrentFile(), true);
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].path, "C:/work/notes.json");
});

test("Open DFM JSON names the method and loads it through the hosted DFM load", () => {
  const orchestrator = read("../ui/method_pages/dfm/dfm_tabs_orchestrator.js");
  const openJson = sliceFunction(orchestrator, "async function openCurrentDfmMethodJson() {");
  assert.match(openJson, /const dfmMethod = readDfmMethodIdentityFromPage\(\);/u);
  assert.match(openJson, /hostApi\.openPath\(\{ preferredApp: "arcode", dfmMethod \}\)/u);
  assert.doesNotMatch(openJson, /resolveCurrentDfmMethodSavePath|path:/u);
  assert.match(orchestrator, /type: "arcrho:open-path", requestId, preferredApp: "arcode", dfmMethod \}/u);

  // The Project Instance and the shell pass the method on without a path.
  const projectInstance = read("../ui/project_instance/project_instance_messages.js");
  assert.match(projectInstance, /if \(!path && !dfmMethod\) \{/u);
  assert.match(projectInstance, /\.\.\.\(dfmMethod \? \{ dfmMethod \} : \{\}\)/u);
  const shell = read("../ui/shell/shell_messages.js");
  assert.match(shell, /if \(!targetPath && !dfmMethod\)/u);
  assert.match(shell, /hostApi\.openPath\(\{ path: targetPath, preferredApp, readOnly, \.\.\.\(dfmMethod \? \{ dfmMethod \} : \{\}\) \}\)/u);

  // The host opens Arcode before it would touch a path on the share.
  const main = read("../electron/main.js");
  const openPath = main.slice(main.indexOf('ipcMain.handle("open-path"'), main.indexOf('ipcMain.handle("show-item-in-folder"'));
  const dfmBranch = openPath.indexOf('if (preferredApp === "arcode" && payload?.dfmMethod) {');
  assert.ok(dfmBranch > 0 && dfmBranch < openPath.indexOf("fs.existsSync"));
  assert.match(main, /params\.set\("dfm", JSON\.stringify\(options\.dfmMethod\)\)/u);

  // Arcode gives the tab no path, so nothing reopens it as a file.
  const arcode = read("../ui/arcode/main.js");
  assert.match(arcode, /const filePath = dfmMethod \? "" : String\(options\.path/u);
  assert.match(arcode, /if \(tab\.dfmMethod\) params\.set\("dfm", JSON\.stringify\(tab\.dfmMethod\)\);/u);
  assert.match(arcode, /readOnly && \(action === "save" \|\| action === "save-as"\)/u);

  const codeEditor = read("../ui/arcode/code-editor/index.js");
  assert.match(codeEditor, /import \{ loadDfmMethod \} from "\/ui\/method_pages\/dfm\/dfm_method_api\.js\?v=/u);
  assert.match(codeEditor, /const response = await loadDfmMethod\(identity\);/u);
  assert.match(codeEditor, /host\.formatPersistedJsonText\(\{ data: response\.method \}\)/u);
  assert.match(codeEditor, /readOnlySource: dfmMethodSource\(new URLSearchParams\(window\.location\.search\)\.get\("dfm"\)\)/u);
});
