import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createAssistantRunGate } from "../ui/ai-assistant/run-gate.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const { testHooks } = require("../electron/arcbot_host.js");

function fakeAppServerProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.exitCode = null;
  proc.killed = false;
  proc.writes = [];
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  proc.stdin.write = (serialized, callback) => {
    const message = JSON.parse(serialized);
    proc.writes.push(message);
    if (message.method === "initialize") {
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`, "utf8"));
      });
    }
    if (proc.nextWriteError) {
      const error = proc.nextWriteError;
      proc.nextWriteError = null;
      queueMicrotask(() => callback?.(error));
    } else {
      queueMicrotask(() => callback?.());
    }
    return true;
  };
  return proc;
}

function fakeAppServerClient() {
  const processes = [];
  const client = new testHooks.CodexAppServerClient({
    resolveSpawnSpec() {
      return { command: "fake-codex", args: [], shell: false };
    },
    resolveHostCwd() {
      return process.cwd();
    },
    spawnProcess() {
      const proc = fakeAppServerProcess();
      processes.push(proc);
      return proc;
    },
  });
  return { client, processes };
}

test("concurrent ArcBot app-server startup callers receive the shared client", async () => {
  const { client, processes } = fakeAppServerClient();
  const [first, second] = await Promise.all([client.start(), client.start()]);
  assert.equal(first, client);
  assert.equal(second, client);
  assert.equal(processes.length, 1);
  client.stop();
});

test("ArcBot discovers paged Codex models after the app-server handshake", async () => {
  const { client, processes } = fakeAppServerClient();
  await client.startFresh();
  const proc = processes[0];
  assert.equal(proc.writes[0].method, "initialize");

  const listing = client.listModels({ limit: 2, maxPages: 3, timeoutMs: 1000 });
  const firstRequest = proc.writes.at(-1);
  assert.equal(firstRequest.method, "model/list");
  assert.deepEqual(firstRequest.params, { limit: 2, includeHidden: false });
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
    id: firstRequest.id,
    result: { data: [{ model: "gpt-5.6-sol" }], nextCursor: "page-2" },
  })}\n`, "utf8"));
  await Promise.resolve();

  const secondRequest = proc.writes.at(-1);
  assert.equal(secondRequest.method, "model/list");
  assert.equal(secondRequest.params.cursor, "page-2");
  proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
    id: secondRequest.id,
    result: { data: [{ model: "gpt-5.6-terra" }], nextCursor: null },
  })}\n`, "utf8"));

  assert.deepEqual(await listing, [
    { model: "gpt-5.6-sol" },
    { model: "gpt-5.6-terra" },
  ]);
  client.stop();
});

test("ArcBot promotes only advertised GPT-5.6-or-newer models and flags stale catalogs", () => {
  const detected = testHooks.buildCodexModelCatalog([
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "max", description: "Maximum" },
      ],
      defaultReasoningEffort: "medium",
    },
    { model: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
    { model: "gpt-5.6-sol", displayName: "Duplicate", isDefault: false },
    { model: "bad model id", displayName: "Malformed", isDefault: false },
  ]);
  assert.equal(detected.source, "codex-app-server");
  assert.equal(detected.defaultModel, "gpt-5.6-sol");
  assert.equal(detected.models.length, 1);
  assert.deepEqual(
    detected.models[0].supportedReasoningEfforts.map((option) => option.value),
    ["medium", "max"],
  );

  const fallback = testHooks.getFallbackCodexModelCatalog();
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.defaultModel, "codex");
  assert.deepEqual(fallback.models, []);
  assert.equal(fallback.upgradeRequired, false);
  assert.equal(fallback.verified, false);

  const staleRuntime = testHooks.buildCodexModelCatalog([
    { model: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
    { model: "gpt-5.4", displayName: "GPT-5.4", isDefault: false },
  ]);
  assert.equal(staleRuntime.source, "codex-app-server");
  assert.equal(staleRuntime.defaultModel, "gpt-5.5");
  assert.equal(staleRuntime.upgradeRequired, true);
  assert.equal(staleRuntime.verified, true);
  assert.deepEqual(
    staleRuntime.models.slice(0, 2).map((model) => [model.value, model.isDefault]),
    [["gpt-5.5", true], ["gpt-5.4", false]],
  );

  const staleDefaultWithAdvertisedMinimum = testHooks.buildCodexModelCatalog([
    { model: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
    { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: false },
  ]);
  assert.equal(staleDefaultWithAdvertisedMinimum.defaultModel, "gpt-5.6-sol");
  assert.equal(staleDefaultWithAdvertisedMinimum.upgradeRequired, false);
  assert.deepEqual(
    staleDefaultWithAdvertisedMinimum.models.map((model) => [model.value, model.isDefault]),
    [["gpt-5.5", false], ["gpt-5.6-sol", true]],
  );

  const futurePreview = testHooks.buildCodexModelCatalog([
    { model: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
    { model: "gpt-5.7-preview", displayName: "GPT-5.7 Preview", isDefault: false },
  ]);
  assert.equal(futurePreview.defaultModel, "gpt-5.5");
  assert.equal(futurePreview.upgradeRequired, true);

  const futureRuntime = testHooks.buildCodexModelCatalog([
    { model: "gpt-5.7-sol", displayName: "GPT-5.7 Sol", isDefault: true },
  ]);
  assert.equal(futureRuntime.defaultModel, "gpt-5.7-sol");
  assert.equal(futureRuntime.upgradeRequired, false);
  assert.deepEqual(futureRuntime.models.map((model) => model.value), ["gpt-5.7-sol"]);
});

test("ArcBot run gate permits one owner and rejects overlapping runs", () => {
  const gate = createAssistantRunGate();
  const chat = gate.tryAcquire("chat");
  assert.ok(chat);
  assert.equal(gate.owns(chat), true);
  assert.equal(gate.tryAcquire("sql-review"), null);
  assert.equal(gate.release({ kind: "chat" }), false);
  assert.equal(gate.owns(chat), true);
  assert.equal(gate.release(chat), true);
  assert.ok(gate.tryAcquire("sql-review"));
});

test("ArcBot warm turns subscribe before start and route scoped notifications", () => {
  const host = read("../electron/arcbot_host.js");
  const warmTurnStart = host.indexOf("async function runCodexWarmTurn");
  const warmTurnEnd = host.indexOf("function ensureCodexWorkspace", warmTurnStart);
  const source = host.slice(warmTurnStart, warmTurnEnd > warmTurnStart ? warmTurnEnd : undefined);

  const subscribeAt = source.indexOf("client.onNotification(handleTurnNotification)");
  const startAt = source.indexOf('client.request("turn/start"');
  const completionTimeoutAt = source.indexOf("waitTimer = setTimeout", startAt);
  assert.ok(subscribeAt >= 0, "warm turn must subscribe to app-server notifications");
  assert.ok(startAt > subscribeAt, "subscription must be installed before turn/start to avoid losing early deltas");
  assert.ok(completionTimeoutAt > startAt, "completion timeout must not reject before turn/start finishes");

  assert.match(source, /queuedNotifications\.splice\(0\)\.forEach\(handleTurnNotification\)/);
  assert.match(source, /payload\?\.streamDeltas === false/);
  assert.match(source, /"assistant-delta"/);
  assert.match(source, /\.\.\.\(outputSchema \? \{ outputSchema \} : \{\}\)/);

  const delta = { method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a" } };
  assert.equal(testHooks.isCodexNotificationForTurn(delta, { threadId: "thread-a", turnId: "turn-a" }), true);
  assert.equal(testHooks.isCodexNotificationForTurn(delta, { threadId: "thread-b", turnId: "turn-a" }), false);
  assert.equal(testHooks.isCodexNotificationForTurn(delta, { threadId: "thread-a", turnId: "turn-b" }), false);
  assert.equal(testHooks.isCodexNotificationForTurn(delta, { threadId: "thread-a", allowPendingTurn: true }), true);
  assert.equal(testHooks.isCodexNotificationForTurn(delta, { threadId: "thread-b", allowPendingTurn: true }), false);
});

test("ArcBot warm turns honor app-server retry and terminal status semantics", () => {
  const host = read("../electron/arcbot_host.js");
  assert.match(host, /message\.params\?\.willRetry[\s\S]*?Codex is retrying the current turn/);
  assert.match(host, /turnStatus === "failed"[\s\S]*?turn\?\.error\?\.message/);
  assert.match(host, /turnStatus === "interrupted"[\s\S]*?canceled: true/);
  assert.match(host, /type !== "assistant-delta"/);
  assert.deepEqual(
    testHooks.getCodexInterruptParams("thread-a", "turn-a"),
    { threadId: "thread-a", turnId: "turn-a" },
  );
  assert.equal(testHooks.getCodexInterruptParams("thread-a", ""), null);

  const client = new testHooks.CodexAppServerClient();
  const disconnects = [];
  const removeDisconnect = client.onDisconnect((message) => disconnects.push(message));
  client.failAll("app-server closed after turn/start");
  assert.deepEqual(disconnects, ["app-server closed after turn/start"]);
  removeDisconnect();
  client.failAll("ignored after cleanup");
  assert.equal(disconnects.length, 1);
  assert.match(host, /client\.onDisconnect\([\s\S]*?rejectCompletedTurn\(error\)/);
});

test("ArcBot classifies colliding server request IDs before client responses", () => {
  const client = new testHooks.CodexAppServerClient();
  let resolved = false;
  let unsupported = null;
  const timer = setTimeout(() => {}, 1000);
  client.pending.set(7, {
    resolve() { resolved = true; },
    reject() {},
    timer,
  });
  client.respondUnsupported = (id, method) => {
    unsupported = { id, method };
  };

  client.handleMessageLine(JSON.stringify({
    id: 7,
    method: "item/tool/requestUserInput",
    params: {},
  }));

  assert.deepEqual(unsupported, { id: 7, method: "item/tool/requestUserInput" });
  assert.equal(resolved, false);
  assert.equal(client.pending.has(7), true);
  clearTimeout(timer);
  client.pending.delete(7);
});

test("ArcBot ignores stdout and close callbacks from superseded app-server processes", async () => {
  const { client, processes } = fakeAppServerClient();
  await client.startFresh();
  const oldProc = processes[0];
  await client.startFresh();
  const currentProc = processes[1];
  const pending = client.request("thread/start", {}, 1000);
  const pendingId = currentProc.writes.at(-1).id;

  oldProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: pendingId, result: { stale: true } })}\n`));
  oldProc.emit("close", 1, null);

  assert.equal(client.proc, currentProc);
  assert.equal(client.started, true);
  assert.equal(client.pending.has(pendingId), true);
  currentProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: pendingId, result: { current: true } })}\n`));
  assert.deepEqual(await pending, { current: true });
  client.stop();
});

test("ArcBot rejects pending requests on app-server stdin failures", async () => {
  const { client, processes } = fakeAppServerClient();
  await client.startFresh();
  const proc = processes[0];
  const disconnects = [];
  client.onDisconnect((message) => disconnects.push(message));
  const pending = client.request("thread/start", {}, 1000);

  proc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

  await assert.rejects(pending, /input failed: write EPIPE/);
  assert.equal(client.proc, null);
  assert.equal(client.started, false);
  assert.deepEqual(disconnects, ["Codex app-server input failed: write EPIPE"]);
});

test("ArcBot rejects pending requests when stdin write callbacks fail", async () => {
  const { client, processes } = fakeAppServerClient();
  await client.startFresh();
  const proc = processes[0];
  proc.nextWriteError = Object.assign(new Error("callback EPIPE"), { code: "EPIPE" });

  const pending = client.request("thread/start", {}, 1000);

  await assert.rejects(pending, /input failed: callback EPIPE/);
  assert.equal(client.proc, null);
  assert.equal(client.started, false);
});

test("ArcBot preserves split UTF-8 and protocol frames larger than 100 KB", () => {
  const client = new testHooks.CodexAppServerClient();
  const notifications = [];
  client.onNotification((message) => notifications.push(message));
  const delta = `café 🚀 ${"x".repeat(150_000)}`;
  const frame = Buffer.from(`${JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-a", turnId: "turn-a", delta },
  })}\n`, "utf8");
  const rocketStart = frame.indexOf(Buffer.from("🚀", "utf8"));
  const splitAt = rocketStart + 2;

  client.handleStdout(frame.subarray(0, splitAt));
  client.handleStdout(frame.subarray(splitAt, 120_000));
  client.handleStdout(frame.subarray(120_000));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.delta, delta);
});

test("ArcBot emits only current app-server sandbox and thread fields", () => {
  assert.deepEqual(
    testHooks.getCodexSandboxPolicy("read-only", "E:\\workspace"),
    { type: "readOnly", networkAccess: false },
  );
  assert.deepEqual(
    testHooks.getCodexSandboxPolicy("workspace-write", "E:\\workspace"),
    {
      type: "workspaceWrite",
      writableRoots: ["E:\\workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  );
  const host = read("../electron/arcbot_host.js");
  assert.doesNotMatch(host, /experimentalRawEvents|persistExtendedHistory|readableRoots|arcBotCodexThreads/);
});

test("ArcBot starts a fresh ephemeral thread for each bounded transcript", async () => {
  const client = new testHooks.CodexAppServerClient();
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    return { thread: { id: `thread-${requests.length}` } };
  };

  assert.equal(await client.startThread("review", "E:\\workspace", "codex"), "thread-1");
  assert.equal(await client.startThread("review", "E:\\workspace", "gpt-5.6-sol"), "thread-2");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, "thread/start");
    assert.equal(request.params.ephemeral, true);
  }
  assert.equal(requests[0].params.model, null);
  assert.equal(requests[1].params.model, "gpt-5.6-sol");
});

test("ArcBot cancellation during warm startup never starts a model turn", async () => {
  let releaseStartup;
  let startThreadCalls = 0;
  const requestState = { canceled: false };
  const client = {
    async startThread() {
      startThreadCalls += 1;
      return "thread-should-not-start";
    },
  };
  const ensureClient = () => new Promise((resolve) => {
    releaseStartup = () => resolve(client);
  });

  const startup = testHooks.startCodexWarmThread({
    isCanceled: () => requestState.canceled,
    mode: "review",
    codexCwd: "E:\\workspace",
    model: "codex",
    ensureClient,
  });
  requestState.canceled = true;
  releaseStartup();

  assert.deepEqual(await startup, { canceled: true, client, threadId: "" });
  assert.equal(startThreadCalls, 0);
});

test("SQL review requests structured output without streaming raw JSON", () => {
  const assistant = read("../ui/ai-assistant/index.js");
  const sqlReviewStart = assistant.indexOf("async function updateSqlReviewWithLlm");
  const sqlReviewEnd = assistant.indexOf("async function runSqlFormatValidationSkill", sqlReviewStart);
  const sqlReview = assistant.slice(sqlReviewStart, sqlReviewEnd);
  assert.ok(sqlReview.indexOf('assistantRunGate.tryAcquire("sql-review")') < sqlReview.indexOf("await ensureAssistantSession()"));
  assert.match(assistant, /outputSchema: SQL_AI_REVIEW_RESPONSE_SCHEMA/);
  assert.match(assistant, /streamDeltas: false/);
  assert.match(assistant, /renderSqlAiReviewResponse\(result\.text, \{ expectedDialect: dialect \}\)/);
  assert.match(assistant, /requestSqlFormatPreview\(\{ sql: original, dialect \}\)/);
  assert.match(assistant, /activeTab\?\.id !== expectedTabId/);
  assert.match(assistant, /expectedTargetPath: String\(expectedTargetPath \|\| ""\)/);
  assert.match(assistant, /state\.context\?\.tabId === context\?\.tabId/);
  assert.doesNotMatch(assistant, /formatMssqlSql/);
});

test("normal ArcBot chat renders app-server text deltas before final Markdown", () => {
  const assistant = read("../ui/ai-assistant/index.js");
  assert.match(assistant, /event\.type === "assistant-delta"/);
  assert.match(assistant, /currentAssistantStreamText \+= delta/);
  assert.match(assistant, /append\(document\.createTextNode\(delta\)\)/);
  assert.match(assistant, /resolveAssistantPendingMessage\(pending, reply, \{ animate: !currentAssistantStreamText \}\)/);
});
