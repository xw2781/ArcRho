import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A skill is a folder on the server (shared\agent-skills) that ArcBot reads through
// the app server. A skill turn is a read-only review that carries the skill's text,
// refuses a page the skill does not fit, and lets Claude call tools.

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEST_TEMP_ROOT = path.resolve(TESTS_DIR, "..", "..", "test");
fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, "arcbot-agent-skills-"));
const documentsDir = path.join(testRoot, "Documents");
const userDataDir = path.join(testRoot, "UserData");
const workspacePathsPath = path.join(userDataDir, "workspace_paths.json");
fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(workspacePathsPath, JSON.stringify({ workspace_root: path.join(testRoot, "Arco Server") }), "utf8");

const saved = Object.fromEntries(
  ["ARCRHO_CODEX_CMD", "ARCRHO_CODEX_APP_SERVER", "ARCRHO_SERVER_ROOT"].map((name) => [name, process.env[name]]),
);
process.env.ARCRHO_CODEX_CMD = path.join(testRoot, "fake-codex.exe");
process.env.ARCRHO_CODEX_APP_SERVER = "0";
delete process.env.ARCRHO_SERVER_ROOT;

const dfmSkill = {
  id: "dfm-diagnostics",
  title: "DFM Diagnostics",
  description: "Review the open DFM.",
  scope: "dfm",
  macros: ["show_diagnostic_triangle"],
  version: "1.0.0",
};
const skillAnswer = {
  skills: [{
    ...dfmSkill,
    instructions: "STEP ONE: show the triangle.",
    references: [{ name: "diagnostic_signals.md", text: "A high value means a lower factor." }],
  }],
};

// Plays the app server's skill, prompt-file and macro routes.
const appServerRequests = [];
const appServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    appServerRequests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/arcbot/agent-skills")) {
      res.end(JSON.stringify(req.url.includes("skill_id=") ? skillAnswer : { skills: [dfmSkill] }));
    } else if (req.url === "/scripting/run-macro") {
      res.end(JSON.stringify({ success: true, message: "Opened diagnostic dataset: Severity" }));
    } else {
      res.end("{}");
    }
  });
});
await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
const appServerUrl = `http://127.0.0.1:${appServer.address().port}`;

const require = createRequire(import.meta.url);
const { registerArcBotIpc, testHooks } = require("../electron/arcbot_host.js");
const { startToolEndpoint } = require("../electron/arcbot_claude_cli.js");
const handlers = new Map();
const execCalls = [];
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
    if (args[0] === "exec") execCalls.push({ args, prompt: String(options?.input || "") });
    return { ok: true, code: 0, signal: null, stdout: "Done.", stderr: "", timedOut: false, canceled: false, error: "" };
  },
});

test.after(async () => {
  arcBotHost.stop();
  await new Promise((resolve) => appServer.close(resolve));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
});

const event = { sender: { send() {} } };
const dfmContext = {
  available: true,
  pageType: "project_instance",
  nestedPageType: "dfm",
  activeJson: { details_tab: { name: "F 23 - Incurred DFM" } },
  fields: { project: "Fake Project", reservingClass: "Auto", methodName: "F 23 - Incurred DFM" },
};

function sendSkillTurn(activeContext) {
  execCalls.length = 0;
  return handlers.get("codex-assistant-send")(event, {
    requestId: `test_${Math.random().toString(36).slice(2)}`,
    mode: "edit",
    model: "codex",
    reasoningEffort: "low",
    skillId: "dfm-diagnostics",
    messages: [{ role: "user", content: "Run the DFM Diagnostics skill." }],
    activeContext,
  });
}

test("the menu list comes from the app server's skill route", async () => {
  const answer = await handlers.get("codex-assistant-skills-list")();
  assert.deepEqual(answer, { ok: true, skills: [dfmSkill] });
});

test("a skill turn is a read-only review that carries the skill's text", async () => {
  const result = await sendSkillTurn(dfmContext);
  assert.equal(result.ok, true, result.error);
  const [exec] = execCalls;
  assert.equal(exec.args[exec.args.indexOf("--sandbox") + 1], "read-only", "an edit request still gets no write access");
  assert.match(exec.prompt, /STEP ONE: show the triangle\./u);
  assert.match(exec.prompt, /A high value means a lower factor\./u);
  assert.ok(appServerRequests.some((request) => request.url === "/arcbot/agent-skills?skill_id=dfm-diagnostics"));
});

