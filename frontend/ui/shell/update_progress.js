import { shell } from "./shell_context.js?v=20260510a";
import {
  closeAutomationProgress,
  openAutomationProgress,
  updateAutomationProgress,
} from "./ui_automation.js?v=20260812b";

const PROGRESS_ID = "arcrho-update-download";
let wired = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function handleDownloadProgress(payload = {}) {
  const { phase, version, receivedBytes = 0, totalBytes = 0 } = payload;
  if (phase === "start") {
    openAutomationProgress({
      progressId: PROGRESS_ID,
      title: "ArcRho Update",
      label: `Downloading ArcRho ${version || ""}...`,
      total: totalBytes,
      completed: 0,
    });
  } else if (phase === "progress") {
    updateAutomationProgress({
      progressId: PROGRESS_ID,
      completed: receivedBytes,
      total: totalBytes,
      countText: totalBytes > 0 ? "" : formatBytes(receivedBytes),
    });
  } else if (phase === "verifying") {
    updateAutomationProgress({
      progressId: PROGRESS_ID,
      label: "Verifying update...",
      total: 0,
      countText: "",
    });
  } else if (phase === "done" || phase === "error") {
    closeAutomationProgress({ progressId: PROGRESS_ID });
  }
}

export function initUpdateProgressBridge() {
  if (wired) return;
  const hostApi = shell.getHostApi?.();
  if (typeof hostApi?.onUpdateDownloadProgress !== "function") return;
  wired = true;
  hostApi.onUpdateDownloadProgress(handleDownloadProgress);
}
