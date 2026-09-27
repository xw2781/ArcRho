import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ArcBot never writes a project file (client_smb_retirement.md decision 2):
// the host hands the edited JSON back, the open page applies it as one undo
// step and saves it through its own save, and a revert is that page's undo.

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEST_TEMP_ROOT = path.resolve(TESTS_DIR, "..", "..", "test");
fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, "arcbot-page-save-"));
const documentsDir = path.join(testRoot, "Documents");
const userDataDir = path.join(testRoot, "UserData");
const workspaceRoot = path.join(testRoot, "Arco Server");
const classDir = path.join(workspaceRoot, "projects", "Demo", "Auto", "BI");
const methodPath = path.join(classDir, "methods", "Paid LDF.json");
const workspacePathsPath = path.join(userDataDir, "workspace_paths.json");
fs.mkdirSync(path.dirname(methodPath), { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(workspacePathsPath, JSON.stringify({ workspace_root: workspaceRoot }), "utf8");
const methodBytes = `${JSON.stringify({ "details_tab": { name: "Paid LDF" }, note: "on the share" }, null, 2)}\n`;
fs.writeFileSync(methodPath, methodBytes, "utf8");
fs.writeFileSync(path.join(classDir, "Paid Loss.csv"), "origin,12\n2020,1\n", "utf8");

const originalCodexCommand = process.env.ARCRHO_CODEX_CMD;
const originalAppServer = process.env.ARCRHO_CODEX_APP_SERVER;
const originalServerRoot = process.env.ARCRHO_SERVER_ROOT;
process.env.ARCRHO_CODEX_CMD = path.join(testRoot, "fake-codex.exe");
process.env.ARCRHO_CODEX_APP_SERVER = "0";
delete process.env.ARCRHO_SERVER_ROOT;

const require = createRequire(import.meta.url);
const { registerArcBotIpc } = require("../electron/arcbot_host.js");
const handlers = new Map();
let codexEdit = null;

function commandResult(ok, stdout = "", error = "") {
  return { ok, code: ok ? 0 : 1, signal: null, stdout, stderr: "", timedOut: false, canceled: false, error };
}

// Plays the Codex CLI: edits the staged copy in its working folder, the way
// the real CLI would under its workspace-write sandbox.
const arcBotHost = registerArcBotIpc({
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  app: {
    isPackaged: false,
    getPath: (name) => (name === "documents" ? documentsDir : name === "userData" ? userDataDir : testRoot),
  },
  APP_ROOT: testRoot,
  REPO_ROOT: testRoot,
  PYTHON_EXE: "python",
  getPrefsDir: () => userDataDir,
  getWorkspacePathsPath: () => workspacePathsPath,
  findExecutableOnPath: () => "",
  runHostCommand: async (command, args) => {
    if (command === "net") return commandResult(false, "", "not a mapped drive");
    if (args[0] !== "exec") return commandResult(true);
    const cwd = args[args.indexOf("--cd") + 1];
    codexEdit?.(cwd);
    return commandResult(true, JSON.stringify({ action: "edited", reply: "Changed the note." }));
  },
});

test.after(() => {
  arcBotHost.stop();
  for (const [name, value] of [
    ["ARCRHO_CODEX_CMD", originalCodexCommand],
    ["ARCRHO_CODEX_APP_SERVER", originalAppServer],
    ["ARCRHO_SERVER_ROOT", originalServerRoot],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

async function send(activeContext) {
  return handlers.get("codex-assistant-send")(
    { sender: { send() {} } },
    {
      requestId: `test_${Math.random().toString(36).slice(2)}`,
      mode: "edit",
      model: "codex",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "Change the note." }],
      activeContext,
    },
  );
}

test("an ArcBot edit to a project method hands the JSON back and never writes the method folder", async () => {
  const classFilesBefore = listFiles(classDir);
  let stagedCopy = "";
  codexEdit = (cwd) => {
    stagedCopy = path.join(cwd, path.relative(workspaceRoot, methodPath));
    const staged = JSON.parse(fs.readFileSync(stagedCopy, "utf8"));
    staged.note = "edited by ArcBot";
    fs.writeFileSync(stagedCopy, JSON.stringify(staged), "utf8");
  };
  const pageJson = { "details_tab": { name: "Paid LDF" }, note: "in the page" };
  const result = await send({ available: true, pageType: "dfm", methodPath, activeJson: pageJson });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.editProposed, true);
  assert.equal(result.editPendingApproval, false);
  assert.equal(result.targetPath, methodPath);
  assert.deepEqual(result.originalJson, pageJson, "ArcBot works from the page's JSON, not the file");
  assert.equal(result.proposedJson.note, "edited by ArcBot");
  assert.equal(JSON.parse(result.proposedText).note, "edited by ArcBot");
  assert.ok(stagedCopy.startsWith(documentsDir), "the copy Codex edits is local");

  assert.equal(fs.readFileSync(methodPath, "utf8"), methodBytes, "the method file is untouched");
  assert.deepEqual(listFiles(classDir), classFilesBefore, "no backup, history or temp file lands in the class folder");
  assert.equal(fs.existsSync(path.join(userDataDir, "arcbot_latest_edit.json")), false);
});

test("a JSON file open in an editor is edited from the editor text, never read from disk", async () => {
  const missingPath = path.join(classDir, "never-created.json");
  codexEdit = (cwd) => {
    const stagedCopy = path.join(cwd, path.relative(workspaceRoot, missingPath));
    fs.writeFileSync(stagedCopy, JSON.stringify({ a: 2 }), "utf8");
  };
  const result = await send({
    available: true,
    pageType: "code-editor",
    targetPath: missingPath,
    fullText: "{\n  \"a\": 1\n}\n",
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.editProposed, true);
  assert.deepEqual(result.originalJson, { a: 1 });
  assert.deepEqual(result.proposedJson, { a: 2 });
  assert.equal(fs.existsSync(missingPath), false);
});

test("the host has no file writer, backup or revert for ArcBot edits", async () => {
  const host = (await readFile(new URL("../electron/arcbot_host.js", import.meta.url), "utf8"));
  for (const gone of ["applyArcBotJsonEdit", "revertLatestArcBotEdit", "arcbot_latest_edit", ".bak.json", ".arcbot.tmp"]) {
    assert.equal(host.includes(gone), false, `${gone} is gone`);
  }
});

// The page side: a DFM applies ArcBot's edit as one undo step and saves it,
// and reverts by undoing that step and saving again.

const frontendRoot = new URL("../", import.meta.url);
const source = async (rel) => (await readFile(new URL(rel, frontendRoot), "utf8")).replaceAll("\r\n", "\n");
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;

async function loadDfmArcBotModule() {
  globalThis.__dfm = { method: { name: "before" }, saves: [], saveOk: true, dirty: 0 };
  const stateStub = moduleUrl(`
    export const activeRatioCols = new Set();
    export const ratioStrikeSet = new Set();
    export const selectedSummaryByCol = new Map();
    export const getRatioColAllActive = () => false;
    export const setRatioColAllActive = () => {};
    export const getDfmInst = () => "test";
    export const getHostApi = () => null;
    export const markDfmDirty = () => { globalThis.__dfm.dirty += 1; };
    export const getDfmIsDirty = () => false;
    export const getEffectiveDevLabelsForModel = () => [];
    export const getResolvedProjectName = () => "Demo";
    export const getResolvedReservingClass = () => "Auto\\\\BI";
    export const getRatioHeaderLabels = () => [];
    export const state = {};
  `);
  const persistenceStub = moduleUrl(`
    export const buildDfmMethodPayload = () => ({ ...globalThis.__dfm.method });
    export async function applyDfmOwnedPatchPayload(payload) {
      globalThis.__dfm.method = { ...payload };
      return { ok: true };
    }
    export async function saveRatioSelectionPattern() {
      globalThis.__dfm.saves.push({ ...globalThis.__dfm.method });
      return globalThis.__dfm.saveOk ? { ok: true } : { ok: false, error: "The server is busy." };
    }
  `);
  const historyText = (await source("ui/method_pages/dfm/dfm_ratio_history.js"))
    .replace('"/ui/method_pages/dfm/dfm_state.js"', JSON.stringify(stateStub));
  const historyUrl = moduleUrl(historyText);
  const dialogStub = moduleUrl(`
    export const confirmDfmRpcBridgeAction = () => true;
    export const createDfmRpcBridgeDialog = () => ({});
    export const createDfmRpcBridgeMessageBox = () => ({});
  `);
  const text = (await source("ui/method_pages/dfm/dfm_rpc_bridge_client.js"))
    .replace('"/ui/method_pages/dfm/dfm_state.js"', JSON.stringify(stateStub))
    .replace(/"\/ui\/method_pages\/dfm\/dfm_persistence\.js\?v=[^"]+"/u, JSON.stringify(persistenceStub))
    .replace('"/ui/method_pages/dfm/dfm_ratio_history.js"', JSON.stringify(historyUrl))
    .replace(/"\/ui\/method_pages\/dfm\/dfm_rpc_bridge_dialog\.js\?v=[^"]+"/u, JSON.stringify(dialogStub));
  const client = await import(moduleUrl(`${text}\n// ${Math.random()}`));
  const history = await import(historyUrl);
  history.setMethodHistoryHandlers({
    capture: () => ({ ...globalThis.__dfm.method }),
    restore: async (payload) => {
      globalThis.__dfm.method = { ...payload };
      return true;
    },
  });
  return { client, history };
}

async function withDfmWindow(run) {
  const previousWindow = globalThis.window;
  globalThis.window = { parent: { postMessage() {} } };
  try {
    await run();
  } finally {
    globalThis.window = previousWindow;
    delete globalThis.__dfm;
  }
}

test("a DFM applies ArcBot's edit as one undo step, saves it, and reverts through its undo", async () => {
  await withDfmWindow(async () => {
    const { client, history } = await loadDfmArcBotModule();
    const applied = await client.applyArcBotDfmEdit({ name: "after" });
    assert.deepEqual(applied, { ok: true });
    assert.deepEqual(globalThis.__dfm.saves, [{ name: "after" }], "the page's own save ran once with the edit");
    assert.equal(history.peekRatioHistoryStepSource("undo"), "arcbot-edit");

    const reverted = await client.revertArcBotDfmEdit();
    assert.equal(reverted.ok, true);
    assert.deepEqual(globalThis.__dfm.method, { name: "before" });
    assert.deepEqual(globalThis.__dfm.saves.at(-1), { name: "before" }, "the revert is saved the same way");
    assert.equal(history.peekRatioHistoryStepSource("undo"), "");
  });
});

test("a DFM refuses to revert when its latest change is not ArcBot's", async () => {
  await withDfmWindow(async () => {
    const { client, history } = await loadDfmArcBotModule();
    await client.applyArcBotDfmEdit({ name: "after" });
    history.recordMethodHistoryStep({ name: "after" }, "load-settings");
    globalThis.__dfm.method = { name: "loaded" };
    const saves = globalThis.__dfm.saves.length;
    const reverted = await client.revertArcBotDfmEdit();
    assert.equal(reverted.ok, false);
    assert.deepEqual(globalThis.__dfm.method, { name: "loaded" });
    assert.equal(globalThis.__dfm.saves.length, saves);
  });
});

test("a failed save leaves ArcBot's edit in the DFM as unsaved changes", async () => {
  await withDfmWindow(async () => {
    const { client } = await loadDfmArcBotModule();
    globalThis.__dfm.saveOk = false;
    const applied = await client.applyArcBotDfmEdit({ name: "after" });
    assert.equal(applied.ok, false);
    assert.equal(applied.applied, true);
    assert.match(applied.error, /not saved: The server is busy\. Save the DFM before closing\./u);
    assert.deepEqual(globalThis.__dfm.method, { name: "after" });
    assert.ok(globalThis.__dfm.dirty >= 2);
  });
});

test("the widget sends edits and reverts to the page that answered, never to the host", async () => {
  const assistant = await source("ui/ai-assistant/index.js");
  assert.match(assistant, /isRevertLatestArcBotEditRequest\(userText\)\n\s+\? await revertLatestArcBotEdit\(\)/u);
  assert.match(assistant, /requestPageArcBotEdit\(lastArcBotEdit\.tabId, "revert-json-edit"/u);
  assert.match(assistant, /requestPageArcBotEdit\(edit\.tabId, "apply-json-edit", editPayload\)/u);
  assert.doesNotMatch(assistant, /json-updated/u);
  const projectInstance = await source("ui/project_instance/project_instance_messages.js");
  assert.match(projectInstance, /msg\.type === "arcrho:assistant-apply-json-edit"/u);
  assert.match(projectInstance, /msg\.type === "arcrho:assistant-revert-json-edit"/u);
  const orchestrator = await source("ui/method_pages/dfm/dfm_tabs_orchestrator.js");
  assert.match(orchestrator, /e\?\.data\?\.type === "arcrho:assistant-apply-json-edit"/u);
  const notebook = await source("ui/arcode/notebook-editor/index.js");
  assert.match(notebook, /applyArcBotNotebookEdit\(event\.data\)/u);
  const editor = await source("ui/arcode/shared/editor_framework.js");
  assert.match(editor, /handleAssistantJsonEdit\(msg\)/u);
});