test("a DFM skill is refused when no DFM window is open", async () => {
  const result = await sendSkillTurn({ available: true, pageType: "dataset", tabType: "dataset" });
  assert.equal(result.ok, false);
  assert.match(result.error, /needs a DFM window open/u);
  assert.equal(execCalls.length, 0, "no model run started");
});

// --- Claude turns through the Claude CLI --------------------------------------

// Plays the Claude CLI: records what it was given, calls the turn's MCP tool
// endpoint when told to, and prints stream-json the way the real CLI does.
const fakeCliPath = path.join(testRoot, "fake-claude.cjs");
const fakeRecordPath = path.join(testRoot, "fake-claude-record.json");
fs.writeFileSync(fakeCliPath, String.raw`
const fs = require("fs");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const say = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", async () => {
  const record = { args, prompt, system: fs.readFileSync(arg("--system-prompt-file"), "utf8"), toolAnswers: [] };
  const config = arg("--mcp-config");
  const server = config && JSON.parse(config).mcpServers.arcbot;
  const rpc = async (id, method, params) => (await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...server.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  })).json();
  if (server) {
    await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
    record.toolList = (await rpc(2, "tools/list", {})).result.tools.map((tool) => tool.name);
    const call = JSON.parse(process.env.FAKE_CLAUDE_TOOL_CALL || "null");
    if (call) record.toolAnswers.push((await rpc(3, "tools/call", call)).result);
  }
  fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify(record));
  if (process.env.FAKE_CLAUDE_SIGNED_OUT) {
    say({ type: "result", is_error: true, result: "Not logged in · Please run /login" });
    process.exit(1);
  }
  // Each reply is a model message: its text, optionally after a thinking block,
  // and optionally ending in a tool call.
  const replies = JSON.parse(process.env.FAKE_CLAUDE_REPLY || '["Done."]')
    .map((reply) => (typeof reply === "string" ? { text: reply } : reply));
  for (const reply of replies) {
    say({ type: "stream_event", event: { type: "message_start", message: {} } });
    if (reply.thinking) {
      say({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
      for (const piece of reply.thinking) {
        say({ type: "system", subtype: "thinking_tokens", estimated_tokens_delta: 40 });
        say({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } } });
      }
    }
    say({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: reply.text } } });
    if (reply.toolCall) say({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } });
  }
  say({ type: "result", is_error: false, result: replies.at(-1).text, usage: { input_tokens: 3, output_tokens: 4 } });
});
`, "utf8");

const cliEnvNames = ["ARCRHO_CLAUDE_CMD", "FAKE_CLAUDE_RECORD", "FAKE_CLAUDE_TOOL_CALL", "FAKE_CLAUDE_REPLY", "FAKE_CLAUDE_SIGNED_OUT"];

