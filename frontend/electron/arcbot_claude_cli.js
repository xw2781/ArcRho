const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

// ArcBot's Claude turns run through the Claude Code CLI: a Claude subscription
// sign-in is accepted only from Claude Code, not from a direct API call. The
// CLI gets ArcBot's system prompt, none of its own tools, and ArcBot's tools
// through an MCP server this module serves on 127.0.0.1 for the one turn.
const MCP_SERVER_NAME = "arcbot";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_CALLS = 24;

function mcpToolName(name) {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Answers the MCP calls the CLI makes: the handshake, the tool list, and tool calls.
async function answerMcpMessage(message, tools, callTool) {
  const { id, method, params } = message || {};
  if (id === undefined || id === null) return null; // a notification
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
    });
  }
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") {
    return jsonRpcResult(id, {
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    });
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    if (!tools.some((tool) => tool.name === name)) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      const text = await callTool(name, params?.arguments || {});
      return jsonRpcResult(id, { content: [{ type: "text", text: String(text) }] });
    } catch (error) {
      return jsonRpcResult(id, {
        content: [{ type: "text", text: String(error?.message || error || "Tool call failed.") }],
        isError: true,
      });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// Serves `tools` as a Streamable HTTP MCP server that only the bearer of `token` may call.
function startToolEndpoint(tools, runTool) {
  const token = crypto.randomBytes(24).toString("hex");
  let calls = 0;
  const callTool = (name, args) => {
    calls += 1;
    if (calls > MAX_TOOL_CALLS) throw new Error(`This turn has used its ${MAX_TOOL_CALLS} tool calls.`);
    return runTool({ tool: name, arguments: args, callId: `cli-${calls}` });
  };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 200 : 405).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
        return;
      }
      const batch = Array.isArray(parsed);
      const answers = (await Promise.all((batch ? parsed : [parsed]).map((message) => answerMcpMessage(message, tools, callTool))))
        .filter(Boolean);
      if (!answers.length) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(batch ? answers : answers[0]));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      token,
      close: () => new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
    }));
  });
}

// The CLI takes one prompt, so earlier messages of the chat travel inside it.
function buildCliPrompt(messages) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim());
  if (!turns.length) return "";
  const latest = String(turns[turns.length - 1].content);
  if (turns.length === 1) return latest;
  const history = turns.slice(0, -1)
    .map((m) => `${m.role === "user" ? "User" : "ArcBot"}:\n${m.content}`)
    .join("\n\n");
  return `Earlier in this chat:\n\n${history}\n\nThe user's new message:\n\n${latest}`;
}

function cliArgs({ model, effort, systemPromptFile, endpoint, tools }) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--tools", "",
    "--permission-mode", "dontAsk",
    // Summaries of the model's thinking stream as it thinks, so the work log can show them.
    "--thinking-display", "summarized",
    "--system-prompt-file", systemPromptFile,
    "--model", model,
  ];
  if (effort) args.push("--effort", effort);
  if (endpoint && tools.length) {
    args.push("--mcp-config", JSON.stringify({
      mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } },
    }));
    args.push("--allowedTools", tools.map((tool) => mcpToolName(tool.name)).join(","));
  }
  return args;
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  } else {
    child.kill();
  }
}

// Runs one ArcBot turn through the CLI and reports progress as it streams:
// - onText(chunk): the reply as it is written;
// - onReset(text): the message just streamed was commentary before a tool call,
//   so the reply goes back to `text`, and onCommentary({ id, text }) gets it;
// - onThinking({ id, text }): the summary of one thinking block so far;
// - onThinkingTokens(total): the running estimate of thinking tokens this turn.
// The result is { ok, stdout, usage } or { ok: false, error }.
async function runClaudeCliTurn({
  command, commandArgs = [], env, cwd, model, effort, systemText, messages,
  tools = [], runTool = null, requestState = null,
  onText = () => {}, onReset = () => {}, onCommentary = () => {}, onThinking = () => {}, onThinkingTokens = () => {},
}) {
  const prompt = buildCliPrompt(messages);
  if (!prompt) return { ok: false, error: "No messages to send." };
  fs.mkdirSync(cwd, { recursive: true });
  const systemPromptFile = path.join(cwd, `.arcbot-system-${crypto.randomBytes(6).toString("hex")}.md`);
  fs.writeFileSync(systemPromptFile, systemText, "utf8");
  const endpoint = tools.length && runTool ? await startToolEndpoint(tools, runTool) : null;
  try {
    return await new Promise((resolve) => {
      const child = spawn(command, [...commandArgs, ...cliArgs({ model, effort, systemPromptFile, endpoint, tools })], {
        cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "";
      let stderr = "";
      let reply = "";
      let replyBeforeMessage = "";
      let messageText = "";
      let messageCount = 0;
      let thinkingText = "";
      let thinkingBlocks = 0;
      let thinkingTokens = 0;
      let result = null;
      const usage = { inputTokens: 0, outputTokens: 0 };
      if (requestState) requestState.cancelProcess = () => { killTree(child); return true; };
      const handleStreamEvent = (evt) => {
        if (evt.type === "message_start") {
          messageCount += 1;
          messageText = "";
          replyBeforeMessage = reply;
        } else if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
          thinkingBlocks += 1;
          thinkingText = "";
        } else if (evt.type === "content_block_delta" && evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
          thinkingText += evt.delta.thinking;
          onThinking({ id: `thinking-${thinkingBlocks}`, text: thinkingText });
        } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
          const chunk = `${!messageText && reply ? "\n\n" : ""}${evt.delta.text}`;
          messageText += evt.delta.text;
          reply += chunk;
          onText(chunk);
        } else if (evt.type === "message_delta" && evt.delta?.stop_reason === "tool_use" && messageText.trim()) {
          reply = replyBeforeMessage;
          onReset(reply);
          onCommentary({ id: `commentary-${messageCount}`, text: messageText.trim() });
        }
      };
      const handleLine = (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === "stream_event") {
          handleStreamEvent(message.event || {});
        } else if (message.type === "system" && message.subtype === "thinking_tokens") {
          thinkingTokens += Number(message.estimated_tokens_delta || 0);
          onThinkingTokens(thinkingTokens);
        } else if (message.type === "result") {
          result = message;
          usage.inputTokens = Number(message.usage?.input_tokens || 0)
            + Number(message.usage?.cache_read_input_tokens || 0)
            + Number(message.usage?.cache_creation_input_tokens || 0);
          usage.outputTokens = Number(message.usage?.output_tokens || 0);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handleLine);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => resolve({ ok: false, error: `Claude CLI could not start: ${error.message}` }));
      child.on("close", (code) => {
        if (buffer.trim()) handleLine(buffer);
        if (requestState?.canceled) {
          resolve({ ok: false, canceled: true, error: "Request canceled." });
        } else if (result && !result.is_error) {
          resolve({ ok: true, stdout: reply || String(result.result || ""), usage });
        } else {
          const detail = String(result?.result || result?.errors?.join?.("\n") || stderr || `Claude CLI exited with code ${code}.`).trim();
          resolve({ ok: false, needsAuth: /log ?in|authenticat|401/iu.test(detail), error: detail.slice(0, 600) });
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  } finally {
    if (endpoint) await endpoint.close();
    fs.rmSync(systemPromptFile, { force: true });
  }
}

module.exports = { buildCliPrompt, mcpToolName, runClaudeCliTurn, startToolEndpoint };
