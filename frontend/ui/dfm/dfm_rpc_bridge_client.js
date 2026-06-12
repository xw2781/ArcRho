import {
  getDfmIsDirty,
  getEffectiveDevLabelsForModel,
  getResolvedProjectName,
  getResolvedReservingClass,
  markDfmDirty,
  getRatioHeaderLabels,
  state,
} from "/ui/dfm/dfm_state.js";
import { applyDfmMethodPayload, saveRatioSelectionPattern } from "/ui/dfm/dfm_persistence.js?v=20260611a";
import {
  confirmDfmRpcBridgeAction,
  createDfmRpcBridgeDialog,
  createDfmRpcBridgeMessageBox,
} from "/ui/dfm/dfm_rpc_bridge_dialog.js?v=20260514c";

let syncInFlight = false;

function textValue(id) {
  return String(document.getElementById(id)?.value || "").trim();
}

function numberValue(id, fallback) {
  const raw = Number.parseInt(textValue(id), 10);
  return Number.isFinite(raw) ? raw : fallback;
}

function buildRequestPayload() {
  return {
    project_name: getResolvedProjectName() || textValue("projectSelect"),
    reserving_class: getResolvedReservingClass() || textValue("pathInput"),
    method_name: textValue("dfmMethodName"),
    output_vector: textValue("dfmOutputVector"),
    input_triangle: textValue("triInput"),
    origin_length: numberValue("originLenSelect", 12),
    development_length: numberValue("devLenSelect", 12),
    decimal_places: numberValue("decimalPlaces", 4),
    timeout_sec: 8.0,
  };
}