async function claudeRequest(extra = {}, fakeEnv = {}) {
  const before = Object.fromEntries(cliEnvNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { ARCRHO_CLAUDE_CMD: fakeCliPath, FAKE_CLAUDE_RECORD: fakeRecordPath, ...fakeEnv });
  const sent = [];
  try {
    const result = await testHooks.runClaudeArcBotRequest({
      event: { sender: { send: (_channel, payload) => sent.push(payload) } },
      requestId: "claude_test",
      requestState: null,
      model: "claude-sonnet-5-5",
      reasoningEffort: "low",
      systemText: "system",
      messages: [{ role: "user", content: "go" }],
      attachments: [],
      usage: null,
      cwd: path.join(testRoot, "claude-cwd"),
      ...extra,
    });
    return { result, sent, record: JSON.parse(fs.readFileSync(fakeRecordPath, "utf8")) };
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Claude's tool call runs through the turn's MCP endpoint and the reply is the final text", async () => {
  const calls = [];
  const { result, record } = await claudeRequest({
    tools: [{ name: "arco_run_macro", description: "d", inputSchema: { type: "object" } }],
    runTool: async (params) => { calls.push(params); return "Opened dataset"; },
  }, { FAKE_CLAUDE_TOOL_CALL: JSON.stringify({ name: "arco_run_macro", arguments: { macro_id: "show_diagnostic_triangle" } }) });
  assert.deepEqual(result, { ok: true, stdout: "Done." });
  assert.deepEqual(calls.map(({ tool, arguments: args }) => ({ tool, args })), [
    { tool: "arco_run_macro", args: { macro_id: "show_diagnostic_triangle" } },
  ]);
  assert.deepEqual(record.toolList, ["arco_run_macro"]);
  assert.deepEqual(record.toolAnswers, [{ content: [{ type: "text", text: "Opened dataset" }] }]);
  assert.equal(record.system, "system");
  assert.equal(record.args[record.args.indexOf("--tools") + 1], "", "the CLI's own tools are off");
  assert.equal(record.args[record.args.indexOf("--allowedTools") + 1], "mcp__arcbot__arco_run_macro");
  assert.equal(record.args[record.args.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.deepEqual(fs.readdirSync(path.join(testRoot, "claude-cwd")), [], "the system prompt file is removed");
});

test("a failing tool reports the error to Claude instead of ending the turn", async () => {
  const { result, record } = await claudeRequest({
    tools: [{ name: "arco_project_read", description: "d", inputSchema: { type: "object" } }],
    runTool: async () => { throw new Error("No project is open"); },
  }, { FAKE_CLAUDE_TOOL_CALL: JSON.stringify({ name: "arco_project_read", arguments: {} }) });
  assert.equal(result.ok, true);
  assert.deepEqual(record.toolAnswers, [{ content: [{ type: "text", text: "No project is open" }], isError: true }]);
});

test("without tools no MCP server is given, and earlier messages travel in the prompt", async () => {
  const { result, record } = await claudeRequest({
    messages: [
      { role: "user", content: "What is a DFM?" },
      { role: "assistant", content: "A development factor method." },
      { role: "user", content: "And its tail?" },
    ],
  }, { FAKE_CLAUDE_REPLY: JSON.stringify(["Hello."]) });
  assert.deepEqual(result, { ok: true, stdout: "Hello." });
  assert.equal(record.args.includes("--mcp-config"), false);
  assert.match(record.prompt, /^Earlier in this chat:\n\nUser:\nWhat is a DFM\?\n\nArcBot:\nA development factor method\./u);
  assert.match(record.prompt, /The user's new message:\n\nAnd its tail\?$/u);
});

test("text from separate model messages is joined with a blank line", async () => {
  const { result } = await claudeRequest({}, { FAKE_CLAUDE_REPLY: JSON.stringify(["Reading the triangle.", "Done."]) });
  assert.deepEqual(result, { ok: true, stdout: "Reading the triangle.\n\nDone." });
});

test("thinking and commentary stream to the work log while the reply streams to the bubble", async () => {
  const { result, sent } = await claudeRequest({}, {
    FAKE_CLAUDE_REPLY: JSON.stringify([
      { thinking: ["Reading ", "the triangle."], text: "I'll open the triangle.", toolCall: true },
      { text: "Done." },
    ]),
  });
  assert.deepEqual(result, { ok: true, stdout: "Done." });
  const ofType = (type) => sent.filter((payload) => payload.type === type);
  assert.deepEqual(ofType("thinking").map(({ text, itemId }) => ({ text, itemId })), [
    { text: "Reading ", itemId: "thinking-1" },
    { text: "Reading the triangle.", itemId: "thinking-1" },
  ]);
  assert.deepEqual(ofType("thinking-tokens").map((payload) => payload.tokens), [40, 80]);
  assert.deepEqual(ofType("commentary").map(({ text }) => text), ["I'll open the triangle."]);
  const lastReset = sent.findLastIndex((payload) => payload.type === "assistant-reset");
  assert.ok(lastReset >= 0, "the commentary is taken back out of the bubble");
  assert.equal(sent.slice(lastReset + 1).filter((payload) => payload.type === "assistant-delta").map(({ text }) => text).join(""), "Done.");
});

test("a signed-out CLI asks for sign-in", async () => {
  const { result } = await claudeRequest({}, { FAKE_CLAUDE_SIGNED_OUT: "1" });
  assert.equal(result.ok, false);
  assert.equal(result.needsAuth, true);
  assert.match(result.error, /Not logged in/u);
});

test("the tool endpoint refuses a caller without the turn's token", async () => {
  const endpoint = await startToolEndpoint([], async () => "");
  try {
    const answer = await fetch(endpoint.url, { method: "POST", body: "{}" });
    assert.equal(answer.status, 401);
  } finally {
    await endpoint.close();
  }
});

test("behind a re-signing proxy the model list retries once with the Windows roots", { skip: process.platform !== "win32" }, async () => {
  const original = https.request;
  const agents = [];
  https.request = (options, onResponse) => {
    agents.push(options.agent);
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      if (agents.length === 1) {
        req.emit("error", Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      onResponse(res);
      res.emit("data", JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }] }));
      res.emit("end");
    });
    return req;
  };
  try {
    assert.deepEqual(await testHooks.listClaudeModelEntries("token"), [{ id: "claude-sonnet-5-5" }]);
  } finally {
    https.request = original;
  }
  assert.equal(agents.length, 2);
  assert.ok(agents[1]?.options?.ca?.length > 0);
});
