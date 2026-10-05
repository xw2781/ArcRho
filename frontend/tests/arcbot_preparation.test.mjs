import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { arcBotEditScopeError } from "../ui/ai-assistant/edit-scope.js";
const require = createRequire(import.meta.url);
const { PreparedArcBotSessions } = require("../electron/arcbot_prepared_session");
const { arcBotTurnActivity } = require("../electron/arcbot_turn_events");
const { testHooks } = require("../electron/arcbot_host");

function fakeClient() {
  const started = [], released = [];
  return {
    proc: {}, started, released, isAlive: () => true,
    async startThread(...args) { started.push(args); return `thread-${started.length}`; },
    async request(method, params) { released.push([method, params]); },
  };
}
test("prepare races share one empty read-only thread and send consumes it", async () => {
  const pool = new PreparedArcBotSessions(), client = fakeClient();
  const args = [1, "chat-a", "codex", "workspace", client];
  const [prepared, consumed] = await Promise.all([pool.prepare(...args), pool.take(...args)]);
  assert.equal(prepared.threadId, consumed.threadId);
  assert.deepEqual(client.started, [["review", "workspace", "codex"]]);
  assert.equal(pool.entries.size, 0);
  assert.notEqual((await pool.prepare(...args)).threadId, consumed.threadId);
  pool.clear();
});
test("switching model, chat, renderer or process cannot consume an old preparation", async () => {
  const pool = new PreparedArcBotSessions(), client = fakeClient();
  await pool.prepare(1, "a", "m1", "cwd", client);
  await pool.prepare(1, "a", "m2", "cwd", client);
  await pool.prepare(1, "b", "m2", "cwd", client);
  await pool.prepare(2, "b", "m2", "cwd", client);
  client.proc = {};
  await pool.prepare(1, "b", "m2", "cwd", client);
  assert.equal(client.started.length, 5);
  pool.clear();
  await Promise.resolve();
  assert.equal(pool.entries.size, 0);
});
test("failed preparation can be retried", async () => {
  const pool = new PreparedArcBotSessions(), client = fakeClient();
  const start = client.startThread;
  client.startThread = async () => { throw new Error("disconnected"); };
  await assert.rejects(pool.prepare(1, "a", "m", "cwd", client), /disconnected/);
  client.startThread = start;
  assert.equal((await pool.prepare(1, "a", "m", "cwd", client)).threadId, "thread-1");
  pool.clear();
});
test("command events preserve exact commands, output and exit status", () => {
  const item = { id: "cmd1", type: "commandExecution", command: 'python -c "print(42)"', aggregatedOutput: "42\n", exitCode: 0 };
  assert.equal(arcBotTurnActivity({ method: "item/started", params: { item } }).itemId, "cmd1");
  const complete = arcBotTurnActivity({ method: "item/completed", params: { item } });
  assert.equal(complete.text, 'python -c "print(42)"\nExit: 0\n42\n');
  assert.deepEqual(arcBotTurnActivity({ method: "item/commandExecution/outputDelta", params: { itemId: "cmd1", delta: "<raw>\n" } }), { type: "command-output", text: "<raw>\n", itemId: "cmd1" });
});

test("edits refuse switched, closed, disabled and different methods", () => {
  const context = { available: true, targetPath: "E:\\Fake\\Paid.json" };
  assert.equal(arcBotEditScopeError("a", "a", context, "e:/fake/paid.json"), "");
  assert.match(arcBotEditScopeError("a", "b", context, context.targetPath), /still be active/);
  assert.match(arcBotEditScopeError("a", "a", { ...context, available: false }, context.targetPath), /no longer active/);
  assert.match(arcBotEditScopeError("a", "a", { ...context, disabled: true }, context.targetPath), /no longer active/);
  assert.match(arcBotEditScopeError("a", "a", context, "E:/Fake/Other.json"), /no longer active/);
});

test("a completed turn without items returns only the final message and releases its thread", async () => {
  const events = [], requests = [];
  let notify;
  const client = {
    toolHandlers: new Map(),
    async startThread() { return "thread"; },
    onNotification(callback) { notify = callback; return () => {}; },
    onDisconnect() { return () => {}; },
    async request(method) {
      requests.push(method);
      if (method !== "turn/start") return {};
      const send = (method, params) => notify({ method, params: { threadId: "thread", turnId: "turn", ...params } });
      send("item/started", { item: { type: "agentMessage", id: "middle" } });
      send("item/agentMessage/delta", { delta: "Working on it." });
      send("item/completed", { item: { type: "agentMessage", phase: "commentary", text: "Working on it." } });
      send("item/started", { item: { type: "agentMessage", id: "final" } });
      send("item/agentMessage/delta", { delta: "Final result." });
      send("item/completed", { item: { type: "agentMessage", text: "Final result." } });
      send("turn/completed", { turn: { id: "turn", status: "completed" } });
      return { turn: { id: "turn", status: "inProgress" } };
    },
  };
  const result = await testHooks.runCodexWarmTurn({ event: { sender: { send: (_name, event) => events.push(event) } }, requestId: "r", payload: {}, mode: "review", model: "codex", reasoningEffort: "high", codexCwd: "cwd", codexSandbox: "read-only", prompt: "test", ensureClient: async () => client });
  assert.equal(result.stdout, "Final result.");
  assert.equal(events.filter(event => event.type === "assistant-reset").length, 3);
  // Commentary belongs to the work log; its streamed copy never reaches the reply bubble.
  assert.ok(!events.some(event => event.type === "assistant-delta" && event.text.includes("Working on it.")));
  assert.equal(events.find(event => event.type === "commentary").text, "Working on it.");
  assert.ok(requests.includes("thread/unsubscribe"));
});
