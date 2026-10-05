// Composer buttons share the context ring's tooltip bubble instead of the OS title tip.
export function addComposerTip(button, text) {
  if (!button) return null;
  button.removeAttribute("title");
  const tip = document.createElement("span");
  tip.className = "aiAssistantComposerTip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  tip.textContent = text;
  button.append(tip);
  return tip;
}
