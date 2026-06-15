export function formatContextPercent(value) {
  const percent = Math.max(0, Math.min(100, Number(value || 0)));
  if (!Number.isFinite(percent)) return "0%";
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

export function formatTokenCount(value) {
  const tokens = Math.max(0, Math.round(Number(value || 0)));
  return tokens ? tokens.toLocaleString() : "0";
}

export function getUsagePercent(usage) {
  const explicit = Number(usage?.contextPercentUsed);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.min(100, explicit);
  const used = Number(usage?.estimatedTokens || 0);
  const windowTokens = Number(usage?.contextWindowTokens || 0);
  if (!used || !windowTokens) return 0;
  return Math.min(100, Math.max(0, (used / windowTokens) * 100));
}

export function formatContextWindowUsage(usage) {
  const used = Number(usage?.estimatedTokens || 0);
  const windowTokens = Number(usage?.contextWindowTokens || 0);
  if (!used || !windowTokens) return "Not measured yet";
  return `${formatTokenCount(used)} / ${formatTokenCount(windowTokens)} tokens (${formatContextPercent(getUsagePercent(usage))})`;
}

export function normalizeAssistantContextForPanel(context, activeTab = null) {
  const source = context && typeof context === "object" ? context : {};
  const fallbackTab = activeTab || {};
  return {
    available: !!source.available,
    tabType: source.tabType || source.pageType || fallbackTab.type || "home",
    pageType: source.pageType || "",
    nestedPageType: source.nestedPageType || "",
    title: source.title || fallbackTab.title || "",
    targetPath: source.targetPath || source.methodPath || source.path || "",
    fileState: source.disabled ? "disabled" : (source.fileState || (source.dirty ? "unsaved-changes" : "")),
    activeNestedWindow: source.activeNestedWindow || null,
    openNestedWindows: Array.isArray(source.openNestedWindows) ? source.openNestedWindows : [],
    ignoredMinimizedWindowCount: Number.isFinite(source.ignoredMinimizedWindowCount)
      ? Math.max(0, Math.round(source.ignoredMinimizedWindowCount))
      : 0,
    projectInstance: source.projectInstance || null,
  };
}
