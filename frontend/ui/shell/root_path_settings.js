import { $, shell } from "./shell_context.js?v=20260510a";

let rootPathModalWired = false;
const DEFAULT_ROOT_PATH = "E:\\ArcRho Server";

function setRootPathSetupMessage(text, isError = false) {
  const msg = $("rootPathSetupMessage");
  if (!msg) return;
  msg.textContent = text || "";
  msg.classList.toggle("error", !!isError);
}

function notifyServerConnectionUpdated(config) {
  try {
    window.dispatchEvent(new CustomEvent("arcrho:server-connection-updated", { detail: { config } }));
  } catch {}
  shell.notifyServerConnectionUpdated?.(config);
}

async function scanInitialServerPath(input) {
  const hostApi = shell.getHostApi?.();
  if (!hostApi || typeof hostApi.findArcRhoServerRoot !== "function") {
    setRootPathSetupMessage("First-time setup: select Browse or enter the server root path manually.", true);
    return;
  }

  setRootPathSetupMessage("First-time setup: searching drives D: through Z: for Arco Server...");
  try {
    const result = await hostApi.findArcRhoServerRoot();
    const foundPath = String(result?.path || "").trim();
    if (foundPath) {
      input.value = foundPath;
      setRootPathSetupMessage(`The server path ${foundPath} was found and selected automatically. To select a different path, click Browse.`);
      return;
    }
    setRootPathSetupMessage(
      "First-time setup: Arco Server was not found on drives D: through Z:. Select Browse or enter the root path manually.",
      true,
    );
  } catch (err) {
    setRootPathSetupMessage(
      `First-time setup: automatic server path search failed. Select Browse or enter the root path manually. ${err?.message || err}`,
      true,
    );
  }
}

export async function openRootPathSettingsModal() {
  const overlay = $("rootPathSettingsOverlay");
  const input = $("rootPathInput");
  if (!overlay || !input) return;
  setRootPathSetupMessage("");

  let configExists = true;
  try {
    const res = await fetch("/workspace_paths");
    if (res.ok) {
      const data = await res.json();
      input.value = data.config?.workspace_root || DEFAULT_ROOT_PATH;
      configExists = data.config_exists !== false;
    } else {
      input.value = DEFAULT_ROOT_PATH;
    }
  } catch {
    input.value = DEFAULT_ROOT_PATH;
  }

  overlay.classList.add("open");
  if (!configExists) await scanInitialServerPath(input);
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export function closeRootPathSettingsModal() {
  const overlay = $("rootPathSettingsOverlay");
  if (overlay) overlay.classList.remove("open");
}

export function initRootPathSettingsModal() {
  if (rootPathModalWired) return;
  rootPathModalWired = true;
  const overlay = $("rootPathSettingsOverlay");
  const input = $("rootPathInput");
  const browseBtn = $("rootPathBrowseBtn");
  const applyBtn = $("rootPathApplyBtn");
  const cancelBtn = $("rootPathCancelBtn");
  if (!overlay || !input || !browseBtn || !applyBtn || !cancelBtn) return;

  browseBtn.addEventListener("click", async () => {
    const hostApi = shell.getHostApi?.();
    if (!hostApi || typeof hostApi.pickFolder !== "function") {
      setRootPathSetupMessage("Folder browsing is unavailable. Enter the server root path manually.", true);
      return;
    }
    try {
      const picked = await hostApi.pickFolder((input.value || "").trim());
      const selectedPath = String(picked || "").trim();
      if (!selectedPath) return;
      input.value = selectedPath;
      setRootPathSetupMessage(`Server path selected: ${selectedPath}`);
      input.focus();
    } catch (err) {
      setRootPathSetupMessage(`Folder selection failed: ${err?.message || err}`, true);
    }
  });

  applyBtn.addEventListener("click", async () => {
    const newPath = (input.value || "").trim();
    if (!newPath) {
      alert("Please enter a valid path.");
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = "Saving...";
    try {
      const res = await fetch("/workspace_paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_root: newPath })
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        closeRootPathSettingsModal();
        notifyServerConnectionUpdated(data.config || { workspace_root: newPath });
        shell.updateStatusBar?.("Server connection updated.");
      } else {
        const detail = await res.text().catch(() => "");
        alert(detail || "Failed to save root path.");
      }
    } catch (err) {
      alert("Error saving root path: " + err.message);
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = "Save";
    }
  });

  cancelBtn.addEventListener("click", () => closeRootPathSettingsModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeRootPathSettingsModal();
  });
  window.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeRootPathSettingsModal();
    }
  }, true);
}
