export function nowIso() {
  return new Date().toISOString();
}

export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const rawRole = String(message?.role || "").toLowerCase();
    if (rawRole === "system") return null;
    return {
      role: rawRole === "assistant" ? "assistant" : "user",
      content: String(message?.content || ""),
      timestamp: String(message?.timestamp || nowIso()),
    };
  }).filter((message) => message?.content.trim());
}

export function normalizeActivities(activities) {
  if (!Array.isArray(activities)) return [];
  return activities.map((activity) => ({
    type: String(activity?.type || "info"),
    text: String(activity?.text || ""),
    rawText: String(activity?.rawText || ""),
    elapsedMs: Number.isFinite(activity?.elapsedMs) ? Math.max(0, Math.round(activity.elapsedMs)) : null,
    timestamp: String(activity?.timestamp || nowIso()),
  })).filter((activity) => activity.text.trim()).slice(-120);
}

export function normalizeDebugLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs.map((entry) => ({
    type: String(entry?.type || "debug"),
    text: String(entry?.text || ""),
    timestamp: String(entry?.timestamp || nowIso()),
  })).filter((entry) => entry.text.trim()).slice(-300);
}