function validatePayload(payload) {
  const missing = [];
  if (!payload.project_name) missing.push("Project");
  if (!payload.reserving_class) missing.push("Reserving Class");
  if (!payload.method_name) missing.push("Name");
  if (!payload.output_vector) missing.push("Output Vector");
  if (!payload.input_triangle) missing.push("Input Triangle");
  if (!payload.origin_length) missing.push("Origin Length");
  if (!payload.development_length) missing.push("Development Length");
  return missing;
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

async function cleanupRemoteTmp(payload) {
  if (!payload) return null;
  try {
    return await postJson("/dfm/rpc-bridge/cleanup", payload);
  } catch (err) {
    postStatus(`DFM sync cleanup failed: ${String(err?.message || err)}`, "warn");
    return null;
  }
}

function postStatus(text, tone = "") {
  window.parent.postMessage({ type: "arcrho:status", text, ...(tone ? { tone } : {}) }, "*");
}

function formatApplyResultMessage(data) {
  const missing = Array.isArray(data?.sync_report?.missing_components)
    ? data.sync_report.missing_components
    : [];
  if (!missing.length) return { text: "Local updated.", tone: "ok" };
  const lines = [
    "Local updated, but these RPC components were missing and could not be synced:",
    ...missing.map((name) => `- ${name}`),
  ];
  return { text: lines.join("\n"), tone: "warn" };
}

function buildCurrentPatternLabelFallbacks() {
  const model = state?.model || {};
  const originLabels = Array.isArray(model.origin_labels)
    ? model.origin_labels.map((label) => String(label ?? ""))
    : [];
  const ratioLabels = getRatioHeaderLabels(getEffectiveDevLabelsForModel(model));
  const developmentLabels = ratioLabels.map((label, index) => {
    const text = String(label ?? "");
    if (index === ratioLabels.length - 1) return text || "Ult";
    return text ? `(${index + 1}) ${text}` : `(${index + 1})`;
  });
  return {
    origin_labels: originLabels,
    development_labels: developmentLabels,
  };
}

async function ensureSavedBeforeSync(dialog) {
  if (!getDfmIsDirty()) return true;
  const shouldSave = window.confirm("This DFM tab has unsaved edits. Save and proceed with sync?");
  if (!shouldSave) return false;
  dialog.setWaiting("Saving current DFM method before sync...");
  const result = await saveRatioSelectionPattern(false);
  if (!result?.ok) {
    dialog.setMessage(result?.error ? `Save failed: ${result.error}` : "Save was canceled. Sync stopped.", "error");
    return false;
  }
  return true;
}

async function refreshComparison(dialog, payload) {
  dialog.setBusy(true);
  try {
    const data = await postJson("/dfm/rpc-bridge/compare", payload);
    dialog.setComparison(data, {
      labelFallbacks: buildCurrentPatternLabelFallbacks(),
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
  let actionPayload = payload;
  if (action === "update-remote") {
    const confirmed = await confirmDfmRpcBridgeAction(
      "This action will write the selected DFM settings to the RPC server. Continue?",
      { title: "Confirm Remote Update" },
    );
    if (!confirmed) return;
    actionPayload = { ...payload, rpc_server_write_confirmed: true };
  }

  dialog.setBusy(true);
  const statusDialog = createDfmRpcBridgeMessageBox("Preparing selected DFM version action...");
  statusDialog.setBusy(true);
  dialog.close("primary-action");
  try {
    if (action === "update-local") {
      statusDialog.setWaiting("Updating local DFM JSON from remote...");
      const data = await postJson("/dfm/rpc-bridge/apply", payload);
      const applied = await applyDfmMethodPayload(data?.payload);
      if (!applied?.ok) {
        statusDialog.setMessage("Updated, but could not reload this tab.", "error");
        postStatus("DFM sync: local JSON updated, but tab apply failed.", "warn");
        return;
      }
      if (applied.datasetInputsChanged) {
        statusDialog.setWaiting("Saving recalculated local DFM JSON...");
        const saved = await saveRatioSelectionPattern(false);
        if (!saved?.ok) {
          markDfmDirty();
          statusDialog.setMessage("Local updated in app, but final JSON save failed. Save the DFM before closing.", "warn");
          postStatus("DFM sync: local app data updated, but final JSON save failed.", "warn");
          return;
        }
      }
      const resultMessage = formatApplyResultMessage(data);
      statusDialog.setMessage(resultMessage.text, resultMessage.tone);
      postStatus(
        resultMessage.tone === "warn"
          ? "DFM sync: local DFM JSON updated from remote with missing RPC components."
          : "DFM sync: local DFM JSON updated from remote.",
        resultMessage.tone === "warn" ? "warn" : "",
      );
      return;
    }
    if (action === "keep-local") {
      statusDialog.setWaiting("Keeping local DFM JSON and removing remote RPC JSON...");
      const data = await postJson("/dfm/rpc-bridge/keep-local", payload);
      const message = data?.ok ? "No changes made on local." : (data?.message || "Keep local failed.");
      statusDialog.setMessage(message, data?.ok ? "ok" : "error");
      postStatus(`DFM sync: ${message}`, data?.ok ? "" : "warn");
      return;
    }
    if (action === "update-remote") {
      statusDialog.setWaiting("Sending SyncDFM request and waiting for remote result...");
      const data = await postJson("/dfm/rpc-bridge/update-remote", actionPayload);
      const message = data?.ok ? "Remote database updated" : (data?.message || "Remote update failed.");
      statusDialog.setMessage(message, data?.ok ? "ok" : "error");
      postStatus(`DFM sync: ${message}`, data?.ok ? "" : "warn");
      return;
    }
  } catch (err) {
    statusDialog.setMessage(String(err?.message || err), "error");
    postStatus(`DFM sync failed: ${String(err?.message || err)}`, "warn");
  } finally {
    statusDialog.setBusy(false);
  }
}

export async function startDfmRpcBridgeSync(buttonEl = null) {
  if (syncInFlight) return;
  syncInFlight = true;
  if (buttonEl) buttonEl.disabled = true;
  let cleanupPayload = null;
  let dialogClosed = false;
  let cleanupAfterClose = null;
  const cleanupAfterUserClose = () => {
    if (!cleanupPayload || cleanupAfterClose) return;
    cleanupAfterClose = cleanupRemoteTmp(cleanupPayload).finally(() => {
      cleanupAfterClose = null;
    });
    window.setTimeout(() => {
      if (cleanupPayload) cleanupRemoteTmp(cleanupPayload);
    }, 10000);
  };
  const dialog = createDfmRpcBridgeDialog({
    onClose: (reason) => {
      dialogClosed = true;
      if (reason === "primary-action") return;
      cleanupAfterUserClose();
    },
  });
  dialog.setWaiting("Preparing DFM RPC bridge sync...");
  try {
    const saved = await ensureSavedBeforeSync(dialog);
    if (!saved) return;

    const payload = buildRequestPayload();
    const missing = validatePayload(payload);
    if (missing.length) {
      dialog.setMessage(`Complete these Details fields before syncing: ${missing.join(", ")}.`, "error");
      return;
    }

    cleanupPayload = payload;
    dialog.setWaiting("Sending DFM request and waiting for remote JSON...");
    const data = await postJson("/dfm/rpc-bridge/sync", payload);
    if (dialogClosed) {
      await cleanupRemoteTmp(payload);
      return;
    }
    if (!data?.ok && data?.status === "timeout") {
      dialog.setMessage("Timed out waiting for remote DFM JSON. Use Refresh if the remote file appears later.", "warn");
      postStatus("DFM sync timed out waiting for remote JSON.", "warn");
      return;
    }
    dialog.setComparison(data, {
      labelFallbacks: buildCurrentPatternLabelFallbacks(),
      onRefresh: () => refreshComparison(dialog, payload),
      onPrimary: (action) => runPrimaryAction(dialog, payload, action),
    });
  } catch (err) {
    dialog.setMessage(String(err?.message || err), "error");
    postStatus(`DFM sync failed: ${String(err?.message || err)}`, "warn");
  } finally {
    syncInFlight = false;
    if (buttonEl) buttonEl.disabled = false;
  }
}
