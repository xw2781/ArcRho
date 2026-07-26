import {
  confirmResultSelectionRpcBridgeAction,
  createResultSelectionRpcBridgeDialog,
  createResultSelectionRpcBridgeMessageBox,
} from "/ui/method_pages/result_selection/result_selection_rpc_bridge_dialog.js?v=20260626a";

let syncInFlight = false;

function cleanText(value) {
  return String(value ?? "").trim();
}

async function postJson(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.detail || data?.message || `Request failed: ${resp.status}`);
  }
  return data;
}

async function cleanupRemoteTmp(payload, postStatus) {
  if (!payload) return null;
  try {
    return await postJson("/result-selection/rpc-bridge/cleanup", payload);
  } catch (err) {
    postStatus?.(`Result Selection sync cleanup failed: ${String(err?.message || err)}`, "warn");
    return null;
  }
}

function buildRequestPayload(context) {
  const details = context.getDetails?.() || {};
  return {
    project_name: cleanText(context.getProject?.()),
    reserving_class: cleanText(context.getReservingClass?.()),
    method_name: cleanText(details.name),
    output_type: cleanText(details.outputType),
    origin_length: Number(details.originLength || 12),
    timeout_sec: 8.0,
  };
}

function validatePayload(payload) {
  const missing = [];
  if (!payload.project_name) missing.push("Project");
  if (!payload.reserving_class) missing.push("Reserving Class");
  if (!payload.method_name) missing.push("Name");
  if (!payload.origin_length) missing.push("Origin Length");
  return missing;
}

async function ensureSavedBeforeSync(dialog, context) {
  if (!context.getIsDirty?.()) return true;
  const shouldSave = window.confirm("This Result Selection has unsaved edits. Save and proceed with sync?");
  if (!shouldSave) return false;
  dialog.setWaiting("Saving current Result Selection before sync...");
  const result = await context.save?.();
  if (!result?.ok) {
    dialog.setMessage(result?.error ? `Save failed: ${result.error}` : "Save was canceled. Sync stopped.", "error");
    return false;
  }
  return true;
}

async function refreshComparison(dialog, payload) {
  dialog.setBusy(true);
  try {
    const data = await postJson("/result-selection/rpc-bridge/compare", payload);
    dialog.setComparison(data, {
      onRefresh: () => refreshComparison(dialog, payload),
      onPrimary: (action) => runPrimaryAction(dialog, payload, action),
    });
  } catch (err) {
    dialog.setMessage(String(err?.message || err), "error");
  } finally {
    dialog.setBusy(false);
  }
}

