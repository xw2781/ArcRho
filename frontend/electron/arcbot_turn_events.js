// Preserve protocol evidence for the work log, separate from the final reply.
function arcBotTurnActivity(message) {
  const { method, params = {} } = message || {};
  const item = params.item || {};
  if (method === "item/commandExecution/outputDelta") {
    return { type: "command-output", text: String(params.delta || ""), itemId: params.itemId };
  }
  if (method !== "item/started" && method !== "item/completed") return null;
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command || "");
    return {
      type: "command", itemId: item.id,
      text: `${command}${method === "item/completed" ? `\nExit: ${item.exitCode ?? item.status}` : ""}${item.aggregatedOutput ? `\n${item.aggregatedOutput}` : ""}`,
    };
  }
  if (item.type === "agentMessage" && item.phase === "commentary" && method === "item/completed") {
    return { type: "commentary", text: String(item.text || ""), itemId: item.id };
  }
  if (item.type === "fileChange") {
    return { type: "command", itemId: item.id, text: (item.changes || []).map(change => `${change.path}\n${change.diff || ""}`).join("\n") };
  }
  if (item.type === "mcpToolCall") {
    return { type: "command", itemId: item.id, text: `${item.server}/${item.tool}\n${JSON.stringify(item.arguments || {})}${item.result ? `\n${JSON.stringify(item.result)}` : ""}${item.error ? `\n${JSON.stringify(item.error)}` : ""}` };
  }
  return null;
}

module.exports = { arcBotTurnActivity };
