// The deck's hover labels, shown on the shell's shared tooltip surface. One place owns the delay
// and the offset from the pointer, so a deck button and a pad tool feel the same to hover over.

import { shell } from "../shell/shell_context.js?v=20260510a";

const TOOLTIP_DELAY_MS = 380;

let tooltipTimer = null;

export function showDeckTooltip(text, event) {
  if (!text) return;
  clearTimeout(tooltipTimer);
  const x = event.clientX + 12;
  const y = event.clientY + 20;
  tooltipTimer = setTimeout(() => shell.showGlobalTooltip?.(text, x, y), TOOLTIP_DELAY_MS);
}

export function hideDeckTooltip() {
  clearTimeout(tooltipTimer);
  shell.hideGlobalTooltip?.();
}
