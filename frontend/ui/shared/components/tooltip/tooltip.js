const TOOLTIP_STYLE_ID = "arcrho-shared-tooltip-style";
const TOOLTIP_ID = "arcrho-shared-tooltip";
const TOOLTIP_DELAY_MS = 320;
const TOOLTIP_STATES = new WeakMap();

export function ensureArcrhoTooltipStyles(doc = document) {
  if (!doc?.head || doc.getElementById(TOOLTIP_STYLE_ID)) return;
  const existing = Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).some((link) =>
    String(link.getAttribute("href") || "").includes("/ui/shared/styles/tooltips.css"),
  );
  if (existing) return;
  const link = doc.createElement("link");
  link.id = TOOLTIP_STYLE_ID;
  link.rel = "stylesheet";
  link.href = "/ui/shared/styles/tooltips.css?v=20260715a";
  doc.head.appendChild(link);
}

function getTooltipState(doc) {
  const cached = TOOLTIP_STATES.get(doc);
  if (cached?.tooltip?.isConnected) return cached;

  ensureArcrhoTooltipStyles(doc);
  let tooltip = doc.getElementById(TOOLTIP_ID);
  if (!tooltip) {
    tooltip = doc.createElement("div");
    tooltip.id = TOOLTIP_ID;
    tooltip.className = "arcrho-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("aria-hidden", "true");
    doc.body.appendChild(tooltip);
  }
  const state = { anchor: null, showTimer: 0, tooltip };
  TOOLTIP_STATES.set(doc, state);
  return state;
}

function hideTooltip(doc, target = null) {
  const state = TOOLTIP_STATES.get(doc);
  if (!state || (target && state.anchor && state.anchor !== target)) return;
  const view = doc?.defaultView || window;
  if (state.showTimer) view.clearTimeout(state.showTimer);
  state.showTimer = 0;
  state.anchor = null;
  state.tooltip.classList.remove("is-open");
  state.tooltip.setAttribute("aria-hidden", "true");
}

// `placement` "right" opens beside the target, flipping left when the window runs out;
// anything else opens below it, flipping above.
function showTooltip(doc, target, text, placement = "") {
  if (!target?.isConnected || !text) return;
  const state = getTooltipState(doc);
  state.anchor = target;
  state.showTimer = 0;
  state.tooltip.textContent = text;
  state.tooltip.classList.remove("is-open");
  state.tooltip.setAttribute("aria-hidden", "false");

  const view = doc.defaultView || window;
  const rect = target.getBoundingClientRect();
  const tooltipRect = state.tooltip.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const viewportWidth = Number(view?.innerWidth || doc.documentElement.clientWidth || 0);
  const viewportHeight = Number(view?.innerHeight || doc.documentElement.clientHeight || 0);
  let left = rect.left + (rect.width - tooltipRect.width) / 2;
  let top = rect.bottom + gap;
  if (placement === "right") {
    left = rect.right + gap;
    top = rect.top + (rect.height - tooltipRect.height) / 2;
    if (left + tooltipRect.width > viewportWidth - margin) left = rect.left - tooltipRect.width - gap;
  } else if (top + tooltipRect.height > viewportHeight - margin) {
    top = rect.top - tooltipRect.height - gap;
  }
  left = Math.max(margin, Math.min(left, viewportWidth - tooltipRect.width - margin));
  top = Math.max(margin, Math.min(top, viewportHeight - tooltipRect.height - margin));
  state.tooltip.style.left = `${Math.round(left)}px`;
  state.tooltip.style.top = `${Math.round(top)}px`;
  state.tooltip.classList.add("is-open");
}

export function attachArcrhoTooltip(target, rawText, options = {}) {
  const textProvider = typeof rawText === "function" ? rawText : null;
  const text = textProvider ? "" : String(rawText || "").trim();
  const doc = options.document || target?.ownerDocument || document;
  if (!target || (!textProvider && !text) || !doc?.body) return;
  target.removeAttribute("title");
  if (text) target.setAttribute("aria-description", text);

  let generation = 0;
  const showResolvedTooltip = (requestGeneration) => {
    let providedText;
    try {
      providedText = textProvider ? textProvider() : text;
    } catch (_error) {
      return;
    }
    Promise.resolve(providedText).then((value) => {
      const resolvedText = String(value ?? "").trim();
      const state = TOOLTIP_STATES.get(doc);
      if (
        requestGeneration !== generation
        || state?.anchor !== target
        || !target.isConnected
        || !resolvedText
      ) return;
      target.setAttribute("aria-description", resolvedText);
      showTooltip(doc, target, resolvedText, options.placement);
    }).catch(() => {});
  };

  const schedule = () => {
    generation += 1;
    const requestGeneration = generation;
    hideTooltip(doc);
    const state = getTooltipState(doc);
    state.anchor = target;
    const view = doc.defaultView || window;
    state.showTimer = view.setTimeout(
      () => showResolvedTooltip(requestGeneration),
      TOOLTIP_DELAY_MS,
    );
  };
  target.addEventListener("mouseenter", schedule);
  const cancel = () => {
    generation += 1;
    hideTooltip(doc, target);
  };
  target.addEventListener("mouseleave", cancel);
  target.addEventListener("mousedown", cancel);
  target.addEventListener("focus", () => {
    generation += 1;
    const requestGeneration = generation;
    hideTooltip(doc);
    getTooltipState(doc).anchor = target;
    showResolvedTooltip(requestGeneration);
  });
  target.addEventListener("blur", cancel);
}
