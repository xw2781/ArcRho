import { $, shell } from "./shell_context.js?v=20260510a";

let appShutdownRequested = false;
let appConfirmPromise = null;
const CLEAR_CACHE_RESTORE_KIND = "arcrho-clear-cache-reload-restore-v1";

function appendRefreshParam(rawUrl) {
  try {
    const url = new URL(rawUrl || window.location.href, window.location.href);
    url.searchParams.set("_arcrho_refresh", String(Date.now()));
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    const sep = String(rawUrl || "").includes("?") ? "&" : "?";
    return `${rawUrl || window.location.pathname}${sep}_arcrho_refresh=${Date.now()}`;
  }
}

function reloadShellDocument() {
  const next = appendRefreshParam(window.location.href);
  window.__appRefreshing = true;
  try {
    window.location.replace(next);
  } catch {
    window.location.href = next;
  }
}

export function refreshActiveTab() {
  const t = shell.state?.tabs.find(x => x.id === shell.state.activeId);
  if (!t) return;
  if (t.type === "home") {
    reloadShellDocument();
    return;
  }
  if (t.iframe && t.iframe.tagName === "IFRAME") {
    if (t.type === "workflow") {
      try {
        const inst = t.wfInst || t.id || "";
        if (inst) sessionStorage.setItem(`arcrho_wf_autosave_on_load::${inst}`, "1");
      } catch {}
    }
    try {
      const src = t.iframe.getAttribute("src");
      if (src) {
        t.iframe.setAttribute("src", appendRefreshParam(src));
        return;
      }
      t.iframe.contentWindow?.location?.reload();
    } catch (_) {
      const src = t.iframe.getAttribute("src");
      if (src) t.iframe.setAttribute("src", appendRefreshParam(src));
    }
    return;
  }
  reloadShellDocument();
}

export function customHardRefresh() {
  try { localStorage.removeItem("arcrho_ui_state"); } catch (_) {}
  shell.render?.();
  shell.saveState?.();
}

function requestProjectInstanceStateSnapshots(timeoutMs = 250) {
  const tabs = (shell.state?.tabs || []).filter((tab) => (
    tab?.type === "project_instance"
    && tab.iframe?.contentWindow
  ));
  if (!tabs.length) return Promise.resolve();
  const pending = new Set(tabs.map((tab) => tab.iframe.contentWindow).filter(Boolean));
  if (!pending.size) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve();
    };
    const onMessage = (event) => {
      if (!pending.has(event.source)) return;
      if (event.data?.type !== "arcrho:project-instance-state") return;
      pending.delete(event.source);
      if (!pending.size) finish();
    };
    window.addEventListener("message", onMessage);
    window.setTimeout(finish, timeoutMs);
    for (const tab of tabs) {
      try {
        tab.iframe.contentWindow.postMessage({ type: "arcrho:project-instance-request-state" }, "*");
      } catch {
        pending.delete(tab.iframe.contentWindow);
      }
    }
    if (!pending.size) finish();
  });
}

async function buildClearCacheReloadRestorePayload() {
  await requestProjectInstanceStateSnapshots();
  shell.ensureActiveTabInvariant?.();
  shell.saveState?.();
  const shellState = shell.buildShellStateSnapshot?.();
  if (!shellState) return null;
  return {
    kind: CLEAR_CACHE_RESTORE_KIND,
    createdAt: Date.now(),
    shellState,
  };
}

export async function clearCacheAndReload() {
  let confirmed = false;
  try {
    confirmed = await showAppConfirm({
      title: "Warning",
      message: "Clear cache and reload the app?",
      okText: "Reload",
      cancelText: "Cancel",
    });
  } catch {
    confirmed = window.confirm("Clear cache and reload the app?");
  }
  if (!confirmed) {
    shell.updateStatusBar?.("Clear Cache & Reload canceled.");
    return;
  }
  shell.updateStatusBar?.("Preparing cache reload...");
  let restore = null;
  try {
    restore = await buildClearCacheReloadRestorePayload();
  } catch (err) {
    console.warn("Could not build Clear Cache & Reload restore payload:", err);
  }
  const hostApi = shell.getHostApi?.();
  if (typeof hostApi?.clearCacheAndReload === "function") {
    try {
      shell.updateStatusBar?.("Clearing cache and reloading...");
      const result = await hostApi.clearCacheAndReload({ restore });
      if (result !== false) return;
      shell.updateStatusBar?.("Host cache reload was unavailable; using browser reload...");
    } catch (err) {
      console.warn("Host Clear Cache & Reload failed; falling back to browser reload:", err);
      shell.updateStatusBar?.("Host cache reload failed; using browser reload...");
    }
  }
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}
  try { window.location.reload(); } catch {}
}

