const STYLE_ID = "arcrho-task-designer-style";
const DEFAULT_WINDOW_ID = "task-designer-main";
const IS_EMBEDDED_TAB = window.parent && window.parent !== window;
const TASK_DESIGNER_COMMAND_MESSAGE = "arcrho:task-designer-automation-command";
const TASK_DESIGNER_RESULT_MESSAGE = "arcrho:task-designer-automation-result";

const STATUS_LABELS = {
  pending: "Pending",
  running: "Running",
  pass: "Pass",
  fail: "Fail",
  needs_review: "Needs Review",
  skipped: "Skipped",
  error: "Error",
};
const FINAL_STATUSES = new Set(["pass", "fail", "needs_review", "skipped", "error"]);

let taskDesignerWindow = null;
let taskStatusEl = null;
let taskTbody = null;
let emptyEl = null;
let taskDetailWindow = null;
let taskDetailBody = null;
let activeDetailTaskId = "";
let activeSessionId = "";
let durationTimer = null;
let taskRows = [];
let taskRowMap = new Map();

function toText(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeStatus(value) {
  const raw = toText(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "needsreview" || raw === "review") return "needs_review";
  if (raw === "passed") return "pass";
  if (raw === "failed") return "fail";
  if (raw === "complete" || raw === "completed" || raw === "ok") return "pass";
  if (STATUS_LABELS[raw]) return raw;
  return raw || "pending";
}

function isFinalStatus(status) {
  return FINAL_STATUSES.has(normalizeStatus(status));
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return value ? `${Math.round(value)} ms` : "";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function nowMs() {
  return performance?.now?.() || Date.now();
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    html, body {
      height: 100%;
    }
    body {
      margin: 0;
      overflow: hidden;
      font-family: Arial, "Segoe UI", Tahoma, sans-serif;
      background: #f4f7fa;
    }
    .taskDesignerWindow {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: #f4f7fa;
      color: #1f2937;
      overflow: hidden;
    }
    .taskDesignerBody {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      box-sizing: border-box;
    }
    .taskDesignerTableWrap {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      overflow: auto;
      border: 1px solid #d8dde6;
      border-radius: 5px;
      background: #fff;
      box-sizing: border-box;
    }
    .taskDesignerTable {
      width: 100%;
      min-width: 780px;
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
      font-size: 12px;
    }
    .taskDesignerTable th {
      position: sticky;
      top: 0;
      z-index: 1;
      height: 31px;
      padding: 0 9px;
      border-bottom: 1px solid #d8dde6;
      background: #f1f5f9;
      color: #334155;
      text-align: left;
      font-weight: 700;
    }
    .taskDesignerTable td {
      height: 42px;
      padding: 5px 9px;
      border-bottom: 1px solid #eef2f7;
      color: #253244;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    .taskDesignerTable tr:hover td {
      background: #f8fbff;
    }
    .taskDesignerTable tbody tr {
      cursor: pointer;
    }
    .taskDesignerTable tbody tr:focus-visible td {
      outline: 2px solid rgba(43, 109, 246, 0.35);
      outline-offset: -2px;
      background: #f8fbff;
    }
    .taskDesignerTable tbody tr.is-detail-open td {
      background: #eef5ff;
    }
    .taskDesignerTaskName {
      width: 20%;
      font-weight: 650;
    }
    .taskDesignerDescription {
      width: 30%;
      color: #475569;
    }
    .taskDesignerDuration {
      width: 11%;
      white-space: nowrap;
      color: #64748b;
    }
    .taskDesignerDurationRunning {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #2b6df6;
      font-weight: 650;
      line-height: 1.35;
    }
    .taskDesignerDurationSpinner {
      position: relative;
      display: block;
      width: 20px;
      height: 20px;
      box-sizing: border-box;
      border-radius: 50%;
      flex: 0 0 auto;
      filter: drop-shadow(0 1px 2px rgba(15, 23, 42, 0.10));
    }
    .taskDesignerDurationSpinner::before {
      content: "";
      position: absolute;
      inset: 0;
      border: 2px solid rgba(120, 178, 224, 0.25);
      border-radius: 50%;
      box-shadow:
        inset 0 0 8px rgba(116, 182, 235, 0.14),
        0 0 0 1px rgba(134, 188, 229, 0.10);
    }
    .taskDesignerDurationSpinner::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background:
        conic-gradient(
          from 220deg,
          rgba(86, 176, 236, 0) 0deg,
          rgba(86, 176, 236, 0) 238deg,
          rgba(134, 224, 255, 0.92) 308deg,
          rgba(74, 144, 217, 0.98) 338deg,
          rgba(74, 144, 217, 0) 360deg
        );
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
      filter:
        drop-shadow(0 0 5px rgba(95, 196, 255, 0.42))
        drop-shadow(0 0 10px rgba(84, 161, 228, 0.24));
      animation: taskDesignerSpin 1.05s linear infinite;
      pointer-events: none;
    }
    @keyframes taskDesignerSpin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .taskDesignerDurationSpinner::after {
        animation: none;
      }
    }
    .taskDesignerResult {
      width: 13%;
      white-space: nowrap;
    }
    .taskDesignerOutput {
      width: 26%;
      color: #64748b;
    }
    .taskDesignerLineClamp {
      display: -webkit-box;
      max-height: calc(1.35em * 2);
      overflow: hidden;
      line-height: 1.35;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .taskDesignerResultText {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 18px;
      font-weight: 700;
    }
    .taskDesignerResultLabel {
      min-width: 0;
    }
    .taskDesignerRunningDots {
      display: none;
      align-items: flex-end;
      gap: 2px;
      width: 17px;
      height: 12px;
      color: #2b6df6;
    }
    .taskDesignerRunningDots span {
      width: 3px;
      height: 3px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.35;
      animation: taskDesignerResultDot 960ms ease-in-out infinite;
    }
    .taskDesignerRunningDots span:nth-child(2) {
      animation-delay: 160ms;
    }
    .taskDesignerRunningDots span:nth-child(3) {
      animation-delay: 320ms;
    }
    .taskDesignerDot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #94a3b8;
      flex: 0 0 auto;
    }
    .taskDesignerStatus-pending .taskDesignerDot {
      background: #94a3b8;
    }
    .taskDesignerStatus-running .taskDesignerDot {
      background: #2b6df6;
      box-shadow: 0 0 0 4px rgba(43, 109, 246, 0.12);
      animation: taskDesignerResultPulse 1180ms ease-in-out infinite;
    }
    .taskDesignerStatus-running .taskDesignerResultText {
      color: #2b6df6;
    }
    .taskDesignerStatus-running .taskDesignerRunningDots {
      display: inline-flex;
    }
    .taskDesignerStatus-pass .taskDesignerDot {
      background: #15803d;
    }
    .taskDesignerStatus-fail .taskDesignerDot,
    .taskDesignerStatus-error .taskDesignerDot {
      background: #be123c;
    }
    .taskDesignerStatus-needs_review .taskDesignerDot {
      background: #b45309;
    }
    .taskDesignerStatus-skipped .taskDesignerDot {
      background: #64748b;
    }
    .taskDesignerStatus-fail .taskDesignerResultText,
    .taskDesignerStatus-error .taskDesignerResultText {
      color: #be123c;
    }
    .taskDesignerStatus-pass .taskDesignerResultText {
      color: #15803d;
    }
    .taskDesignerStatus-needs_review .taskDesignerResultText {
      color: #b45309;
    }
    @keyframes taskDesignerResultPulse {
      0%,
      100% {
        transform: scale(1);
        box-shadow: 0 0 0 3px rgba(43, 109, 246, 0.10);
      }
      50% {
        transform: scale(1.28);
        box-shadow: 0 0 0 6px rgba(43, 109, 246, 0.16);
      }
    }
    @keyframes taskDesignerResultDot {
      0%,
      80%,
      100% {
        transform: translateY(0);
        opacity: 0.35;
      }
      40% {
        transform: translateY(-4px);
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .taskDesignerStatus-running .taskDesignerDot,
      .taskDesignerRunningDots span {
        animation: none;
      }
    }
    .taskDesignerMessage {
      white-space: pre-wrap;
    }
    .taskDesignerEmpty {
      position: absolute;
      inset: 42px 12px auto;
      padding: 18px;
      color: #64748b;
      text-align: center;
      pointer-events: none;
    }
    .taskDesignerFooter {
      flex: 0 0 auto;
      min-height: 18px;
      color: #64748b;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .taskDesignerFooter[data-tone="error"] {
      color: #b91c1c;
    }
    .taskDesignerDetailWindow {
      position: fixed;
      right: 24px;
      bottom: 28px;
      z-index: 20;
      display: flex;
      flex-direction: column;
      width: min(680px, calc(100vw - 48px));
      height: min(520px, calc(100vh - 58px));
      min-width: 360px;
      min-height: 240px;
      overflow: hidden;
      resize: both;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
      color: #1f2937;
    }
    .taskDesignerDetailWindow[hidden] {
      display: none;
    }
    .taskDesignerDetailTitlebar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      min-height: 32px;
      padding: 0 8px 0 11px;
      border-bottom: 1px solid #d8dde6;
      background: #f1f5f9;
      cursor: move;
      user-select: none;
      box-sizing: border-box;
    }
    .taskDesignerDetailTitle {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 700;
      color: #1f2937;
    }
    .taskDesignerDetailClose {
      flex: 0 0 auto;
      width: 24px;
      height: 24px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: #334155;
      cursor: pointer;
      font-size: 14px;
      line-height: 20px;
    }
    .taskDesignerDetailClose:hover {
      border-color: #cbd5e1;
      background: #ffffff;
    }
    .taskDesignerDetailBody {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 10px;
      box-sizing: border-box;
      font-size: 12px;
    }
    .taskDesignerDetailGrid {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr);
      gap: 6px 10px;
      margin-bottom: 12px;
    }
    .taskDesignerDetailLabel {
      color: #64748b;
      font-weight: 700;
    }
    .taskDesignerDetailValue {
      min-width: 0;
      color: #253244;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .taskDesignerDetailSectionTitle {
      margin: 12px 0 5px;
      color: #334155;
      font-weight: 700;
    }
    .taskDesignerDetailPre {
      min-height: 34px;
      margin: 0;
      padding: 8px;
      overflow: auto;
      border: 1px solid #e2e8f0;
      border-radius: 5px;
      background: #f8fafc;
      color: #253244;
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
      line-height: 1.35;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `;
  document.head.appendChild(style);
}

function setStatus(text, tone = "") {
  if (!taskStatusEl) return;
  taskStatusEl.textContent = String(text || "");
  taskStatusEl.dataset.tone = tone || "";
}

function ensureWindow() {
  if (taskDesignerWindow?.isConnected) return taskDesignerWindow;
  ensureStyles();
  const section = document.createElement("section");
  section.id = "taskDesignerWindow";
  section.className = "taskDesignerWindow host-nodrag";
  section.setAttribute("role", "region");
  section.setAttribute("aria-label", "Task Designer progress");
  section.dataset.windowId = DEFAULT_WINDOW_ID;
  section.innerHTML = `
    <div class="taskDesignerBody">
      <div class="taskDesignerTableWrap">
        <table class="taskDesignerTable">
          <thead>
            <tr>
              <th class="taskDesignerTaskName">Task Name</th>
              <th class="taskDesignerDescription">Description</th>
              <th class="taskDesignerDuration">Duration</th>
              <th class="taskDesignerResult">Status</th>
              <th class="taskDesignerOutput">Comments</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <div class="taskDesignerEmpty">Waiting for task progress from a script.</div>
      </div>
      <div class="taskDesignerFooter" aria-live="polite"></div>
    </div>
  `;
  document.body.appendChild(section);
  taskDesignerWindow = section;
  taskStatusEl = section.querySelector(".taskDesignerFooter");
  taskTbody = section.querySelector("tbody");
  emptyEl = section.querySelector(".taskDesignerEmpty");
  return section;
}

function clearTasks() {
  taskRows = [];
  taskRowMap = new Map();
  if (durationTimer) {
    window.clearInterval(durationTimer);
    durationTimer = null;
  }
  closeTaskDetailWindow();
  renderTasks();
}

function resetForSession(sessionId = "", force = false) {
  const nextSessionId = toText(sessionId);
  const shouldReset = !!force || !!(nextSessionId && nextSessionId !== activeSessionId);
  if (nextSessionId) activeSessionId = nextSessionId;
  if (shouldReset) clearTasks();
  return shouldReset;
}

function upsertTask(raw = {}) {
  const id = toText(raw.task_id || raw.taskId || raw.id || raw.name || `task_${taskRows.length + 1}`);
  if (!id) return null;
  let row = taskRowMap.get(id);
  if (!row) {
    row = {
      id,
      name: toText(raw.name || raw.task_name || raw.taskName || id),
      description: toText(raw.description || raw.desc),
      status: "pending",
      message: "",
      details: null,
      startMs: 0,
      endMs: 0,
      durationMs: 0,
    };
    taskRowMap.set(id, row);
    taskRows.push(row);
  }
  if (raw.name || raw.task_name || raw.taskName) row.name = toText(raw.name || raw.task_name || raw.taskName);
  if (raw.description || raw.desc) row.description = toText(raw.description || raw.desc);
  return row;
}

function applyTaskUpdate(raw = {}) {
  const row = upsertTask(raw);
  if (!row) return null;
  const status = normalizeStatus(raw.status || raw.result || "");
  if (status) row.status = status;
  if (raw.message !== undefined) row.message = String(raw.message || "");
  if (raw.details !== undefined) row.details = raw.details;
  if (row.status === "running" && !row.startMs) {
    row.startMs = nowMs();
    row.endMs = 0;
  }
  if (isFinalStatus(row.status)) {
    if (!row.startMs) row.startMs = nowMs();
    row.endMs = nowMs();
    row.durationMs = row.endMs - row.startMs;
  }
  if (Number.isFinite(Number(raw.duration_ms))) row.durationMs = Number(raw.duration_ms);
  renderTasks();
  syncTaskDetailWindow();
  syncDurationTimer();
  return row;
}

function formatDetails(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function taskOutputText(row) {
  const detailsText = row.details == null || typeof row.details === "string"
    ? toText(row.details)
    : JSON.stringify(row.details);
  return row.message || detailsText;
}

function taskDurationForRow(row) {
  return normalizeStatus(row.status) === "running" && row.startMs
    ? nowMs() - row.startMs
    : row.durationMs;
}

function closeTaskDetailWindow() {
  const hadActiveDetail = !!activeDetailTaskId;
  activeDetailTaskId = "";
  if (taskDetailWindow) taskDetailWindow.hidden = true;
  if (hadActiveDetail) renderTasks();
}

function ensureTaskDetailWindow() {
  ensureStyles();
  if (taskDetailWindow?.isConnected) return taskDetailWindow;

  const win = document.createElement("section");
  win.className = "taskDesignerDetailWindow host-nodrag";
  win.hidden = true;
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "Task details");
  win.innerHTML = `
    <div class="taskDesignerDetailTitlebar">
      <div class="taskDesignerDetailTitle"></div>
      <button class="taskDesignerDetailClose" type="button" title="Close">x</button>
    </div>
    <div class="taskDesignerDetailBody"></div>
  `;
  document.body.appendChild(win);
  taskDetailWindow = win;
  taskDetailBody = win.querySelector(".taskDesignerDetailBody");
  win.querySelector(".taskDesignerDetailClose")?.addEventListener("click", closeTaskDetailWindow);
  wireTaskDetailDrag(win, win.querySelector(".taskDesignerDetailTitlebar"));
  return win;
}

function clampDetailWindowPosition(win) {
  const rect = win.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width - 4);
  const maxTop = Math.max(0, window.innerHeight - rect.height - 4);
  const left = Math.min(Math.max(4, rect.left), maxLeft);
  const top = Math.min(Math.max(4, rect.top), maxTop);
  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
  win.style.right = "auto";
  win.style.bottom = "auto";
}

function wireTaskDetailDrag(win, handle) {
  if (!win || !handle || handle.dataset.dragWired === "1") return;
  handle.dataset.dragWired = "1";
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button")) return;
    const rect = win.getBoundingClientRect();
    win.style.left = `${rect.left}px`;
    win.style.top = `${rect.top}px`;
    win.style.right = "auto";
    win.style.bottom = "auto";
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      const nextLeft = startLeft + moveEvent.clientX - startX;
      const nextTop = startTop + moveEvent.clientY - startY;
      win.style.left = `${nextLeft}px`;
      win.style.top = `${nextTop}px`;
      clampDetailWindowPosition(win);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop, { once: true });
    handle.addEventListener("pointercancel", stop, { once: true });
  });
}

function appendDetailRow(grid, label, value) {
  const labelEl = document.createElement("div");
  labelEl.className = "taskDesignerDetailLabel";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "taskDesignerDetailValue";
  valueEl.textContent = value || "";
  grid.append(labelEl, valueEl);
}

function renderTaskDetailWindow(row) {
  const win = ensureTaskDetailWindow();
  if (!row || !taskDetailBody) return;
  const normalizedStatus = normalizeStatus(row.status);
  const resultLabel = STATUS_LABELS[normalizedStatus] || row.status || "Pending";
  const duration = formatDuration(taskDurationForRow(row));
  const output = taskOutputText(row);
  win.querySelector(".taskDesignerDetailTitle").textContent = row.name || row.id || "Task Details";
  taskDetailBody.textContent = "";

  const grid = document.createElement("div");
  grid.className = "taskDesignerDetailGrid";
  appendDetailRow(grid, "Task ID", row.id);
  appendDetailRow(grid, "Task Name", row.name || row.id);
  appendDetailRow(grid, "Description", row.description);
  appendDetailRow(grid, "Status", resultLabel);
  appendDetailRow(grid, "Duration", duration);
  taskDetailBody.appendChild(grid);

  const outputTitle = document.createElement("div");
  outputTitle.className = "taskDesignerDetailSectionTitle";
  outputTitle.textContent = "Comments";
  const outputPre = document.createElement("pre");
  outputPre.className = "taskDesignerDetailPre";
  outputPre.textContent = output || "";
  taskDetailBody.append(outputTitle, outputPre);

  const detailsTitle = document.createElement("div");
  detailsTitle.className = "taskDesignerDetailSectionTitle";
  detailsTitle.textContent = "Details";
  const detailsPre = document.createElement("pre");
  detailsPre.className = "taskDesignerDetailPre";
  detailsPre.textContent = formatDetails(row.details);
  taskDetailBody.append(detailsTitle, detailsPre);

  win.hidden = false;
  clampDetailWindowPosition(win);
}

function openTaskDetailWindow(row) {
  if (!row) return;
  activeDetailTaskId = row.id;
  renderTaskDetailWindow(row);
  renderTasks();
}

function syncTaskDetailWindow() {
  if (!activeDetailTaskId || !taskDetailWindow || taskDetailWindow.hidden) return;
  const row = taskRowMap.get(activeDetailTaskId);
  if (!row) {
    closeTaskDetailWindow();
    return;
  }
  renderTaskDetailWindow(row);
}

function renderTasks() {
  if (!taskTbody || !emptyEl) return;
  taskTbody.textContent = "";
  emptyEl.style.display = taskRows.length ? "none" : "block";
  taskRows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.className = `taskDesignerStatus-${normalizeStatus(row.status)}`;
    tr.dataset.taskId = row.id;
    if (row.id === activeDetailTaskId) tr.classList.add("is-detail-open");
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `Open details for ${row.name || row.id}`);
    const status = normalizeStatus(row.status);
    const duration = taskDurationForRow(row);
    const message = taskOutputText(row);
    tr.innerHTML = `
      <td class="taskDesignerTaskName"></td>
      <td class="taskDesignerDescription"></td>
      <td class="taskDesignerDuration"></td>
      <td class="taskDesignerResult">
        <div class="taskDesignerResultText">
          <span class="taskDesignerDot" aria-hidden="true"></span>
          <span class="taskDesignerResultLabel"></span>
          <span class="taskDesignerRunningDots" aria-hidden="true"><span></span><span></span><span></span></span>
        </div>
      </td>
      <td class="taskDesignerOutput"><div class="taskDesignerMessage taskDesignerLineClamp"></div></td>
    `;
    const name = row.name || row.id;
    const description = row.description || "";
    tr.children[0].innerHTML = `<div class="taskDesignerLineClamp"></div>`;
    tr.children[1].innerHTML = `<div class="taskDesignerLineClamp"></div>`;
    tr.children[0].querySelector(".taskDesignerLineClamp").textContent = name;
    tr.children[0].title = name;
    tr.children[1].querySelector(".taskDesignerLineClamp").textContent = description;
    tr.children[1].title = description;
    const durationLabel = formatDuration(duration);
    if (status === "running") {
      tr.children[2].innerHTML = `
        <span class="taskDesignerDurationRunning">
          <span class="taskDesignerDurationSpinner" aria-hidden="true"></span>
          <span class="taskDesignerDurationText"></span>
        </span>
      `;
      tr.querySelector(".taskDesignerDurationText").textContent = durationLabel || "Running";
    } else {
      tr.children[2].textContent = durationLabel;
    }
    tr.children[2].title = durationLabel || (status === "running" ? "Running" : "");
    const resultLabel = STATUS_LABELS[status] || row.status || "Pending";
    tr.querySelector(".taskDesignerResultLabel").textContent = resultLabel;
    tr.children[3].title = resultLabel;
    tr.querySelector(".taskDesignerMessage").textContent = message || "";
    tr.children[4].title = message || "";
    tr.addEventListener("click", () => openTaskDetailWindow(row));
    tr.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openTaskDetailWindow(row);
    });
    taskTbody.appendChild(tr);
  });
}

function updateRunningDurations() {
  if (!taskTbody) return;
  taskTbody.querySelectorAll("tr[data-task-id]").forEach((tr) => {
    const row = taskRowMap.get(tr.dataset.taskId);
    if (!row || normalizeStatus(row.status) !== "running") return;
    const durationLabel = formatDuration(taskDurationForRow(row)) || "Running";
    const textEl = tr.querySelector(".taskDesignerDurationText");
    const durationCell = tr.querySelector(".taskDesignerDuration");
    if (textEl) textEl.textContent = durationLabel;
    if (durationCell) durationCell.title = durationLabel;
  });
}

function syncDurationTimer() {
  const hasRunning = taskRows.some((row) => normalizeStatus(row.status) === "running" && row.startMs);
  if (hasRunning && !durationTimer) {
    durationTimer = window.setInterval(() => {
      updateRunningDurations();
      syncTaskDetailWindow();
    }, 500);
  } else if (!hasRunning && durationTimer) {
    window.clearInterval(durationTimer);
    durationTimer = null;
  }
}

export function openTaskDesigner(options = {}) {
  ensureWindow();
  resetForSession(options.sessionId || options.session_id || "", options.reset === true);
  const context = toText(options.contextLabel || options.context);
  setStatus(context || (taskRows.length ? "" : "Waiting for task progress from a script."));
}

export function closeTaskDesigner() {
  if (IS_EMBEDDED_TAB) {
    try { window.parent?.postMessage({ type: "arcrho:close-task-designer" }, "*"); } catch {}
  }
}

export function initTaskDesignerWindow() {
  ensureWindow();
}

function applyInitialOptionsFromUrl() {
  const params = new URLSearchParams(window.location.search || "");
  openTaskDesigner({
    title: params.get("title") || "Task Designer",
    contextLabel: params.get("context") || "Waiting for script updates",
  });
}

function installEmbeddedMessageHandlers() {
  if (!IS_EMBEDDED_TAB || window.__arcrhoTaskDesignerMessagesWired) return;
  window.__arcrhoTaskDesignerMessagesWired = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data || {};
    if (msg.type === "arcrho:task-designer-open") {
      const options = msg.options && typeof msg.options === "object" ? msg.options : {};
      openTaskDesigner(options);
      return;
    }
    if (msg.type === TASK_DESIGNER_COMMAND_MESSAGE) {
      const requestId = toText(msg.requestId);
      executeTaskDesignerAutomationCommand({
        command: msg.command,
        args: msg.args || {},
      })
        .then((result) => {
          window.parent.postMessage({
            type: TASK_DESIGNER_RESULT_MESSAGE,
            requestId,
            ok: !!result?.ok,
            result: result?.result || {},
            error: result?.error || "",
          }, "*");
        })
        .catch((err) => {
          window.parent.postMessage({
            type: TASK_DESIGNER_RESULT_MESSAGE,
            requestId,
            ok: false,
            result: {},
            error: String(err?.message || err || "Task Designer command failed."),
          }, "*");
        });
    }
  });
}

export async function executeTaskDesignerAutomationCommand(command = {}) {
  const args = command.args || {};
  const commandName = toText(command.command);
  ensureWindow();
  const windowId = toText(args.windowId || args.window_id || DEFAULT_WINDOW_ID) || DEFAULT_WINDOW_ID;
  if (windowId !== DEFAULT_WINDOW_ID) {
    return { ok: false, error: `Unknown Task Designer window: ${windowId}` };
  }
  const incomingSessionId = toText(args.sessionId || args.session_id);
  const startsNewRun = commandName === "taskDesigner.open" || commandName === "taskDesigner.setTasks";
  if (incomingSessionId && activeSessionId && incomingSessionId !== activeSessionId && !startsNewRun) {
    return { ok: false, error: "Task Designer session is no longer active." };
  }
  if (commandName === "taskDesigner.open") {
    openTaskDesigner({
      title: args.title || "Task Designer",
      contextLabel: args.context || args.contextLabel || "",
      sessionId: incomingSessionId,
      reset: args.reset === true,
    });
    return { ok: true, result: { windowId: DEFAULT_WINDOW_ID } };
  }
  if (commandName === "taskDesigner.close") {
    closeTaskDesigner();
    return { ok: true, result: { windowId: DEFAULT_WINDOW_ID, closed: true } };
  }
  if (commandName === "taskDesigner.setTasks") {
    if (incomingSessionId) activeSessionId = incomingSessionId;
    clearTasks();
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    tasks.forEach((task) => upsertTask(task));
    renderTasks();
    syncDurationTimer();
    return { ok: true, result: { windowId: DEFAULT_WINDOW_ID, count: taskRows.length } };
  }
  if (commandName === "taskDesigner.registerTask") {
    const row = upsertTask(args);
    renderTasks();
    return { ok: !!row, result: { windowId: DEFAULT_WINDOW_ID, taskId: row?.id || "" }, error: row ? "" : "Task id is required." };
  }
  if (commandName === "taskDesigner.startTask") {
    const row = applyTaskUpdate({ ...args, status: "running" });
    return { ok: !!row, result: { windowId: DEFAULT_WINDOW_ID, taskId: row?.id || "" }, error: row ? "" : "Task id is required." };
  }
  if (commandName === "taskDesigner.updateTask") {
    const row = applyTaskUpdate(args);
    return { ok: !!row, result: { windowId: DEFAULT_WINDOW_ID, taskId: row?.id || "" }, error: row ? "" : "Task id is required." };
  }
  if (commandName === "taskDesigner.completeTask") {
    const row = applyTaskUpdate({ ...args, status: args.result || args.status || "pass" });
    return { ok: !!row, result: { windowId: DEFAULT_WINDOW_ID, taskId: row?.id || "" }, error: row ? "" : "Task id is required." };
  }
  return { ok: false, error: `Unsupported Task Designer command: ${commandName}` };
}

installEmbeddedMessageHandlers();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyInitialOptionsFromUrl, { once: true });
} else {
  applyInitialOptionsFromUrl();
}
