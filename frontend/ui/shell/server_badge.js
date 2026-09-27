// The title-bar badge naming this window's server whenever it is not production. The server
// cannot change without a restart, so one read as the shell starts is enough; clicking the badge
// opens the Server tab.
import { shell } from "./shell_context.js?v=20260510a";
import { activeServerBadge } from "../server/server_model.js?v=20260927a";

export function renderServerBadge(badge) {
  const button = document.getElementById("titlebarServerBadge");
  if (!button) return;
  button.hidden = !badge;
  if (!badge) return;
  document.getElementById("titlebarServerName").textContent = badge.text;
  button.title = badge.title;
}

export async function initServerBadge() {
  document.getElementById("titlebarServerBadge")?.addEventListener("click", () => shell.openServerTab?.());
  try {
    const response = await fetch("/server_profiles");
    if (response.ok) renderServerBadge(activeServerBadge(await response.json()));
  } catch {
    // No answer leaves the badge hidden, as for production.
  }
}
