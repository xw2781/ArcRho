export function clampAssistantPanelSize(width, height, {
  minWidth,
  minHeight,
  maxWidth,
  maxHeight,
  fallbackWidth = minWidth,
  fallbackHeight = minHeight,
}) {
  return {
    width: Math.max(minWidth, Math.min(maxWidth, Number(width) || fallbackWidth)),
    height: Math.max(minHeight, Math.min(maxHeight, Number(height) || fallbackHeight)),
  };
}
