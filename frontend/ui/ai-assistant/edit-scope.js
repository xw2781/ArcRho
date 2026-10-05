// Recheck the originating page immediately before handing over an edit.
export function arcBotEditScopeError(tabId, activeId, context, targetPath) {
  if (!tabId || activeId !== tabId) return "The page ArcBot worked on must still be active. Nothing was changed.";
  const comparable = value => String(value || "").replace(/[\\/]+/g, "/").toLowerCase();
  if (!context?.available || context.disabled || (targetPath && comparable(context.targetPath || context.methodPath || context.path) !== comparable(targetPath))) {
    return "The method window ArcBot worked on is no longer active. Nothing was changed.";
  }
  return "";
}
