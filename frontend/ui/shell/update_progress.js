import { shell } from "./shell_context.js?v=20260510a";
import {
  closeAutomationProgress,
  openAutomationProgress,
  updateAutomationProgress,
} from "./ui_automation.js?v=20260828a";

const PROGRESS_ID = "arcrho-update-download";
let wired = false;

const BYTES_PER_MB = 1024 * 1024;

function megabytes(bytes) {
  const value = Number(bytes);
  return Number.isFinite(value) && value > 0 ? value / BYTES_PER_MB : 0;
}

// Installers run to hundreds of megabytes, so both sides stay in MB rather than
// scaling per value: a unit that changes mid-download makes the readout jump.
function formatDownloadedSize(receivedBytes, totalBytes) {
  const received = `${megabytes(receivedBytes).toFixed(1)} MB`;
  return totalBytes > 0 ? `${received} / ${megabytes(totalBytes).toFixed(1)} MB` : received;
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
      countText: formatDownloadedSize(0, totalBytes),
    });
  } else if (phase === "progress") {
    updateAutomationProgress({
      progressId: PROGRESS_ID,
      completed: receivedBytes,
      total: totalBytes,
      countText: formatDownloadedSize(receivedBytes, totalBytes),
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
