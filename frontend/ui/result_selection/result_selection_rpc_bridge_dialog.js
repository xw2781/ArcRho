const STYLE_ID = "rs-rpc-bridge-dialog-style";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .rsRpcOverlay {
      position: fixed;
      inset: 0;
      z-index: 12000;
      background: rgba(15, 23, 42, 0.18);
      box-sizing: border-box;
    }
    .rsRpcWindow {
      position: fixed;
      width: min(980px, calc(100vw - 32px));
      min-width: min(620px, calc(100vw - 32px));
      height: min(720px, calc(100vh - 96px));
      min-height: 360px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 96px);
      display: flex;
      flex-direction: column;
      border: 1px solid #c8d0dc;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 22px 54px rgba(15, 23, 42, 0.24);
      font-family: Arial, "Segoe UI", Tahoma, sans-serif;
      color: #172033;
      overflow: hidden;
      resize: both;
    }
    .rsRpcMessageWindow {
      width: min(520px, calc(100vw - 32px));
      min-width: min(360px, calc(100vw - 32px));
      height: auto;
      min-height: 0;
      resize: none;
    }
    .rsRpcHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 32px;
      padding: 3px 12px;
      border-bottom: 1px solid #e2e7ef;
      background: #f7f9fc;
      cursor: move;
      user-select: none;
    }
    .rsRpcTitle {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
    }
    .rsRpcClose {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: #5b6678;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
    }
    .rsRpcClose:hover { background: #edf1f7; color: #1f2937; }
    .rsRpcBody {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      padding: 16px;
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .rsRpcMessageWindow .rsRpcBody {
      min-height: 0;
      padding: 18px 20px;
      overflow: visible;
    }
    .rsRpcStatus {
      margin: 0 0 14px;
      padding: 12px 14px;
      border-radius: 7px;
      border: 1px solid #c9d9f7;
      background: #eef5ff;
      color: #244a86;
      font-size: 13px;
      line-height: 1.4;
      white-space: pre-wrap;
    }
    .rsRpcStatus.warn {
      border-color: #ead19f;
      background: #fff5df;
      color: #7a5515;
    }
    .rsRpcStatus.error {
      border-color: #efc1c1;
      background: #fff0f0;
      color: #9d2d2d;
    }
    .rsRpcStatus.ok {
      border-color: #b9dac9;
      background: #ecf8f1;
      color: #206246;
    }
    .rsRpcGrid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      align-items: stretch;
    }
    .rsRpcVersionCard {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border: 1px solid #d9e0ea;
      border-radius: 7px;
      background: #fbfcff;
      padding: 12px;
    }
    .rsRpcVersionCard.selectable {
      cursor: pointer;
      transition: border-color 120ms ease-out, box-shadow 120ms ease-out, background 120ms ease-out;
    }
    .rsRpcVersionCard.selectable:hover {
      border-color: #9fb7d9;
      background: #f7fbff;
    }
    .rsRpcVersionCard.selected {
      border-color: #2457a6;
      box-shadow: inset 0 0 0 1px #2457a6;
      background: #f2f7ff;
    }
    .rsRpcVersionCard.newest {
      border-color: #78b997;
      box-shadow: inset 0 0 0 1px #a8d9bd;
      background: #f3fbf6;
    }
    .rsRpcVersionCard.newest.selected {
      border-color: #2457a6;
      box-shadow: inset 0 0 0 1px #2457a6, 0 0 0 2px rgba(99, 195, 132, 0.28);
    }
    .rsRpcVersionTitle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 9px;
      font-size: 13px;
      font-weight: 700;
    }
    .rsRpcSourceLabel {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 9px;
      border: 1px solid #2457a6;
      border-radius: 6px;
      background: #e8f0ff;
      color: #173d78;
      font-weight: 800;
      line-height: 1.2;
      white-space: nowrap;
    }
    .rsRpcNewSeal {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      border: 1px solid #4d9a70;
      background: #e7f7ee;
      color: #17613a;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .rsRpcMeta {
      display: grid;
      gap: 7px;
      font-size: 12px;
      color: #4b5563;
    }
    .rsRpcSnapshot {
      display: flex;
      flex-direction: column;
      gap: 9px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #e2e7ef;
    }
    .rsRpcSnapshotTitle {
      margin: 0;
      font-size: 12px;
      font-weight: 800;
      color: #1f2937;
    }
    .rsRpcStats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .rsRpcStat {
      border: 1px solid #dde4ee;
      border-radius: 6px;
      background: #fff;
      padding: 7px;
      min-width: 0;
    }
    .rsRpcStatLabel {
      color: #64748b;
      font-size: 11px;
    }
    .rsRpcStatValue {
      margin-top: 2px;
      color: #0f172a;
      font-size: 13px;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rsRpcSourceList {
      display: grid;
      gap: 5px;
      max-height: 164px;
      overflow: auto;
      padding-right: 4px;
    }
    .rsRpcSourceRow {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 27px;
      padding: 4px 7px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #fff;
      font-size: 12px;
    }
    .rsRpcSourceName {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rsRpcSourceBadge {
      color: #0f766e;
      font-weight: 800;
      white-space: nowrap;
    }
    .rsRpcPreviewValues {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .rsRpcValueChip {
      max-width: 92px;
      padding: 2px 6px;
      border: 1px solid #dbe3ef;
      border-radius: 999px;
      background: #fff;
      color: #334155;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
    }
    .rsRpcNotesPreview {
      max-height: 92px;
      overflow: auto;
      margin: 0;
      padding: 8px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: #fff;
      color: #334155;
      font: 12px/1.4 Arial, "Segoe UI", Tahoma, sans-serif;
      white-space: pre-wrap;
    }
    .rsRpcActions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid #e2e7ef;
      background: #f8fafc;
    }
    .rsRpcBtn {
      min-width: 72px;
      height: 28px;
      border: 1px solid #b9c4d3;
      border-radius: 6px;
      background: #fff;
      color: #1f2937;
      font: 600 12px Arial, "Segoe UI", Tahoma, sans-serif;
      cursor: pointer;
    }
    .rsRpcBtn:hover:not(:disabled) { background: #f1f5f9; }
    .rsRpcBtn.primary {
      border-color: #2457a6;
      background: #2457a6;
      color: #fff;
    }
    .rsRpcBtn.primary:hover:not(:disabled) { background: #1f4d93; }
    .rsRpcBtn:disabled {
      opacity: 0.58;
      cursor: wait;
    }
    .rsRpcWindow .small {
      color: #5b6678;
      font-size: 12px;
      line-height: 1.35;
    }
    @media (max-width: 720px) {
      .rsRpcWindow {
        min-width: min(360px, calc(100vw - 16px));
      }
      .rsRpcGrid,
      .rsRpcStats { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestampText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = parseTimestampDate(raw);
  if (parsed) return formatTimestampLabel(parsed);
  const match = raw.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  return match ? match[1] : "";
}

function parseTimestampDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (zone) {
    const normalizedZone = zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction || "0").slice(0, 3).padEnd(3, "0")}${normalizedZone}`);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number((fraction || "0").slice(0, 3).padEnd(3, "0"))
  );
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatTimestampLabel(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatTime(meta) {
  if (!meta || !meta.exists) return "Missing";
  const rawTimestamp = String(meta.last_modified || "").trim();
  if (rawTimestamp) return formatTimestampText(rawTimestamp) || rawTimestamp;
  const jsonTimestamp = Number(meta.last_modified_timestamp);
  if (Number.isFinite(jsonTimestamp) && jsonTimestamp > 0) return formatTimestampLabel(new Date(jsonTimestamp * 1000));
  return "Missing last modified";
}

function timestampsAreSame(local, remote) {
  if (!local?.exists || !remote?.exists) return false;
  const localModified = Number(local.last_modified_timestamp || 0);
  const remoteModified = Number(remote.last_modified_timestamp || 0);
  if (Number.isFinite(localModified) && localModified > 0 && Number.isFinite(remoteModified) && remoteModified > 0) {
    if (Math.abs(localModified - remoteModified) <= 1e-6) return true;
  }
  const localLabel = formatTime(local);
  const remoteLabel = formatTime(remote);
  return !!localLabel && localLabel !== "Missing" && localLabel === remoteLabel;
}

function resolveComparison(data) {
  const comparison = data?.comparison || "";
  if (comparison === "same_time") return comparison;
  return timestampsAreSame(data?.local || {}, data?.remote || {}) ? "same_time" : comparison;
}

function comparisonMessage(comparison) {
  switch (comparison) {
    case "remote_latest":
    case "local_latest":
      return { tone: "", text: "" };
    case "same_time":
      return { tone: "ok", text: "Local and ResQ Result Selection JSON are already in sync." };
    case "remote_missing":
      return { tone: "warn", text: "ResQ Result Selection JSON is missing. No local update action is available." };
    case "local_missing":
      return { tone: "error", text: "Local Result Selection JSON is missing. Save before syncing." };
    case "both_missing":
      return { tone: "error", text: "Local and ResQ Result Selection JSON files are missing." };
    default:
      return { tone: "", text: "Result Selection sync status is available." };
  }
}

function getOrderedVersions(data) {
  const local = data?.local || {};
  const remote = data?.remote || {};
  if (!local.exists || !remote.exists) return [];
  if (timestampsAreSame(local, remote)) return [];
  const labels = data?.labels && typeof data.labels === "object" ? data.labels : {};
  const localModified = Number(local.last_modified_timestamp || 0);
  const remoteModified = Number(remote.last_modified_timestamp || 0);
  const localSnapshot = data?.snapshots?.local || {};
  const remoteSnapshot = data?.snapshots?.remote || {};
  return [
    {
      key: "local",
      source: labels.local || "ArcRho - Local",
      meta: local,
      snapshot: localSnapshot,
      action: resolveComparison(data) === "local_latest" ? "update-remote" : "keep-local",
      age: localModified < remoteModified ? "old" : "new",
    },
    {
      key: "remote",
      source: labels.remote || "ResQ - Remote",
      meta: remote,
      snapshot: remoteSnapshot,
      action: remoteSnapshot?.error ? "" : "update-local",
      age: remoteModified < localModified ? "old" : "new",
    },
  ];
}

function versionPrimaryLabel(version) {
  if (!version) return "Apply";
  if (!version.action) return "Unavailable";
  if (version.action === "update-local") return "Use ResQ Version";
  if (version.action === "update-remote") return "Update ResQ";
  if (version.action === "keep-local") return "Keep Local";
  return "Use Selected Version";
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Math.round(n * 1000) / 1000);
}

function renderStats(snapshot) {
  return `
    <div class="rsRpcStats">
      <div class="rsRpcStat">
        <div class="rsRpcStatLabel">Sources</div>
        <div class="rsRpcStatValue">${escapeHtml(snapshot?.source_count ?? 0)}</div>
      </div>
      <div class="rsRpcStat">
        <div class="rsRpcStatLabel">Selected Weights</div>
        <div class="rsRpcStatValue">${escapeHtml(snapshot?.selected_count ?? 0)}</div>
      </div>
      <div class="rsRpcStat">
        <div class="rsRpcStatLabel">Origin Length</div>
        <div class="rsRpcStatValue">${escapeHtml(snapshot?.origin_length ?? "")}</div>
      </div>
    </div>
  `;
}

function renderSourceRows(snapshot) {
  const sources = Array.isArray(snapshot?.loaded_datasets) ? snapshot.loaded_datasets : [];
  if (!sources.length) return `<div class="small">No Method tab sources in this JSON.</div>`;
  return `
    <div class="rsRpcSourceList">
      ${sources.slice(0, 24).map((source) => `
        <div class="rsRpcSourceRow" title="${escapeHtml(source.name || "")}">
          <span class="rsRpcSourceName">${escapeHtml(source.name || "Unnamed source")}</span>
          <span class="rsRpcSourceBadge">${escapeHtml(source.selected_count || 0)} selected</span>
        </div>
      `).join("")}
      ${sources.length > 24 ? `<div class="small">${sources.length - 24} more sources hidden in preview.</div>` : ""}
    </div>
  `;
}

function renderUltimatePreview(snapshot) {
  const values = Array.isArray(snapshot?.selected_ultimate_preview) ? snapshot.selected_ultimate_preview : [];
  if (!values.length) return `<div class="small">No selected ultimate preview values.</div>`;
  return `<div class="rsRpcPreviewValues">${values.map((value) => `<span class="rsRpcValueChip">${escapeHtml(compactNumber(value))}</span>`).join("")}</div>`;
}

function renderSnapshot(snapshot) {
  if (snapshot?.error) return `<div class="rsRpcStatus error">${escapeHtml(snapshot.error)}</div>`;
  if (!snapshot?.available) return `<div class="small">No JSON snapshot is available.</div>`;
  return `
    <div class="rsRpcSnapshot">
      <h3 class="rsRpcSnapshotTitle">Method Table</h3>
      ${renderStats(snapshot)}
      ${renderSourceRows(snapshot)}
      <h3 class="rsRpcSnapshotTitle">Selected Ultimate Preview</h3>
      ${renderUltimatePreview(snapshot)}
      <h3 class="rsRpcSnapshotTitle">Notes</h3>
      <pre class="rsRpcNotesPreview">${escapeHtml(snapshot.notes_preview || "No notes.")}</pre>
    </div>
  `;
}

function renderVersionCard(version, selectedKey) {
  const selected = version.key === selectedKey;
  const newest = version.age === "new";
  return `
    <div class="rsRpcVersionCard selectable ${selected ? "selected" : ""} ${newest ? "newest" : ""}"
      data-version-source="${escapeHtml(version.key)}"
      role="radio"
      tabindex="0"
      aria-checked="${selected ? "true" : "false"}">
      <div class="rsRpcVersionTitle">
        <span class="rsRpcSourceLabel">${escapeHtml(version.source)}</span>
        ${newest ? `<span class="rsRpcNewSeal">Newest</span>` : ""}
      </div>
      <div class="rsRpcMeta">
        <div><strong>Last Modified:</strong> ${escapeHtml(formatTime(version.meta))}</div>
        <div><strong>Name:</strong> ${escapeHtml(version.snapshot?.name || "")}</div>
        <div><strong>Output Type:</strong> ${escapeHtml(version.snapshot?.output_type || "")}</div>
      </div>
      ${renderSnapshot(version.snapshot)}
    </div>
  `;
}

function placeDialogWindow(dialogWindow) {
  const rectWidth = Math.min(980, Math.max(620, window.innerWidth - 32));
  const rectHeight = Math.min(720, Math.max(360, window.innerHeight - 96));
  dialogWindow.style.left = `${Math.max(8, Math.round((window.innerWidth - rectWidth) / 2))}px`;
  dialogWindow.style.top = `${Math.max(48, Math.round((window.innerHeight - rectHeight) / 2))}px`;
}

function enableDialogDrag(dialogWindow, header) {
  if (!dialogWindow || !header) return;
  header.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    event.preventDefault();
    const rect = dialogWindow.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const move = (moveEvent) => {
      const pad = 8;
      const nextLeft = Math.max(pad, Math.min(moveEvent.clientX - offsetX, window.innerWidth - rect.width - pad));
      const nextTop = Math.max(pad, Math.min(moveEvent.clientY - offsetY, window.innerHeight - rect.height - pad));
      dialogWindow.style.left = `${Math.round(nextLeft)}px`;
      dialogWindow.style.top = `${Math.round(nextTop)}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

export function createResultSelectionRpcBridgeDialog(options = {}) {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.className = "rsRpcOverlay";
  overlay.innerHTML = `
    <div class="rsRpcWindow" role="dialog" aria-modal="true" aria-labelledby="rsRpcTitle">
      <div class="rsRpcHeader">
        <h2 class="rsRpcTitle" id="rsRpcTitle">Review Result Selection Versions</h2>
        <button class="rsRpcClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="rsRpcBody"></div>
      <div class="rsRpcActions">
        <button class="rsRpcBtn" type="button" data-action="refresh">Refresh</button>
        <button class="rsRpcBtn primary" type="button" data-action="primary" style="display:none;"></button>
        <button class="rsRpcBtn" type="button" data-action="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const dialogWindow = overlay.querySelector(".rsRpcWindow");
  const header = overlay.querySelector(".rsRpcHeader");
  const body = overlay.querySelector(".rsRpcBody");
  const closeBtns = overlay.querySelectorAll(".rsRpcClose, [data-action='close']");
  const refreshBtn = overlay.querySelector("[data-action='refresh']");
  const primaryBtn = overlay.querySelector("[data-action='primary']");
  let onRefresh = null;
  let onPrimary = null;
  let currentVersions = [];
  let selectedVersionKey = "";

  placeDialogWindow(dialogWindow);
  enableDialogDrag(dialogWindow, header);

  function close(reason = "user") {
    overlay.remove();
    if (typeof options?.onClose === "function") options.onClose(reason);
  }

  closeBtns.forEach((btn) => btn.addEventListener("click", () => close("user")));
  refreshBtn?.addEventListener("click", async () => {
    if (typeof onRefresh === "function") await onRefresh();
  });
  primaryBtn?.addEventListener("click", async () => {
    if (typeof onPrimary === "function") await onPrimary(primaryBtn.dataset.primaryAction || "", selectedVersionKey);
  });

  function setBusy(busy) {
    overlay.querySelectorAll("button").forEach((btn) => {
      if (btn.classList.contains("rsRpcClose")) return;
      btn.disabled = !!busy || (btn === primaryBtn && !primaryBtn.dataset.primaryAction);
    });
  }

  function setWaiting(text) {
    primaryBtn.style.display = "none";
    body.innerHTML = `<div class="rsRpcStatus">${escapeHtml(text || "Waiting...")}</div>`;
  }

  function setMessage(text, tone = "") {
    primaryBtn.style.display = "none";
    const toneClass = tone ? ` ${tone}` : "";
    body.innerHTML = `<div class="rsRpcStatus${toneClass}">${escapeHtml(text || "")}</div>`;
  }

  function setComparison(data, handlers = {}) {
    onRefresh = handlers.onRefresh || null;
    onPrimary = handlers.onPrimary || null;
    const comparison = resolveComparison(data);
    const msg = comparisonMessage(comparison);
    currentVersions = getOrderedVersions(data);
    selectedVersionKey = currentVersions.find((version) => version.age === "new")?.key || "";
    if (currentVersions.length) {
      body.innerHTML = `
        ${msg.text ? `<div class="rsRpcStatus ${msg.tone}">${escapeHtml(msg.text)}</div>` : ""}
        <div class="rsRpcGrid" role="radiogroup" aria-label="Result Selection version selection">
          ${currentVersions.map((version) => renderVersionCard(version, selectedVersionKey)).join("")}
        </div>
      `;
      body.querySelectorAll("[data-version-source]").forEach((card) => {
        const selectCard = () => {
          selectedVersionKey = card.dataset.versionSource || "";
          const selected = currentVersions.find((version) => version.key === selectedVersionKey);
          primaryBtn.textContent = versionPrimaryLabel(selected);
          primaryBtn.dataset.primaryAction = selected?.action || "";
          primaryBtn.disabled = !selected?.action;
          body.querySelectorAll("[data-version-source]").forEach((item) => {
            const checked = item.dataset.versionSource === selectedVersionKey;
            item.classList.toggle("selected", checked);
            item.setAttribute("aria-checked", checked ? "true" : "false");
          });
        };
        card.addEventListener("click", selectCard);
        card.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selectCard();
        });
      });
      const selected = currentVersions.find((version) => version.key === selectedVersionKey);
      primaryBtn.textContent = versionPrimaryLabel(selected);
      primaryBtn.dataset.primaryAction = selected?.action || "";
      primaryBtn.disabled = !selected?.action;
      primaryBtn.style.display = "";
    } else {
      const local = data?.local || {};
      const remote = data?.remote || {};
      body.innerHTML = `
        <div class="rsRpcStatus ${msg.tone}">${escapeHtml(msg.text)}</div>
        <div class="rsRpcGrid">
          <div class="rsRpcVersionCard">
            <div class="rsRpcVersionTitle"><span class="rsRpcSourceLabel">ArcRho - Local</span></div>
            <div class="rsRpcMeta">
              <div><strong>Last Modified:</strong> ${escapeHtml(formatTime(local))}</div>
            </div>
          </div>
          <div class="rsRpcVersionCard">
            <div class="rsRpcVersionTitle"><span class="rsRpcSourceLabel">ResQ - Remote</span></div>
            <div class="rsRpcMeta">
              <div><strong>Last Modified:</strong> ${escapeHtml(formatTime(remote))}</div>
            </div>
          </div>
        </div>
      `;
      primaryBtn.style.display = "none";
      primaryBtn.dataset.primaryAction = "";
    }
  }

  return { close, setBusy, setComparison, setMessage, setWaiting };
}

export function createResultSelectionRpcBridgeMessageBox(initialText = "", tone = "", options = {}) {
  ensureStyles();
  const overlay = document.createElement("div");
  overlay.className = "rsRpcOverlay";
  const title = String(options?.title || "Result Selection Sync");
  overlay.innerHTML = `
    <div class="rsRpcWindow rsRpcMessageWindow" role="dialog" aria-modal="true" aria-labelledby="rsRpcMessageTitle">
      <div class="rsRpcHeader">
        <h2 class="rsRpcTitle" id="rsRpcMessageTitle">${escapeHtml(title)}</h2>
        <button class="rsRpcClose" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="rsRpcBody"></div>
      <div class="rsRpcActions">
        <button class="rsRpcBtn" type="button" data-action="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const dialogWindow = overlay.querySelector(".rsRpcWindow");
  const header = overlay.querySelector(".rsRpcHeader");
  const body = overlay.querySelector(".rsRpcBody");
  const closeBtns = overlay.querySelectorAll(".rsRpcClose, [data-action='close']");
  placeDialogWindow(dialogWindow);
  enableDialogDrag(dialogWindow, header);

  function close() {
    overlay.remove();
  }

  function setBusy(busy) {
    overlay.querySelectorAll("button").forEach((btn) => {
      if (btn.classList.contains("rsRpcClose")) return;
      btn.disabled = !!busy;
    });
  }

  function setMessage(text, nextTone = "") {
    const toneClass = nextTone ? ` ${nextTone}` : "";
    body.innerHTML = `<div class="rsRpcStatus${toneClass}">${escapeHtml(text || "")}</div>`;
  }

  function setWaiting(text) {
    setMessage(text || "Waiting...");
  }

  closeBtns.forEach((btn) => btn.addEventListener("click", close));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  setMessage(initialText || "Ready.", tone);
  return { close, setBusy, setMessage, setWaiting };
}

export function confirmResultSelectionRpcBridgeAction(message, options = {}) {
  ensureStyles();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "rsRpcOverlay";
    const title = String(options?.title || "Confirm Result Selection Sync");
    overlay.innerHTML = `
      <div class="rsRpcWindow rsRpcMessageWindow" role="dialog" aria-modal="true" aria-labelledby="rsRpcConfirmTitle">
        <div class="rsRpcHeader">
          <h2 class="rsRpcTitle" id="rsRpcConfirmTitle">${escapeHtml(title)}</h2>
          <button class="rsRpcClose" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="rsRpcBody">
          <p class="rsRpcConfirmText">${escapeHtml(message || "")}</p>
        </div>
        <div class="rsRpcActions">
          <button class="rsRpcBtn" type="button" data-action="cancel">Cancel</button>
          <button class="rsRpcBtn primary" type="button" data-action="confirm">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const dialogWindow = overlay.querySelector(".rsRpcWindow");
    const header = overlay.querySelector(".rsRpcHeader");
    placeDialogWindow(dialogWindow);
    enableDialogDrag(dialogWindow, header);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };

    overlay.querySelector(".rsRpcClose")?.addEventListener("click", () => finish(false));
    overlay.querySelector("[data-action='cancel']")?.addEventListener("click", () => finish(false));
    overlay.querySelector("[data-action='confirm']")?.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
  });
}