async function runPrimaryAction(dialog, payload, action) {
  const context = dialog.__rsContext || {};
  const postStatus = context.postStatus || (() => {});
  let actionPayload = payload;
  if (action === "update-remote") {
    const confirmed = await confirmResultSelectionRpcBridgeAction(
      "This action will write the selected Result Selection settings to the RPC server. Continue?",
      { title: "Confirm Remote Update" },
    );
    if (!confirmed) return;
    actionPayload = { ...payload, rpc_server_write_confirmed: true };
  }

  dialog.setBusy(true);
  const statusDialog = createResultSelectionRpcBridgeMessageBox("Preparing selected Result Selection version action...");
  let persistedMutation = null;
  statusDialog.setBusy(true);
  dialog.close("primary-action");
  try {
    if (action === "update-local") {
      persistedMutation = context.beginPersistedMutation?.() || null;
      statusDialog.setWaiting("Updating local Result Selection JSON from ResQ...");
      const data = await postJson("/result-selection/rpc-bridge/apply", payload);
      if (!data?.payload || typeof data.payload !== "object") {
        statusDialog.setMessage("Updated JSON file, but the response did not include a reloadable payload.", "warn");
        postStatus("Result Selection sync: local JSON updated, but tab reload was skipped.", "warn");
        return;
      }
      await context.applySavedResult?.(data, persistedMutation);
      statusDialog.setMessage("Local Result Selection updated from ResQ.", "ok");
      postStatus("Result Selection sync: local Result Selection updated from ResQ.");
      return;
    }
    if (action === "update-remote") {
      statusDialog.setWaiting("Sending SyncResultSelection request and waiting for remote result...");
      const data = await postJson("/result-selection/rpc-bridge/update-remote", actionPayload);
      const message = data?.ok ? "Remote Result Selection updated" : (data?.message || "Remote update failed.");
      statusDialog.setMessage(message, data?.ok ? "ok" : "error");
      postStatus(`Result Selection sync: ${message}`, data?.ok ? "" : "warn");
      return;
    }
    if (action === "keep-local") {
      statusDialog.setWaiting("Keeping local Result Selection JSON and removing remote RPC JSON...");
      const data = await postJson("/result-selection/rpc-bridge/keep-local", payload);
      const message = data?.ok ? "No changes made locally." : (data?.message || "Keep local failed.");
      statusDialog.setMessage(message, data?.ok ? "ok" : "error");
      postStatus(`Result Selection sync: ${message}`, data?.ok ? "" : "warn");
      return;
    }
  } catch (err) {
    statusDialog.setMessage(String(err?.message || err), "error");
    postStatus(`Result Selection sync failed: ${String(err?.message || err)}`, "warn");
  } finally {
    context.finishPersistedMutation?.(persistedMutation);
    statusDialog.setBusy(false);
    dialog.setBusy(false);
  }
}

export async function startResultSelectionRpcBridgeSync(context = {}, buttonEl = null) {
  if (syncInFlight) return;
  syncInFlight = true;
  if (buttonEl) buttonEl.disabled = true;
  let cleanupPayload = null;
  let dialogClosed = false;
  let cleanupAfterClose = null;
  const postStatus = context.postStatus || (() => {});
  const cleanupAfterUserClose = () => {
    if (!cleanupPayload || cleanupAfterClose) return;
    cleanupAfterClose = cleanupRemoteTmp(cleanupPayload, postStatus).finally(() => {
      cleanupAfterClose = null;
    });
    window.setTimeout(() => {
      if (cleanupPayload) cleanupRemoteTmp(cleanupPayload, postStatus);
    }, 10000);
  };

  const dialog = createResultSelectionRpcBridgeDialog({
    onClose: (reason) => {
      dialogClosed = true;
      if (reason === "primary-action") return;
      cleanupAfterUserClose();
    },
  });
  dialog.__rsContext = context;
  dialog.setWaiting("Preparing Result Selection sync...");
  try {
    const saved = await ensureSavedBeforeSync(dialog, context);
    if (!saved) return;

    const payload = buildRequestPayload(context);
    const missing = validatePayload(payload);
    if (missing.length) {
      dialog.setMessage(`Complete these fields before syncing: ${missing.join(", ")}.`, "error");
      return;
    }

    cleanupPayload = payload;
    dialog.setWaiting("Sending Result Selection request and waiting for ResQ JSON...");
    const data = await postJson("/result-selection/rpc-bridge/sync", payload);
    if (dialogClosed) {
      await cleanupRemoteTmp(payload, postStatus);
      return;
    }
    if (!data?.ok && data?.status === "timeout") {
      dialog.setMessage("Timed out waiting for ResQ Result Selection JSON. Use Refresh if the remote file appears later.", "warn");
      postStatus("Result Selection sync timed out waiting for ResQ JSON.", "warn");
      return;
    }
    dialog.setComparison(data, {
      onRefresh: () => refreshComparison(dialog, payload),
      onPrimary: (action) => runPrimaryAction(dialog, payload, action),
    });
  } catch (err) {
    dialog.setMessage(String(err?.message || err), "error");
    postStatus(`Result Selection sync failed: ${String(err?.message || err)}`, "warn");
  } finally {
    syncInFlight = false;
    if (buttonEl) buttonEl.disabled = false;
  }
}
