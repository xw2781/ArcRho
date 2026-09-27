import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ArcBot reads its entry prompt and the team's instruction files through the
// app server, which asks the Gateway (client_smb_retirement.md step 16). It
// never opens or seeds config\arcbot over the share, and with no server copy,
// or no answer, it uses the prompt bundled with the app.

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEST_TEMP_ROOT = path.resolve(TESTS_DIR, "..", "..", "test");
fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, "arcbot-prompt-files-"));
const documentsDir = path.join(testRoot, "Documents");
const userDataDir = path.join(testRoot, "UserData");
const workspaceRoot = path.join(testRoot, "Arco Server");
const workspacePathsPath = path.join(userDataDir, "workspace_paths.json");
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(workspacePathsPath, JSON.stringify({ workspace_root: workspaceRoot }), "utf8");
const bundledPrompt = fs.readFileSync(path.resolve(TESTS_DIR, "..", "electron", "prompts", "arcbot_prompt.md"), "utf8");

const originalCodexCommand = process.env.ARCRHO_CODEX_CMD;
const originalAppServer = process.env.ARCRHO_CODEX_APP_SERVER;
const originalServerRoot = process.env.ARCRHO_SERVER_ROOT;
process.env.ARCRHO_CODEX_CMD = path.join(testRoot, "fake-codex.exe");
process.env.ARCRHO_CODEX_APP_SERVER = "0";
delete process.env.ARCRHO_SERVER_ROOT;

// Plays the app server's /arcbot/prompt-files route.
let answer = { status: 200, body: {} };
const appServerRequests = [];
const appServer = http.createServer((req, res) => {
  appServerRequests.push(req.url);
  res.writeHead(answer.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(answer.body));
});
await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
let appServerUrl = `http://127.0.0.1:${appServer.address().port}`;

const require = createRequire(import.meta.url);
const { registerArcBotIpc } = require("../electron/arcbot_host.js");
const handlers = new Map();
let lastPrompt = "";

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
  getAppServerUrl: () => appServerUrl,
  runHostCommand: async (command, args, options) => {
    if (args[0] === "exec") lastPrompt = String(options?.input || "");
    return { ok: true, code: 0, signal: null, stdout: "Done.", stderr: "", timedOut: false, canceled: false, error: "" };
  },
});

test.after(async () => {
  arcBotHost.stop();
  await new Promise((resolve) => appServer.close(resolve));
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

const serverFiles = {
  prompt: [
    "<!-- ARCBOT:BASE -->SERVER ENTRY PROMPT\n{{MODE_INSTRUCTIONS}}\n{{SHARED_INSTRUCTIONS}}\n{{TRANSCRIPT}}<!-- ARCBOT:END_BASE -->",
    "<!-- ARCBOT:EDIT_MODE -->Edit.<!-- ARCBOT:END_EDIT_MODE -->",
    "<!-- ARCBOT:REVIEW_MODE -->Review.<!-- ARCBOT:END_REVIEW_MODE -->",
  ].join("\n"),
  prompt_path: path.join(workspaceRoot, "config", "arcbot", "arcbot_prompt.md"),
  instructions_dir: path.join(workspaceRoot, "config", "arcbot", "instructions"),
  instructions: [
    { name: "dfm_workflow.md", text: "Select factors with care." },
    { name: "team_notes.md", text: "Team note from the server." },
  ],
};

function ask() {
  return handlers.get("codex-assistant-send")(
    { sender: { send() {} } },
    {
      requestId: `test_${Math.random().toString(36).slice(2)}`,
      mode: "review",
      model: "codex",
      reasoningEffort: "low",
      messages: [{ role: "user", content: "What is this?" }],
      activeContext: { available: false },
    },
  );
}

test("the prompt and instructions come from the app server and nothing is written under the workspace root", async () => {
  answer = { status: 200, body: serverFiles };
  const guide = await handlers.get("codex-assistant-prompt-guide-load")();
  assert.equal(guide.ok, true, guide.error);
  assert.match(guide.components[0].text, /SERVER ENTRY PROMPT/u);
  assert.equal(guide.entryPromptPath, serverFiles.prompt_path);
  const byTitle = Object.fromEntries(guide.components.map((item) => [item.title, item.text]));
  assert.equal(byTitle["dfm_workflow.md"], "Select factors with care.");
  assert.equal(byTitle["team_notes.md"], "Team note from the server.");
  assert.match(byTitle["data_labels.md"], /^# Data Labels/u, "a file the server lacks shows its placeholder");

  const result = await ask();
  assert.equal(result.ok, true, result.error);
  assert.match(lastPrompt, /SERVER ENTRY PROMPT/u);
  assert.match(lastPrompt, /## team_notes\.md\n\nTeam note from the server\./u);
  assert.ok(appServerRequests.every((url) => url === "/arcbot/prompt-files"));
  assert.deepEqual(fs.readdirSync(workspaceRoot), [], "ArcBot seeds nothing onto the server folder");
});

test("with no server copy or no answer ArcBot uses the bundled prompt", async () => {
  answer = { status: 200, body: { ...serverFiles, prompt: null, instructions: [] } };
  const guide = await handlers.get("codex-assistant-prompt-guide-load")();
  assert.equal(guide.components[0].text.startsWith(bundledPrompt.slice(0, 200)), true);
  assert.match(guide.entryPromptPath, /prompts[\\/]arcbot_prompt\.md$/u);

  answer = { status: 503, body: { detail: "Arco Gateway could not answer this request." } };
  const result = await ask();
  assert.equal(result.ok, true, result.error);
  assert.match(lastPrompt, /Shared instruction files could not be read: Arco Gateway could not answer this request\./u);
  assert.doesNotMatch(lastPrompt, /SERVER ENTRY PROMPT/u);

  appServerUrl = "";
  assert.equal((await ask()).ok, true);
  assert.deepEqual(fs.readdirSync(workspaceRoot), []);
});