function waitForServerThenReload(timeoutMs = 15000) {
  const start = Date.now();
  const attempt = async () => {
    try {
      await fetch("/", { cache: "no-store" });
      window.location.reload();
      return;
    } catch {}
    if (Date.now() - start >= timeoutMs) {
      window.location.reload();
      return;
    }
    setTimeout(attempt, 800);
  };
  setTimeout(attempt, 800);
}

export async function restartApplication() {
  window.__appRestarting = true;
  shell.updateStatusBar?.("Restarting application...");
  try { await fetch("/app/restart", { method: "POST" }); } catch {}
  try { await fetch("/app/restart_electron", { method: "POST" }); } catch {}
  waitForServerThenReload();
}

export function sendShutdownSignal() {
  const hostApi = shell.getHostApi?.();
  if (hostApi?.shutdownApp) {
    try { hostApi.shutdownApp(); } catch {}
    return;
  }
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/app/shutdown");
      return;
    }
  } catch {}
  try { fetch("/app/shutdown", { method: "POST", keepalive: true }); } catch {}
}

export function showAppConfirm({ title, message, okText, cancelText } = {}) {
  if (appConfirmPromise) return appConfirmPromise;
  const overlay = $("appConfirmOverlay");
  const titleEl = $("appConfirmTitle");
  const messageEl = $("appConfirmMessage");
  const okBtn = $("appConfirmOk");
  const cancelBtn = $("appConfirmCancel");
  if (!overlay || !titleEl || !messageEl || !okBtn || !cancelBtn) {
    return Promise.resolve(window.confirm(message || "Quit the application?"));
  }
  titleEl.textContent = title || "Warning";
  messageEl.textContent = message || "Quit the application?";
  okBtn.textContent = okText || "Quit";
  cancelBtn.textContent = cancelText || "Cancel";
  overlay.classList.add("open");
  appConfirmPromise = new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.remove("open");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      window.removeEventListener("keydown", onKey, true);
      appConfirmPromise = null;
    };
    const finish = (result) => { cleanup(); resolve(result); };
    const onOk = (e) => { e.preventDefault(); finish(true); };
    const onCancel = (e) => { e.preventDefault(); finish(false); };
    const onOverlay = (e) => { if (e.target === overlay) finish(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); return; }
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    window.addEventListener("keydown", onKey, true);
    setTimeout(() => { try { cancelBtn.focus(); } catch {} }, 0);
  });
  return appConfirmPromise;
}

export function shutdownApplication() {
  if (appShutdownRequested) return;
  showAppConfirm({ title: "Warning", message: "Quit the application?", okText: "Quit" })
    .then((ok) => {
      if (!ok) {
        shell.updateStatusBar?.("Shutdown canceled.");
        return;
      }
      appShutdownRequested = true;
      shell.updateStatusBar?.("Shutting down...");
      sendShutdownSignal();
      setTimeout(() => { try { window.close(); } catch {} }, 200);
    })
    .catch(() => { shell.updateStatusBar?.("Shutdown canceled."); });
}

export function initAppLifecycle() {
  window.__arcrho_confirm_app_shutdown = function () {
    return showAppConfirm({ title: "Warning", message: "Quit the application?", okText: "Quit" });
  };
  window.addEventListener("beforeunload", () => {
    // Shutdown is handled by explicit Quit actions and the Electron window close path.
    // Treating every document unload as shutdown makes ordinary reloads quit the app.
  });
}
