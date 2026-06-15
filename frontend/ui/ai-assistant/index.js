import { ensureAiAssistantDom } from "./template.js";
import {
  ATTACHMENT_EXTENSIONS as ASSISTANT_ATTACHMENT_EXTENSIONS,
  PANEL_DEFAULT_HEIGHT as ASSISTANT_PANEL_DEFAULT_HEIGHT,
  PANEL_MIN_WIDTH as ASSISTANT_PANEL_MIN_WIDTH,
  VISIBLE_WORK_STEP_IDS as ASSISTANT_VISIBLE_WORK_STEP_IDS,
  WORK_STEP_DEFS as ASSISTANT_WORK_STEP_DEFS,
  WORK_TYPING_CHARS_PER_FRAME as ASSISTANT_WORK_TYPING_CHARS_PER_FRAME,
  WORK_TYPING_FRAME_MS as ASSISTANT_WORK_TYPING_FRAME_MS,
} from "./state.js";
import {
  MODEL_OPTIONS as ASSISTANT_MODEL_OPTIONS,
  REASONING_OPTIONS as ASSISTANT_REASONING_OPTIONS,
  assistantModelSupportsReasoning,
  getAssistantModelLabelFor,
  getAssistantReasoningLabelFor,
  isClaudeAssistantModel,
  normalizeAssistantModel,
  normalizeAssistantReasoningEffort,
  shouldShowTokenAlertFor,
} from "./models.js";
import {
  appendAssistantInlineMarkdown,
  createAssistantUserAvatarSvg,
  renderAssistantMessageContent,
  typeAssistantMessage as typeAssistantMessageContent,
} from "./messages.js";
import {
  normalizeActivities,
  normalizeDebugLogs,
  normalizeMessages,
  nowIso,
} from "./sessions.js";
import {
  formatContextPercent,
  formatContextWindowUsage,
  formatTokenCount,
  getUsagePercent,
  normalizeAssistantContextForPanel,
} from "./context.js";
import {
  getAttachmentIconKind,
  getAttachmentIconSvg,
  getAttachmentTypeLabel,
} from "./attachments.js";
import { formatElapsed, formatWorkDuration } from "./activity.js";
import { normalizeReadableRootList } from "./settings.js";
import { clampAssistantPanelSize } from "./layout.js";
import { getHostErrorMessage } from "./host.js";

const defaultShell = {};
let shell = defaultShell;
let getHostApi = () => window.ADAHost || null;
let $ = (id) => document.getElementById(id);
let assistantConfig = {
  appName: "Arcode",
  botName: "ArcBot",
  messageNamespace: "arcode",
  storagePrefix: "arcode",
  contextTimeoutMs: 900,
  projectInstanceContextTimeoutMs: 900,
  enableDfmApproval: false,
  getAppContextTooltipRows: null,
};
let ASSISTANT_LAUNCHER_VISIBLE_KEY = "arcode_ai_assistant_launcher_visible";
let ASSISTANT_LAUNCHER_POSITION_KEY = "arcode_ai_assistant_launcher_position";
let ASSISTANT_PANEL_SIZE_KEY = "arcode_ai_assistant_panel_size";
let ASSISTANT_PANEL_OPENED_SESSION_KEY = "arcode_ai_assistant_panel_opened_session";

let assistantMessages = [];
let assistantActivities = [];
let assistantDebugLogs = [];
let assistantAttachments = [];
let currentSessionId = "";
let currentSessionTitle = "New ArcBot Chat";
let currentContext = null;
let currentUsage = null;
let currentRequestId = "";
let currentPendingMessageEl = null;
let currentRunStartedAt = 0;
let currentStepStartedAt = 0;
let currentWorkCardEl = null;
let assistantWorkCardExpanded = false;
let assistantProgressSteps = [];
let assistantProgressTicker = null;
let latestSessionList = [];
let assistantMode = "edit";
let assistantModel = "codex";
let assistantReasoningEffort = "high";
let assistantReadableRoots = [];
let assistantReady = false;
let assistantBusy = false;
let assistantCancelRequested = false;
let assistantHostRequestSubmitted = false;
let assistantAppContextEnabled = true;
let assistantStatusChecked = false;
let assistantInstallJustSucceeded = false;
let suppressLauncherClick = false;
let assistantUserAvatarName = "Arcode";
let assistantAuthStatus = "";
const assistantActivityTypingStates = new Map();
let assistantActivityTypingTimer = null;

export function configureAiAssistant(config = {}) {
  assistantConfig = {
    ...assistantConfig,
    ...config,
  };
  shell = config.shell || shell || defaultShell;
  getHostApi = typeof config.getHostApi === "function" ? config.getHostApi : getHostApi;
  $ = typeof config.$ === "function" ? config.$ : $;
  const storagePrefix = String(assistantConfig.storagePrefix || assistantConfig.messageNamespace || "arcode").trim() || "arcode";
  assistantConfig.storagePrefix = storagePrefix;
  ASSISTANT_LAUNCHER_VISIBLE_KEY = `${storagePrefix}_ai_assistant_launcher_visible`;
  ASSISTANT_LAUNCHER_POSITION_KEY = `${storagePrefix}_ai_assistant_launcher_position`;
  ASSISTANT_PANEL_SIZE_KEY = `${storagePrefix}_ai_assistant_panel_size`;
  ASSISTANT_PANEL_OPENED_SESSION_KEY = `${storagePrefix}_ai_assistant_panel_opened_session`;
  assistantUserAvatarName = String(assistantConfig.appName || "Arcode").trim() || "Arcode";
}

function assistantMessageType(name) {
  const namespace = String(assistantConfig.messageNamespace || "arcode").trim() || "arcode";
  return `${namespace}:assistant-${name}`;
}

function setText(el, text) {
  if (el) el.textContent = text || "";
}

function setAssistantConnectionStatus(online, detail = "") {
  const el = $("aiAssistantConnectionStatus");
  if (!el) return;
  el.classList.toggle("online", !!online);
  el.classList.toggle("offline", !online);
  el.textContent = online ? "Online" : "Offline";
  el.setAttribute("aria-label", online ? "ArcBot online" : "ArcBot offline");
  el.title = detail || (online ? "ArcBot is online" : "ArcBot is offline");
  updateAssistantSettingsPanel();
}

function setStatus(text, _tone = "") {
  setAssistantConnectionStatus(assistantReady, text);
}

function getAssistantModelLabel(model = assistantModel) {
  return getAssistantModelLabelFor(model);
}

function getAssistantReasoningLabel(effort = assistantReasoningEffort) {
  return getAssistantReasoningLabelFor(effort);
}

function isClaudeModel(model = assistantModel) {
  return isClaudeAssistantModel(model);
}

function assistantModelHasReasoning(model = assistantModel) {
  return assistantModelSupportsReasoning(model);
}

function shouldShowAssistantTokenAlert() {
  return shouldShowTokenAlertFor(assistantModel, assistantReasoningEffort);
}

function formatAssistantLoginDetail() {
  const appName = String(assistantConfig.appName || "Arcode").trim() || "Arcode";
  const user = assistantUserAvatarName && assistantUserAvatarName !== appName ? assistantUserAvatarName : "Unknown";
  const auth = String(assistantAuthStatus || "").replace(/\s+/g, " ").trim();
  if (!auth) return user;
  return user === "Unknown" ? auth : `${user} - ${auth}`;
}

function setSetup({ open = false, text = "", install = false, login = false } = {}) {
  const setup = $("aiAssistantSetup");
  const setupText = $("aiAssistantSetupText");
  const installBtn = $("aiAssistantSetupBtn");
  const loginBtn = $("aiAssistantLoginBtn");
  setup?.classList.toggle("open", !!open);
  setText(setupText, text);
  if (installBtn) installBtn.style.display = install ? "inline-block" : "none";
  if (loginBtn) loginBtn.style.display = login ? "inline-block" : "none";
}

function getSessionPayload() {
  return {
    id: currentSessionId,
    title: currentSessionTitle,
    mode: assistantMode,
    model: assistantModel,
    reasoningEffort: assistantReasoningEffort,
    messages: assistantMessages,
    activities: assistantActivities,
    debugLogs: assistantDebugLogs,
    context: currentContext,
    usage: currentUsage,
  };
}

async function saveCurrentSession() {
  const host = getHostApi();
  if (!host?.codexAssistantSaveSession || !currentSessionId) return;
  try {
    const result = await host.codexAssistantSaveSession(getSessionPayload());
    if (result?.ok && result.session) {
      currentSessionId = result.session.id || currentSessionId;
      currentSessionTitle = result.session.title || currentSessionTitle;
      updateSessionSelectLabel();
    }
  } catch {
    // Session persistence failures should not block chat.
  }
}

function renderMessages() {
  const container = $("aiAssistantMessages");
  if (!container) return;
  container.textContent = "";
  currentWorkCardEl = null;
  assistantWorkCardExpanded = false;
  appendAssistantDisclaimer(container);
  for (const message of assistantMessages) {
    appendMessage(message.role, message.content, { save: false });
  }
  renderActivities();
}

function appendAssistantDisclaimer(container) {
  if (!container) return;
  const notice = document.createElement("div");
  notice.className = "aiAssistantDisclaimer";
  notice.textContent = "ArcBot is AI-powered and can make mistakes. Double-check important responses.";
  container.appendChild(notice);
}

function getAssistantContextTitle(context = currentContext) {
  const title = String(context?.title || "").trim();
  if (title) return title;
  const tabType = String(context?.tabType || "").trim();
  if (tabType && tabType !== "home") return tabType;
  return "active app tab";
}

function getAssistantContextKind(context = currentContext) {
  const tabType = String(context?.tabType || "").trim().toLowerCase();
  const nestedType = String(context?.nestedPageType || context?.activeNestedWindow?.kind || "").trim().toLowerCase();
  if (tabType === "project_instance" && nestedType === "dfm") return "Project Instance DFM window";
  if (tabType === "project_instance" && nestedType === "dataset") return "Project Instance Dataset window";
  if (tabType === "project_instance") return "Project Instance";
  if (tabType === "dfm") return "DFM page";
  if (tabType === "dataset") return "Dataset Viewer";
  if (tabType === "scripting") return "notebook";
  if (tabType === "off") return "app context";
  return tabType || "active app tab";
}

function getAssistantTargetKind(context = currentContext) {
  const target = String(context?.targetPath || context?.path || "").trim().toLowerCase();
  if (target.endsWith(".ipynb") || target.endsWith(".arcnb")) return "notebook file";
  if (target.endsWith(".json")) return "JSON-backed app file";
  if (context?.tabType === "project_instance" && context?.activeNestedWindow?.kind === "dfm") return "active Project Instance DFM method data";
  if (context?.tabType === "project_instance" && context?.activeNestedWindow?.kind === "dataset") return "active Project Instance dataset window";
  if (context?.tabType === "dfm") return "DFM method data";
  if (context?.tabType === "scripting") return "notebook data";
  return "active app data";
}

function isAssistantDfmWork(context = currentContext) {
  if (!assistantConfig.enableDfmApproval) return false;
  const tabType = String(context?.tabType || context?.pageType || "").trim().toLowerCase();
  const title = String(context?.title || "").trim().toLowerCase();
  const target = String(context?.targetPath || context?.path || "").trim().toLowerCase();
  return tabType === "dfm" || title.includes("dfm") || /(^|[\\/])dfm@/i.test(target);
}

function formatAssistantContextScanStatus(context, fallback = "") {
  if (context?.disabled) return "App Context is off, so Codex will use only the chat and attachments.";
  if (!context?.available) return fallback || "No active app tab data was available for this request.";
  return `Reading ${getAssistantContextKind(context)} context from "${getAssistantContextTitle(context)}".`;
}

function formatAssistantUsageStatus(usage) {
  const tokens = Number(usage?.estimatedTokens || 0);
  const percent = Number(usage?.contextPercentUsed || 0);
  const parts = [];
  if (tokens) parts.push(`about ${tokens.toLocaleString()} tokens${percent ? ` (${formatContextPercent(percent)} of window)` : ""}`);
  if (Number(usage?.attachmentCount || 0)) parts.push(`${Number(usage.attachmentCount).toLocaleString()} attachment(s)`);
  if (Number(usage?.activeJsonChars || 0)) parts.push("active page JSON");
  if (usage?.truncated) parts.push("trimmed to fit");
  return parts.length
    ? `Packed ${parts.join(", ")} for Codex.`
    : "Packed the chat request for Codex.";
}

function updateTokenUsageRing() {
  const usageEl = $("aiAssistantTokenUsage");
  const textEl = $("aiAssistantTokenUsageText");
  const fillEl = usageEl?.querySelector?.(".aiAssistantTokenRingFill");
  if (!usageEl || !textEl || !fillEl) return;
  const usage = currentUsage || {};
  const used = Math.max(0, Math.round(Number(usage.estimatedTokens || 0)));
  const windowTokens = Math.max(0, Math.round(Number(usage.contextWindowTokens || 0)));
  const percent = windowTokens ? getUsagePercent(usage) : 0;
  const measured = !!windowTokens;
  const tooltip = measured
    ? `Context window\n${formatTokenCount(used)} / ${formatTokenCount(windowTokens)} tokens (${formatContextPercent(percent)})`
    : "Context window usage\nNot measured yet.";
  const ariaLabel = measured
    ? `Context window usage: ${formatTokenCount(used)} / ${formatTokenCount(windowTokens)} tokens (${formatContextPercent(percent)}).`
    : "Context window usage has not been measured yet.";
  textEl.textContent = tooltip;
  fillEl.setAttribute("stroke-dasharray", `${Math.min(100, Math.max(0, percent))} 100`);
  usageEl.classList.toggle("not-measured", !measured);
  usageEl.classList.toggle("high", measured && percent >= 75 && percent < 90);
  usageEl.classList.toggle("critical", measured && percent >= 90);
  usageEl.removeAttribute("title");
  usageEl.setAttribute("aria-label", ariaLabel);
}

function formatAssistantActivityForCard(text, event = {}) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  const modeLabel = getModeLabel();
  const contextTitle = getAssistantContextTitle();
  const contextKind = getAssistantContextKind();
  const targetKind = getAssistantTargetKind();
  if (!raw) return "";
  if (lower.includes("checking latest arcbot edit history")) return "Looking up the latest ArcBot edit so it can be reverted safely.";
  if (lower.includes("resolving arcbot project")) return "Preparing the local ArcBot workspace and checking the configured server root.";
  if (lower.includes("arcbot can read the configured folders")) return "ArcBot can read the configured folders for this request.";
  if (lower.includes("arcbot can read the configured server root")) return "ArcBot can read the configured server folder for this request.";
  if (lower.includes("checking active json")) return `Checking read/write access for the active ${targetKind}.`;
  if (lower.includes("creating editable local json")) return `Creating a temporary editable copy of the active ${targetKind}.`;
  if (lower.includes("context estimate")) return formatAssistantUsageStatus(event.usage || currentUsage);
  if (lower.includes("starting warm codex session")) return `ArcBot is sending the request in ${modeLabel} for "${contextTitle}".`;
  if (lower.includes("warm codex session accepted")) return "ArcBot accepted the request and is starting the turn.";
  if (lower.includes("warm codex session unavailable")) return "ArcBot is switching to a one-shot request.";
  if (lower.includes("starting codex cli")) return "ArcBot is starting the prepared request.";
  if (lower.includes("codex is drafting") || lower.includes("arcbot is drafting")) return "ArcBot is drafting the response.";
  if (lower.includes("codex is running a command") || lower.includes("arcbot is running a local check")) return `ArcBot is running a local check in the workspace for the active ${contextKind}.`;
  if (lower.includes("codex is searching") || lower.includes("arcbot is searching")) return "ArcBot is searching for supporting context.";
  if (lower.includes("codex is using a tool") || lower.includes("arcbot is using a tool")) return `ArcBot is using a tool to inspect or validate the active ${targetKind}.`;
  if (lower.includes("codex is preparing file changes") || lower.includes("arcbot is preparing file changes")) return `ArcBot is preparing changes against the temporary ${targetKind} copy.`;
  if (lower.includes("codex updated the task plan") || lower.includes("arcbot updated the task plan")) return "ArcBot updated its task plan before continuing.";
  if (lower.includes("codex response received") || lower.includes("arcbot response received")) return "ArcBot finished drafting and is checking whether a validated update needs to be applied.";
  if (lower.includes("cleaned explanatory text")) return "ArcBot extracted the edited JSON from Codex's response and normalized the temp copy.";
  if (lower.includes("validating and applying")) return "ArcBot is validating the temp copy, backing up the original, and applying the update.";
  if (lower.includes("request canceled")) return "The request was canceled before completion.";
  if (lower.includes("cancel requested")) return "Stopping the current ArcBot request.";
  if (lower.includes("failed") || lower.includes("could not") || lower.includes("error:")) return raw;
  return raw;
}

function createAssistantProgressSteps() {
  return ASSISTANT_WORK_STEP_DEFS.map((step) => ({
    ...step,
    state: "pending",
    status: "",
    details: [],
    elapsedMs: 0,
    startedAt: 0,
  }));
}

function getAssistantProgressStepIndex(stepId) {
  return ASSISTANT_WORK_STEP_DEFS.findIndex((step) => step.id === stepId);
}

function normalizeAssistantProgressStatus(status) {
  const text = String(status || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (lower.includes("checking read/write access")) return "Checking whether the active page can be read and updated.";
  if (lower.includes("creating a temporary editable copy")) return "Preparing a safe app-data working copy before changing anything.";
  if (lower.includes("codex is preparing changes")) return "Preparing the requested app change.";
  if (lower.includes("codex finished drafting")) return "Checking whether the response includes an app update.";
  if (lower.includes("extracted the edited json")) return "Reading the proposed app-data update from the response.";
  if (lower.includes("validating the temp copy")) return "Validating the update, saving a backup, and applying the change.";
  if (lower.includes("applied json-backed edit")) return "Applied the requested app data change after validation.";
  if (lower.includes("response completed")) return "Finished the response.";
  if (lower.includes("request canceled")) return "Request canceled.";
  return "";
}

function appendAssistantProgressDetail(step, status) {
  if (!step) return "";
  if (!isAssistantDfmWork()) return "";
  const detail = normalizeAssistantProgressStatus(status);
  if (!detail) return "";
  if (!Array.isArray(step.details)) step.details = [];
  if (step.details.at(-1) !== detail && !step.details.includes(detail)) {
    step.details.push(detail);
  }
  return detail;
}

function finishAssistantProgressStep(step, state = "completed", status = "") {
  if (!step) return;
  const now = performance.now();
  if (step.startedAt) {
    step.elapsedMs += Math.max(0, now - step.startedAt);
    step.startedAt = 0;
  }
  step.state = state;
  if (status) {
    step.status = isAssistantDfmWork()
      ? (appendAssistantProgressDetail(step, status) || normalizeAssistantProgressStatus(status) || step.status)
      : String(status).trim();
  }
}

function updateAssistantProgressStep(stepId, state = "active", status = "", options = {}) {
  if (!assistantProgressSteps.length) assistantProgressSteps = createAssistantProgressSteps();
  const index = getAssistantProgressStepIndex(stepId);
  if (index < 0) return;
  const now = performance.now();
  assistantProgressSteps.forEach((step, stepIndex) => {
    if (stepIndex < index && (step.state === "pending" || step.state === "active")) {
      finishAssistantProgressStep(step, "completed");
    } else if (stepIndex !== index && step.state === "active") {
      finishAssistantProgressStep(step, stepIndex < index ? "completed" : "pending");
    }
  });
  const step = assistantProgressSteps[index];
  const displayStatus = isAssistantDfmWork()
    ? appendAssistantProgressDetail(step, status)
    : String(status || "").trim();
  if (state === "active") {
    if (step.state !== "active") step.startedAt = now;
    step.state = "active";
    if (displayStatus) step.status = displayStatus;
  } else {
    finishAssistantProgressStep(step, state, displayStatus || status);
  }
  if (options.render !== false) renderActivities();
}

function getAssistantProgressElapsed(step) {
  if (!step) return 0;
  const liveMs = step.state === "active" && step.startedAt
    ? performance.now() - step.startedAt
    : 0;
  return Math.max(0, Math.round(Number(step.elapsedMs || 0) + liveMs));
}

function completeAssistantProgress(status = "Completed") {
  if (!assistantProgressSteps.length) assistantProgressSteps = createAssistantProgressSteps();
  assistantProgressSteps.forEach((step, index) => {
    const finalStatus = index === assistantProgressSteps.length - 1 ? status : "";
    if (step.state !== "failed") finishAssistantProgressStep(step, "completed", finalStatus);
  });
  assistantWorkCardExpanded = false;
  renderActivities();
}

function failAssistantProgress(status = "Request failed") {
  if (!assistantProgressSteps.length) assistantProgressSteps = createAssistantProgressSteps();
  const activeStep = assistantProgressSteps.find((step) => step.state === "active") ||
    assistantProgressSteps.find((step) => step.state === "pending") ||
    assistantProgressSteps.at(-1);
  finishAssistantProgressStep(activeStep, "failed", status);
  assistantWorkCardExpanded = false;
  renderActivities();
}

function classifyAssistantActivity(activity) {
  const text = formatAssistantActivityForCard(activity?.rawText || activity?.text, activity) || String(activity?.text || "");
  const raw = String(activity?.rawText || activity?.text || "");
  const lower = `${text}\n${raw}`.toLowerCase();
  const type = String(activity?.type || "").toLowerCase();
  if (type === "error" || lower.includes("failed") || lower.includes("could not") || lower.includes("error:")) {
    return { stepId: "finalizing", state: "failed", status: text || "Request failed" };
  }
  if (lower.includes("request canceled") || lower.includes("cancel requested")) {
    return { stepId: "finalizing", state: "failed", status: text || "Request canceled" };
  }
  if (lower.includes("request received") || lower.includes("understanding") || lower.includes("reading your request")) {
    return { stepId: "understanding", state: "active", status: text || "Reading the request" };
  }
  if (
    lower.includes("active context") ||
    lower.includes("active app") ||
    lower.includes("active page") ||
    lower.includes("active json") ||
    lower.includes("active file") ||
    lower.includes("context estimate") ||
    lower.includes("scanned")
  ) {
    return { stepId: "scanning", state: "active", status: text };
  }
  if (
    lower.includes("codex") ||
    lower.includes("editable local") ||
    lower.includes("edit started") ||
    lower.includes("session prepared") ||
    lower.includes("resolving arcbot project") ||
    lower.includes("warm session") ||
    lower.includes("cli")
  ) {
    return { stepId: "executing", state: "active", status: text };
  }
  if (
    lower.includes("validating") ||
    lower.includes("applying") ||
    lower.includes("response received") ||
    lower.includes("response completed") ||
    lower.includes("edit completed") ||
    lower.includes("applied json") ||
    lower.includes("cleaned edited json")
  ) {
    const complete = lower.includes("response completed") || lower.includes("applied json");
    return { stepId: "finalizing", state: complete ? "completed" : "active", status: text };
  }
  return null;
}

function updateAssistantProgressFromActivity(activity, options = {}) {
  const progress = classifyAssistantActivity(activity);
  if (!progress) return;
  updateAssistantProgressStep(progress.stepId, progress.state, progress.status, options);
}

function inferAssistantProgressSteps(activities) {
  const savedSteps = createAssistantProgressSteps();
  const previousSteps = assistantProgressSteps;
  assistantProgressSteps = savedSteps;
  for (const activity of activities || []) {
    updateAssistantProgressFromActivity(activity, { render: false });
  }
  if ((activities || []).length && !savedSteps.some((step) => step.state === "failed")) {
    savedSteps.forEach((step) => {
      if (step.state === "active" || step.state === "pending") finishAssistantProgressStep(step, "completed");
    });
  }
  assistantProgressSteps = previousSteps;
  return savedSteps;
}

function startAssistantProgressTicker() {
  stopAssistantProgressTicker();
  assistantProgressTicker = window.setInterval(() => {
    if (!currentRunStartedAt) {
      stopAssistantProgressTicker();
      return;
    }
    renderActivities();
  }, 900);
}

function stopAssistantProgressTicker() {
  if (!assistantProgressTicker) return;
  window.clearInterval(assistantProgressTicker);
  assistantProgressTicker = null;
}

function stopAssistantActivityTypingTimer() {
  if (!assistantActivityTypingTimer) return;
  window.clearTimeout(assistantActivityTypingTimer);
  assistantActivityTypingTimer = null;
}

function resetAssistantActivityTyping() {
  assistantActivityTypingStates.clear();
  stopAssistantActivityTypingTimer();
}

function appendDebugLog(text, type = "debug") {
  const raw = String(text || "").trim();
  if (!raw) return;
  assistantDebugLogs.push({ type, text: raw, timestamp: nowIso() });
  assistantDebugLogs = assistantDebugLogs.slice(-300);
  renderDebugLog();
}

function renderDebugLog() {
  const log = $("aiAssistantDebugLog");
  if (!log) return;
  log.textContent = assistantDebugLogs
    .map((entry) => `[${entry.timestamp}] ${entry.type}: ${entry.text}`)
    .join("\n");
  log.scrollTop = log.scrollHeight;
}

function appendActivity(text, type = "activity", options = {}) {
  const now = performance.now();
  const elapsedMs = Number.isFinite(options.elapsedMs)
    ? options.elapsedMs
    : (currentStepStartedAt ? now - currentStepStartedAt : 0);
  if (currentRunStartedAt) currentStepStartedAt = now;
  const activity = {
    type,
    text: String(options.displayText || text || "").trim(),
    rawText: String(text || "").trim(),
    elapsedMs: Math.round(Math.max(0, elapsedMs)),
    timestamp: nowIso(),
  };
  if (!activity.text) return;
  assistantActivities.push(activity);
  assistantActivities = assistantActivities.slice(-120);
  updateAssistantProgressFromActivity(activity, { render: false });
  renderActivities();
  if (options.save !== false) saveCurrentSession();
}

function shouldShowAssistantActivity(activity, text) {
  const visible = String(text || "").trim();
  if (!visible) return false;
  const raw = String(activity?.rawText || activity?.text || "").trim();
  const lower = `${visible}\n${raw}`.toLowerCase();
  if (String(activity?.type || "").toLowerCase() === "error") return true;
  if (lower.includes("proposed") && lower.includes("update is valid")) return true;
  if (lower.includes("running command:") || lower.includes("codex is running a command")) return true;
  if (lower.includes("reading file:") || lower.includes("editing file:")) return true;
  if (lower.includes("configured server root") || lower.includes("configured server folder") || lower.includes("configured folders")) return true;
  if (lower.includes("checking read/write access")) return true;
  if (lower.includes("temporary editable copy")) return true;
  if (lower.includes("validating the temp copy")) return true;
  if (lower.includes("extracted the edited json")) return true;
  if (lower.includes("codex is using a tool") || lower.includes("arcbot is using a tool")) return true;
  if (lower.includes("codex is searching") || lower.includes("arcbot is searching")) return true;
  if (lower.includes("codex is drafting") || lower.includes("arcbot is drafting")) return true;
  if (lower.includes("active notebook")) return true;
  if (lower.includes("request canceled") || lower.includes("failed") || lower.includes("could not") || lower.includes("error:")) return true;
  return false;
}

function getAssistantActivityItems() {
  const items = [];
  for (const activity of assistantActivities) {
    const text = formatAssistantActivityForCard(activity.rawText || activity.text, activity) || String(activity.text || "").trim();
    if (!shouldShowAssistantActivity(activity, text)) continue;
    const previous = items.at(-1);
    if (previous?.text === text) continue;
    items.push({
      text,
      type: activity.type || "activity",
      elapsedMs: Number.isFinite(activity.elapsedMs) ? Math.max(0, activity.elapsedMs) : 0,
      timestamp: activity.timestamp || "",
    });
  }
  return items.slice(-18);
}

function getAssistantActivityElapsedMs() {
  if (currentRunStartedAt) return Math.max(0, performance.now() - currentRunStartedAt);
  return assistantActivities.reduce((sum, item) => (
    sum + (Number.isFinite(item.elapsedMs) ? Math.max(0, item.elapsedMs) : 0)
  ), 0);
}

function ensureAssistantWorkElement(container, isRunning) {
  const desiredTag = isRunning ? "DIV" : "DETAILS";
  if (!currentWorkCardEl || !currentWorkCardEl.isConnected || currentWorkCardEl.tagName !== desiredTag) {
    currentWorkCardEl?.remove();
    currentWorkCardEl = document.createElement(isRunning ? "div" : "details");
  }
  const pendingRow = currentPendingMessageEl?.closest?.(".aiAssistantMessageRow") || null;
  const assistantRows = [...container.querySelectorAll(".aiAssistantMessageRow.assistant")];
  const anchor = pendingRow || assistantRows.at(-1) || null;
  if (anchor && anchor !== currentWorkCardEl.nextSibling) {
    container.insertBefore(currentWorkCardEl, anchor);
  } else if (!currentWorkCardEl.parentNode) {
    container.appendChild(currentWorkCardEl);
  }
  return currentWorkCardEl;
}

function getAssistantActivityTypingKey(item, index) {
  return `${item.timestamp || index}:${item.type || "activity"}:${item.text}`;
}

function getAssistantActivityTypingState(item, index, enableTyping) {
  if (!enableTyping) return { text: item.text, isTyping: false };
  const key = getAssistantActivityTypingKey(item, index);
  let state = assistantActivityTypingStates.get(key);
  if (!state) {
    state = { text: item.text, visibleChars: 0 };
    assistantActivityTypingStates.set(key, state);
  } else if (state.text !== item.text) {
    state.text = item.text;
    state.visibleChars = Math.min(state.visibleChars, item.text.length);
  }
  const visibleChars = Math.min(state.visibleChars, state.text.length);
  return {
    text: state.text.slice(0, visibleChars),
    isTyping: visibleChars < state.text.length,
    key,
  };
}

function scheduleAssistantActivityTyping(keysInUse) {
  if (!currentRunStartedAt) {
    resetAssistantActivityTyping();
    return;
  }
  for (const key of assistantActivityTypingStates.keys()) {
    if (!keysInUse.has(key)) assistantActivityTypingStates.delete(key);
  }
  const hasPending = [...assistantActivityTypingStates.values()].some((state) => (
    state.visibleChars < state.text.length
  ));
  if (!hasPending || assistantActivityTypingTimer) return;
  assistantActivityTypingTimer = window.setTimeout(() => {
    assistantActivityTypingTimer = null;
    for (const state of assistantActivityTypingStates.values()) {
      if (state.visibleChars < state.text.length) {
        state.visibleChars = Math.min(
          state.text.length,
          state.visibleChars + ASSISTANT_WORK_TYPING_CHARS_PER_FRAME,
        );
      }
    }
    renderActivities();
  }, ASSISTANT_WORK_TYPING_FRAME_MS);
}

function createAssistantActivityList(items, options = {}) {
  const list = document.createElement("ul");
  list.className = "aiAssistantWorkList";
  const typingKeys = new Set();
  const enableTyping = !!options.typing;
  items.forEach((item, index) => {
    const typingState = getAssistantActivityTypingState(item, index, enableTyping);
    if (typingState.key) typingKeys.add(typingState.key);
    const bullet = document.createElement("li");
    bullet.className = [
      item.type === "error" ? "error" : "",
      typingState.isTyping ? "typing" : "",
    ].filter(Boolean).join(" ");
    bullet.setAttribute("aria-label", item.text);
    if (typingState.isTyping && !typingState.text) {
      bullet.appendChild(document.createTextNode("\u00a0"));
    } else if (typingState.isTyping) {
      bullet.appendChild(document.createTextNode(typingState.text));
    } else {
      appendAssistantInlineMarkdown(bullet, item.text);
    }
    list.appendChild(bullet);
  });
  if (enableTyping) scheduleAssistantActivityTyping(typingKeys);
  return list;
}

function renderActivities() {
  const legacyPanel = $("aiAssistantActivity");
  if (legacyPanel) legacyPanel.classList.remove("open");
  const container = $("aiAssistantMessages");
  if (!container) return;
  const isRunning = !!currentRunStartedAt;
  const activityItems = getAssistantActivityItems();
  if (!activityItems.length && !isRunning) {
    currentWorkCardEl?.remove();
    currentWorkCardEl = null;
    resetAssistantActivityTyping();
    return;
  }
  if (!isRunning) resetAssistantActivityTyping();
  const totalMs = getAssistantActivityElapsedMs();
  const workEl = ensureAssistantWorkElement(container, isRunning);
  workEl.textContent = "";
  if (isRunning) {
    workEl.className = "aiAssistantWorkLog running";
    workEl.appendChild(createAssistantActivityList(activityItems, { typing: true }));
  } else {
    const hasError = activityItems.some((item) => item.type === "error" || /failed|could not|error|canceled/i.test(item.text));
    workEl.className = `aiAssistantWorkArchive${hasError ? " failed" : ""}`;
    workEl.open = assistantWorkCardExpanded;
    const summary = document.createElement("summary");
    workEl.ontoggle = () => {
      assistantWorkCardExpanded = workEl.open;
      if (workEl.open) {
        window.requestAnimationFrame(() => {
          scrollMessagesToBottom();
        });
      }
    };
    const title = document.createElement("span");
    title.className = "aiAssistantWorkArchiveTitle";
    title.textContent = hasError ? `Stopped after ${formatWorkDuration(totalMs)}` : `Worked for ${formatWorkDuration(totalMs)}`;
    const meta = document.createElement("span");
    meta.className = "aiAssistantWorkArchiveMeta";
    meta.textContent = `${activityItems.length} update${activityItems.length === 1 ? "" : "s"}`;
    summary.append(title, meta);
    workEl.appendChild(summary);
    const body = document.createElement("div");
    body.className = "aiAssistantWorkArchiveBody";
    body.appendChild(createAssistantActivityList(activityItems));
    workEl.appendChild(body);
  }
  scrollMessagesToBottom();
}

function updateContextPanel() {
  updateTokenUsageRing();
  updateAssistantSettingsPanel();
  const panel = $("aiAssistantContextPanel");
  if (!panel) return;
  const context = currentContext || {};
  const usage = currentUsage || {};
  const rows = [
    ["Session", currentSessionTitle || currentSessionId || "New ArcBot Chat"],
    ["Tab", context.title || context.tabType || "No active tab context"],
    ["Type", context.tabType || "home"],
    ["File", context.targetPath || context.path || "No active JSON-backed file"],
    ["Context Window", formatContextWindowUsage(usage)],
    ["Prompt Size", usage.promptChars ? `${Number(usage.promptChars).toLocaleString()} chars, ~${formatTokenCount(usage.estimatedTokens)} tokens` : "Not measured yet"],
    ["Included", usage.includedMessages != null ? `${usage.includedMessages} messages${usage.truncated ? ", truncated" : ""}` : "Not measured yet"],
  ];
  panel.textContent = "";
  if (usage.contextWindowTokens && usage.estimatedTokens) {
    const meter = document.createElement("div");
    meter.className = "aiAssistantContextMeter";
    const meterFill = document.createElement("div");
    meterFill.className = "aiAssistantContextMeterFill";
    meterFill.style.width = `${Math.min(100, Math.max(0, getUsagePercent(usage)))}%`;
    meter.appendChild(meterFill);
    const meterText = document.createElement("div");
    meterText.className = "aiAssistantContextMeterText";
    meterText.textContent = `Estimated context used: ${formatContextPercent(getUsagePercent(usage))}`;
    panel.append(meter, meterText);
  }
  const grid = document.createElement("div");
  grid.className = "aiAssistantContextGrid";
  for (const [label, value] of rows) {
    const labelEl = document.createElement("div");
    labelEl.className = "aiAssistantContextLabel";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "aiAssistantContextValue";
    valueEl.title = String(value);
    valueEl.textContent = String(value);
    grid.append(labelEl, valueEl);
  }
  panel.appendChild(grid);
}

function setAssistantModel(model, options = {}) {
  const prevClaude = isClaudeModel();
  assistantModel = normalizeAssistantModel(model);
  const select = $("aiAssistantSettingsModelSelect");
  if (select) select.value = assistantModel;
  updateAssistantSettingsPanel();
  if (options.save !== false) saveCurrentSession();
  if (prevClaude !== isClaudeModel() && assistantStatusChecked) {
    refreshAssistantStatus();
  } else if (assistantReady) {
    setStatus(`${isClaudeModel() ? getAssistantModelLabel() : "Codex"} ready. ${getModeLabel()}.`);
  }
}

function setAssistantReasoningEffort(effort, options = {}) {
  assistantReasoningEffort = normalizeAssistantReasoningEffort(effort);
  const select = $("aiAssistantSettingsReasoningSelect");
  if (select) select.value = assistantReasoningEffort;
  updateAssistantSettingsPanel();
  if (options.save !== false) saveCurrentSession();
}

function setFolderPermissionsStatus(text) {
  const el = $("aiAssistantFolderStatus");
  if (el) {
    el.textContent = text || "";
    el.title = text || "";
  }
}

function renderFolderPermissionsList() {
  const list = $("aiAssistantFolderPermissionsList");
  if (!list) return;
  list.textContent = "";
  if (!assistantReadableRoots.length) {
    const empty = document.createElement("div");
    empty.className = "aiAssistantFolderEmpty";
    empty.textContent = "No extra folders added.";
    list.appendChild(empty);
  } else {
    assistantReadableRoots.forEach((folder, index) => {
      const row = document.createElement("div");
      row.className = "aiAssistantFolderRow";
      const icon = document.createElement("span");
      icon.className = "aiAssistantFolderIcon";
      icon.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6.5h6l2 2h10v9a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"></path>
        </svg>
      `;
      const pathEl = document.createElement("div");
      pathEl.className = "aiAssistantFolderPath";
      pathEl.textContent = folder;
      pathEl.title = folder;
      const removeBtn = document.createElement("button");
      removeBtn.className = "aiAssistantFolderRemoveBtn";
      removeBtn.type = "button";
      removeBtn.title = "Remove";
      removeBtn.setAttribute("aria-label", `Remove ${folder}`);
      removeBtn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12"></path>
          <path d="M18 6L6 18"></path>
        </svg>
      `;
      removeBtn.addEventListener("click", () => removeAssistantReadableRoot(index));
      row.append(icon, pathEl, removeBtn);
      list.appendChild(row);
    });
  }
  const countText = assistantReadableRoots.length
    ? `${assistantReadableRoots.length} extra folder${assistantReadableRoots.length === 1 ? "" : "s"} allowed.`
    : "Server folder is included by default.";
  setFolderPermissionsStatus(countText);
  updateAssistantSettingsPanel();
}

async function loadAssistantReadableRoots() {
  const host = getHostApi();
  if (!host?.codexAssistantLoadReadableRoots) {
    assistantReadableRoots = [];
    renderFolderPermissionsList();
    return;
  }
  try {
    const result = await host.codexAssistantLoadReadableRoots();
    assistantReadableRoots = normalizeReadableRootList(result?.folders || []);
    renderFolderPermissionsList();
  } catch {
    assistantReadableRoots = [];
    renderFolderPermissionsList();
  }
}

async function saveAssistantReadableRoots(nextFolders) {
  const host = getHostApi();
  const normalized = normalizeReadableRootList(nextFolders);
  if (!host?.codexAssistantSaveReadableRoots) {
    assistantReadableRoots = normalized;
    renderFolderPermissionsList();
    setFolderPermissionsStatus("Folder permissions are available in the desktop app only.");
    return false;
  }
  try {
    const result = await host.codexAssistantSaveReadableRoots(normalized);
    if (!result?.ok) throw new Error(result?.error || "Could not save folder permissions.");
    assistantReadableRoots = normalizeReadableRootList(result.folders || []);
    renderFolderPermissionsList();
    return true;
  } catch (err) {
    setFolderPermissionsStatus(String(err?.message || err || "Could not save folder permissions."));
    return false;
  }
}

function openFolderPermissionsPage() {
  closeAssistantSettingsPanel();
  $("aiAssistantDebugPanel")?.classList.remove("open");
  $("aiAssistantDebugBtn")?.setAttribute("aria-expanded", "false");
  $("aiAssistantFolderPermissionsPage")?.classList.add("open");
  renderFolderPermissionsList();
}

function closeFolderPermissionsPage() {
  $("aiAssistantFolderPermissionsPage")?.classList.remove("open");
}

async function addAssistantReadableRoot() {
  const host = getHostApi();
  if (!host?.pickFolder) {
    setFolderPermissionsStatus("Folder picker is available in the desktop app only.");
    return;
  }
  const startDir = assistantReadableRoots[assistantReadableRoots.length - 1] || "";
  const folder = await host.pickFolder(startDir);
  if (!folder) return;
  await saveAssistantReadableRoots([...assistantReadableRoots, folder]);
}

async function removeAssistantReadableRoot(index) {
  const next = assistantReadableRoots.filter((_folder, folderIndex) => folderIndex !== index);
  await saveAssistantReadableRoots(next);
}

async function openAssistantPromptGuide() {
  if (!shell?.openAgentGuideTab) {
    setStatus("ArcBot prompt guide is not available.", "error");
    return;
  }
  closeAssistantSettingsPanel();
  shell.openAgentGuideTab();
  setStatus("Opened ArcBot prompt guide.");
}

function updateAssistantSettingsPanel() {
  const panel = $("aiAssistantSettingsPanel");
  if (!panel) return;
  const modelSelect = $("aiAssistantSettingsModelSelect");
  const reasoningSelect = $("aiAssistantSettingsReasoningSelect");
  const reasoningField = $("aiAssistantSettingsReasoningField");
  const reasoningLabel = $("aiAssistantSettingsReasoningLabel");
  const hasReasoning = assistantModelHasReasoning();
  const isClaudeProvider = isClaudeModel();
  if (modelSelect) {
    modelSelect.value = assistantModel;
    modelSelect.disabled = assistantBusy;
  }
  if (reasoningSelect) {
    reasoningSelect.value = assistantReasoningEffort;
    reasoningSelect.disabled = assistantBusy;
  }
  if (reasoningField) reasoningField.style.display = hasReasoning ? "" : "none";
  if (reasoningLabel) reasoningLabel.textContent = isClaudeProvider ? "Thinking" : "Reasoning";
  panel.querySelectorAll(".aiAssistantReasoningDetail").forEach((el) => {
    el.style.display = hasReasoning ? "" : "none";
  });
  $("aiAssistantTokenAlert")?.classList.toggle("visible", shouldShowAssistantTokenAlert());
  const rows = [
    ["session", currentSessionTitle || currentSessionId || "New ArcBot Chat"],
    ["model", getAssistantModelLabel()],
    ["reasoning", hasReasoning ? getAssistantReasoningLabel() : "—"],
    ["folders", assistantReadableRoots.length ? `${assistantReadableRoots.length} extra` : "Server only"],
    ["tokens", formatContextWindowUsage(currentUsage || {})],
    ["status", assistantReady ? "Online" : "Offline"],
    ["login", formatAssistantLoginDetail()],
  ];
  for (const [key, value] of rows) {
    const node = panel.querySelector(`[data-ai-settings-detail="${key}"]`);
    if (node) {
      node.textContent = String(value);
      node.title = String(value);
    }
  }
}

function closeAssistantSettingsPanel() {
  $("aiAssistantSettingsPanel")?.classList.remove("open");
  $("aiAssistantSettingsBtn")?.setAttribute("aria-expanded", "false");
}

function toggleAssistantSettingsPanel(forceOpen) {
  const panel = $("aiAssistantSettingsPanel");
  const button = $("aiAssistantSettingsBtn");
  if (!panel || !button) return;
  const open = forceOpen == null ? !panel.classList.contains("open") : !!forceOpen;
  panel.classList.toggle("open", open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    $("aiAssistantDebugPanel")?.classList.remove("open");
    $("aiAssistantDebugBtn")?.setAttribute("aria-expanded", "false");
    updateAssistantSettingsPanel();
  }
}

function renderAssistantAttachments() {
  const list = $("aiAssistantAttachmentList");
  if (!list) return;
  list.textContent = "";
  list.classList.toggle("open", assistantAttachments.length > 0);
  assistantAttachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "aiAssistantAttachmentChip";
    chip.title = attachment.path || attachment.name || "Attached file";
    const icon = document.createElement("span");
    const kind = getAttachmentIconKind(attachment.name || attachment.path || "");
    icon.className = `aiAssistantAttachmentIcon type-${kind}`;
    icon.innerHTML = getAttachmentIconSvg(kind);
    const textWrap = document.createElement("span");
    textWrap.className = "aiAssistantAttachmentText";
    const name = document.createElement("span");
    name.className = "aiAssistantAttachmentName";
    name.textContent = attachment.name || "Attached file";
    const type = document.createElement("span");
    type.className = "aiAssistantAttachmentType";
    type.textContent = getAttachmentTypeLabel(attachment.name || attachment.path || "");
    textWrap.append(name, type);
    const remove = document.createElement("button");
    remove.className = "aiAssistantAttachmentRemove";
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${attachment.name || "attachment"}`);
    remove.textContent = "x";
    remove.addEventListener("click", () => {
      assistantAttachments.splice(index, 1);
      renderAssistantAttachments();
    });
    chip.append(icon, textWrap, remove);
    list.appendChild(chip);
  });
}

function closeAttachMenu() {
  $("aiAssistantAttachMenu")?.classList.remove("open");
  $("aiAssistantAttachBtn")?.setAttribute("aria-expanded", "false");
}

function toggleAttachMenu() {
  const menu = $("aiAssistantAttachMenu");
  const button = $("aiAssistantAttachBtn");
  const open = !menu?.classList.contains("open");
  menu?.classList.toggle("open", open);
  button?.setAttribute("aria-expanded", open ? "true" : "false");
}

async function attachAssistantContextFile() {
  closeAttachMenu();
  const host = getHostApi();
  if (!host?.pickOpenFile || !host?.readTextFile) {
    setStatus("File attachments are available in the desktop app only.", "error");
    return;
  }
  if (assistantAttachments.length >= 5) {
    setStatus("ArcBot can attach up to 5 files per request.", "error");
    return;
  }
  try {
    const filePath = await host.pickOpenFile({
      filters: [
        { name: "Context Files", extensions: ASSISTANT_ATTACHMENT_EXTENSIONS },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!filePath) return;
    if (assistantAttachments.some((item) => item.path === filePath)) {
      setStatus("That file is already attached.");
      return;
    }
    const result = await host.readTextFile({ path: filePath, maxBytes: 200000 });
    if (!result?.ok) {
      setStatus(result?.error || "Could not attach that file.", "error");
      return;
    }
    assistantAttachments.push({
      name: result.name || filePath.split(/[\\/]/).pop() || "attachment",
      path: result.path || filePath,
      size: Number(result.size || 0),
      text: String(result.text || ""),
    });
    renderAssistantAttachments();
    setStatus(`Attached ${result.name || "file"} as ArcBot context.`);
  } catch (err) {
    setStatus(String(err?.message || err || "Could not attach file."), "error");
  }
}

function getActiveTabPreviewContext() {
  const activeTab = shell.state?.tabs?.find?.((tab) => tab.id === shell.state.activeId) || null;
  return {
    available: !!activeTab && activeTab.type !== "home",
    tabId: activeTab?.id || "",
    tabType: activeTab?.type || "home",
    title: activeTab?.title || "Home",
    targetPath: "",
    fileState: "",
  };
}

function getAppContextTooltipRows(context) {
  if (!assistantAppContextEnabled) {
    return [
      { text: "App Context Off", strong: true },
      { text: "ArcBot will not receive active page, tab, file, or notebook contents." },
    ];
  }
  const ctx = context && typeof context === "object" ? context : getActiveTabPreviewContext();
  const title = String(ctx.title || "Home");
  const type = String(ctx.tabType || ctx.pageType || "home");
  const path = String(ctx.targetPath || ctx.path || "").trim();
  const state = String(ctx.fileState || (ctx.dirty ? "unsaved-changes" : "") || "").trim();
  if (typeof assistantConfig.getAppContextTooltipRows === "function") {
    const rows = assistantConfig.getAppContextTooltipRows(ctx, { title, type, path, state });
    if (Array.isArray(rows) && rows.length) return rows.filter(Boolean);
  }
  return [
    { text: "App Context", strong: true },
    { label: "Tab", value: `${title} (${type})` },
    { label: "File", value: path || "no active file" },
    state ? { label: "State", value: state } : null,
  ].filter(Boolean);
}

function formatAppContextTooltip(context) {
  return getAppContextTooltipRows(context).map((row) => (
    row.text || `${row.label}: ${row.value}`
  )).join("\n");
}

function renderAppContextTooltip(tooltip, context) {
  if (!tooltip) return;
  const rows = getAppContextTooltipRows(context);
  tooltip.textContent = "";
  tooltip.setAttribute("aria-label", rows.map((row) => row.text || `${row.label}: ${row.value}`).join("\n"));
  rows.forEach((row) => {
    const line = document.createElement("div");
    line.className = "aiAssistantAppContextTooltipLine";
    if (row.text) {
      line.textContent = row.text;
      if (row.strong) line.classList.add("aiAssistantAppContextTooltipTitle");
    } else {
      const label = document.createElement("span");
      label.className = "aiAssistantAppContextTooltipLabel";
      label.textContent = `${row.label}: `;
      const value = document.createElement("span");
      value.className = "aiAssistantAppContextTooltipValue";
      value.textContent = row.value;
      line.append(label, value);
    }
    tooltip.appendChild(line);
  });
}

async function refreshAppContextTooltip({ probe = false } = {}) {
  const tooltip = $("aiAssistantAppContextTooltip");
  const button = $("aiAssistantAppContextBtn");
  if (!tooltip && !button) return;
  let context = getActiveTabPreviewContext();
  if (probe && assistantAppContextEnabled) {
    try {
      context = await requestActivePageContext();
    } catch {
      // Keep shell-level preview when iframe context is unavailable.
    }
  }
  renderAppContextTooltip(tooltip, context);
  button?.removeAttribute("title");
}

function setAssistantContextPanelOpen(open) {
  const panel = $("aiAssistantContextPanel");
  panel?.classList.toggle("open", !!open);
  updateContextPanel();
}

function setAssistantAppContextEnabled(enabled) {
  assistantAppContextEnabled = !!enabled;
  const button = $("aiAssistantAppContextBtn");
  button?.classList.toggle("active", assistantAppContextEnabled);
  button?.setAttribute("aria-pressed", assistantAppContextEnabled ? "true" : "false");
  button?.setAttribute("aria-label", assistantAppContextEnabled ? "App Context on" : "App Context off");
  if (!assistantAppContextEnabled) {
    currentContext = {
      available: false,
      tabType: "off",
      title: "App Context Off",
      targetPath: "",
      fileState: "disabled",
    };
    setAssistantContextPanelOpen(false);
  }
  updateContextPanel();
  refreshAppContextTooltip({ probe: assistantAppContextEnabled });
}

function updateSessionSelectLabel() {
  updateContextPanel();
}

async function refreshSessionList(selectedId = currentSessionId) {
  const host = getHostApi();
  if (!host?.codexAssistantListSessions) return [];
  try {
    const result = await host.codexAssistantListSessions({ includeArchived: false });
    const sessions = result?.ok && Array.isArray(result.sessions) ? result.sessions : [];
    latestSessionList = sessions;
    return sessions;
  } catch {
    return [];
  }
}

async function loadAssistantSession(sessionId) {
  const host = getHostApi();
  if (!host?.codexAssistantLoadSession || !sessionId) return false;
  const result = await host.codexAssistantLoadSession(sessionId);
  if (!result?.ok || !result.session) return false;
  const session = result.session;
  currentSessionId = session.id || "";
  currentSessionTitle = session.title || "ArcBot Chat";
  assistantMode = normalizeAssistantMode(session.mode);
  assistantModel = normalizeAssistantModel(session.model);
  assistantReasoningEffort = normalizeAssistantReasoningEffort(session.reasoningEffort);
  assistantMessages = normalizeMessages(session.messages);
  assistantActivities = normalizeActivities(session.activities);
  resetAssistantActivityTyping();
  assistantDebugLogs = normalizeDebugLogs(session.debugLogs);
  currentContext = session.context || null;
  currentUsage = session.usage || null;
  setAssistantMode(assistantMode, { save: false });
  renderMessages();
  renderActivities();
  updateAssistantSettingsPanel();
  renderDebugLog();
  await refreshSessionList(currentSessionId);
  updateSessionSelectLabel();
  return true;
}

async function createAssistantSession() {
  const host = getHostApi();
  if (!host?.codexAssistantCreateSession) return false;
  const result = await host.codexAssistantCreateSession({
    mode: assistantMode,
    model: assistantModel,
    reasoningEffort: assistantReasoningEffort,
  });
  if (!result?.ok || !result.session) return false;
  currentSessionId = result.session.id;
  currentSessionTitle = result.session.title || "New ArcBot Chat";
  assistantModel = normalizeAssistantModel(result.session.model);
  assistantReasoningEffort = normalizeAssistantReasoningEffort(result.session.reasoningEffort);
  assistantMessages = [];
  assistantActivities = [];
  resetAssistantActivityTyping();
  assistantDebugLogs = [];
  currentContext = null;
  currentUsage = null;
  refreshAppContextTooltip();
  renderMessages();
  renderActivities();
  updateAssistantSettingsPanel();
  renderDebugLog();
  await refreshSessionList(currentSessionId);
  updateSessionSelectLabel();
  return true;
}

function findEmptyAssistantSession(sessions) {
  return (Array.isArray(sessions) ? sessions : []).find((session) => (
    session?.id &&
    session.archived !== true &&
    Number(session.messageCount || 0) === 0
  )) || null;
}

async function openOrCreateEmptyAssistantSession() {
  const sessions = await refreshSessionList(currentSessionId);
  const emptySession = findEmptyAssistantSession(sessions);
  if (emptySession) {
    if (emptySession.id !== currentSessionId) {
      await loadAssistantSession(emptySession.id);
      return { ok: true, created: false, alreadyCurrent: false };
    }
    renderMessages();
    renderActivities();
    updateSessionSelectLabel();
    return { ok: true, created: false, alreadyCurrent: true };
  }
  const created = await createAssistantSession();
  return { ok: created, created: true, alreadyCurrent: false };
}

async function ensureAssistantSession() {
  const sessions = await refreshSessionList();
  if (sessions.length && await loadAssistantSession(sessions[0].id)) return;
  await createAssistantSession();
}

function formatSessionDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getAssistantHistoryIcon(action) {
  if (action === "archive") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M6 7v12h12V7"></path><path d="M9 11h6"></path></svg>';
  }
  if (action === "restore") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M6 7v12h12V7"></path><path d="M12 16V10"></path><path d="M9 13l3-3 3 3"></path></svg>';
  }
  if (action === "delete") {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"></path><path d="M9 7V5h6v2"></path><path d="M8 10l1 9h6l1-9"></path><path d="M10.5 12.5v4"></path><path d="M13.5 12.5v4"></path></svg>';
  }
  return "";
}

function createAssistantHistoryIconButton(action, label, onClick) {
  const button = document.createElement("button");
  button.className = `aiAssistantHistoryIconBtn${action === "delete" ? " danger" : ""}`;
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = getAssistantHistoryIcon(action);
  button.addEventListener("click", onClick);
  return button;
}

async function refreshHistoryPage() {
  const host = getHostApi();
  const list = $("aiAssistantHistoryList");
  if (!host?.codexAssistantListSessions || !list) return;
  list.textContent = "";
  const result = await host.codexAssistantListSessions({ includeArchived: true });
  const sessions = result?.ok && Array.isArray(result.sessions) ? result.sessions : [];
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "aiAssistantHistoryEmpty";
    empty.textContent = "No chat sessions yet.";
    list.appendChild(empty);
    return;
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `aiAssistantHistoryRow${session.archived ? " archived" : ""}`;
    const info = document.createElement("div");
    info.className = "aiAssistantHistoryInfo";
    info.tabIndex = 0;
    info.setAttribute("role", "button");
    info.setAttribute("aria-label", `Open ${session.title || "ArcBot Chat"}`);
    const name = document.createElement("div");
    name.className = "aiAssistantHistoryName";
    name.textContent = session.title || "ArcBot Chat";
    name.title = session.title || "ArcBot Chat";
    const meta = document.createElement("div");
    meta.className = "aiAssistantHistoryMeta";
    const updated = formatSessionDate(session.updatedAt);
    meta.textContent = `${session.messageCount || 0} messages${updated ? ` - ${updated}` : ""}${session.archived ? " - Archived" : ""}`;
    info.append(name, meta);
    const openSession = async () => {
      if (session.archived && host.codexAssistantArchiveSession) {
        await host.codexAssistantArchiveSession(session.id, false);
      }
      await loadAssistantSession(session.id);
      await closeHistoryPage();
    };
    info.addEventListener("click", openSession);
    info.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      await openSession();
    });

    const actions = document.createElement("div");
    actions.className = "aiAssistantHistoryActions";
    const archiveBtn = createAssistantHistoryIconButton(session.archived ? "restore" : "archive", session.archived ? "Restore chat" : "Archive chat", async () => {
      if (!host.codexAssistantArchiveSession) return;
      await host.codexAssistantArchiveSession(session.id, !session.archived);
      if (session.id === currentSessionId && !session.archived) {
        await createAssistantSession();
      }
      await refreshSessionList(currentSessionId);
      await refreshHistoryPage();
    });
    const deleteBtn = createAssistantHistoryIconButton("delete", "Delete chat", async () => {
      if (!host.codexAssistantDeleteSession) return;
      const confirmed = window.confirm(`Delete this ArcBot chat session?\n\n${session.title || "ArcBot Chat"}`);
      if (!confirmed) return;
      await host.codexAssistantDeleteSession(session.id);
      if (session.id === currentSessionId) {
        await createAssistantSession();
      }
      await refreshSessionList(currentSessionId);
      await refreshHistoryPage();
    });
    actions.append(archiveBtn, deleteBtn);
    row.append(info, actions);
    list.appendChild(row);
  }
}

async function openHistoryPage() {
  const panel = $("aiAssistantPanel");
  closeAssistantSettingsPanel();
  panel?.classList.add("history-open");
  $("aiAssistantHistoryPage")?.classList.add("open");
  $("aiAssistantHistoryBtn")?.setAttribute("aria-expanded", "true");
  await refreshHistoryPage();
}

async function closeHistoryPage() {
  const panel = $("aiAssistantPanel");
  panel?.classList.remove("history-open");
  $("aiAssistantHistoryPage")?.classList.remove("open");
  $("aiAssistantHistoryBtn")?.setAttribute("aria-expanded", "false");
  await refreshSessionList(currentSessionId);
}

export function isAiAssistantLauncherVisible() {
  try {
    return localStorage.getItem(ASSISTANT_LAUNCHER_VISIBLE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAiAssistantLauncherVisible(visible) {
  const show = !!visible;
  try {
    localStorage.setItem(ASSISTANT_LAUNCHER_VISIBLE_KEY, show ? "1" : "0");
  } catch {}
  const launcher = $("aiAssistantLauncher");
  const panel = $("aiAssistantPanel");
  if (launcher) launcher.style.display = show ? "" : "none";
  if (show && launcher) applyLauncherPosition(launcher, loadLauncherPosition(launcher));
  if (!show) {
    launcher?.classList.remove("assistant-open");
    panel?.classList.remove("open");
  } else if (panel?.classList.contains("open")) {
    launcher?.classList.add("assistant-open");
  }
  shell.updateViewMenuState?.();
  return show;
}

export function toggleAiAssistantLauncherVisible() {
  return setAiAssistantLauncherVisible(!isAiAssistantLauncherVisible());
}

function normalizeAssistantMode(mode) {
  const key = String(mode || "").trim().toLowerCase();
  if (key === "review" || key === "approve") return key;
  return "edit";
}

function getModeLabel() {
  if (assistantMode === "review") return "Read Only";
  if (assistantMode === "approve") return "Ask for Approval";
  return "Edit Automatically";
}

function setModeIcon() {
  const icon = $("aiAssistantModeIcon");
  if (!icon) return;
  icon.innerHTML = assistantMode === "review"
    ? '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"></path><circle cx="12" cy="12" r="3"></circle>'
    : '<path d="M18 11V7a2 2 0 0 0-4 0v3"></path><path d="M14 10V6a2 2 0 0 0-4 0v7"></path><path d="M10 13V8a2 2 0 1 0-4 0v6"></path><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-16 0"></path>';
}

function setAssistantMode(mode, options = {}) {
  assistantMode = normalizeAssistantMode(mode);
  setText($("aiAssistantModeLabel"), getModeLabel());
  setModeIcon();
  $("aiAssistantReviewModeOption")?.classList.toggle("active", assistantMode === "review");
  $("aiAssistantApprovalModeOption")?.classList.toggle("active", assistantMode === "approve");
  $("aiAssistantEditModeOption")?.classList.toggle("active", assistantMode === "edit");
  setStatus(assistantReady ? `${isClaudeModel() ? getAssistantModelLabel() : "Codex"} ready. ${getModeLabel()}.` : `${getModeLabel()} selected.`);
  updateAssistantSettingsPanel();
  if (!assistantMessages.length) renderMessages();
  if (options.save !== false) saveCurrentSession();
}

function setComposerEnabled(enabled) {
  const input = $("aiAssistantInput");
  const sendBtn = $("aiAssistantSendBtn");
  if (input) input.disabled = false;
  if (sendBtn) {
    const isCancel = !!assistantBusy && !!currentRequestId;
    sendBtn.disabled = !isCancel && !enabled;
    sendBtn.classList.toggle("cancel", isCancel);
    sendBtn.classList.toggle("canceling", isCancel && assistantCancelRequested);
    sendBtn.setAttribute("aria-label", isCancel ? "Cancel request" : "Send");
    sendBtn.title = isCancel ? "Cancel request" : "Send";
  }
  updateAssistantSettingsPanel();
}

function autoGrowAssistantInput() {
  const input = $("aiAssistantInput");
  if (!input) return;
  input.style.height = "auto";
  const nextHeight = Math.min(300, Math.max(38, input.scrollHeight));
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > 300 ? "auto" : "hidden";
}

async function loadAssistantUserAvatarName() {
  const host = getHostApi();
  if (!host?.getWindowsUserName) return;
  try {
    const userName = String(await host.getWindowsUserName() || "").trim();
    if (!userName) return;
    assistantUserAvatarName = userName;
    document.querySelectorAll(".aiAssistantAvatarUser").forEach((avatar) => {
      avatar.innerHTML = createAssistantUserAvatarSvg(assistantUserAvatarName);
    });
    updateAssistantSettingsPanel();
  } catch {
    // Keep the default initial avatar if the host name is unavailable.
  }
}

function getMessageAvatar(role) {
  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "aiAssistantAvatar aiAssistantAvatarArcBot";
    avatar.setAttribute("aria-hidden", "true");
    const img = document.createElement("img");
    img.className = "arcbot-mini-img";
    img.src = "/icons/ArcBot%20mini.png";
    img.alt = "";
    img.draggable = false;
    avatar.appendChild(img);
    return avatar;
  }
  const avatar = document.createElement("div");
  avatar.className = "aiAssistantAvatar aiAssistantAvatarUser";
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = createAssistantUserAvatarSvg(assistantUserAvatarName);
  return avatar;
}

async function typeAssistantMessage(el, text) {
  return typeAssistantMessageContent(el, text, { scrollToBottom: scrollMessagesToBottom });
}

function appendMessage(role, text) {
  const container = $("aiAssistantMessages");
  if (!container) return null;
  const normalizedRole = role === "assistant" ? "assistant" : "user";
  const el = document.createElement("div");
  el.className = `aiAssistantMessage ${normalizedRole}`;
  renderAssistantMessageContent(el, normalizedRole, text);
  const row = document.createElement("div");
  row.className = `aiAssistantMessageRow ${normalizedRole}`;
  row.append(getMessageAvatar(normalizedRole), el);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
  return el;
}

async function resolveAssistantPendingMessage(el, text, { animate = false } = {}) {
  if (!el) return;
  el.classList.remove("thinking");
  if (animate) {
    await typeAssistantMessage(el, text);
  } else {
    renderAssistantMessageContent(el, "assistant", text);
    el.classList.remove("typing");
  }
}

function scrollMessagesToBottom() {
  const container = $("aiAssistantMessages");
  if (container) container.scrollTop = container.scrollHeight;
}

function applyStatus(status) {
  const usingClaude = isClaudeModel();
  assistantAuthStatus = String(status?.authStatus || status?.error || "").trim();
  if (usingClaude) {
    assistantReady = !!status?.claudeAuthenticated;
    if (!assistantReady) {
      setStatus("Claude is not signed in.", "error");
      setSetup({
        open: true,
        install: false,
        login: true,
        text: "Sign in to link this computer to your Claude account.",
      });
      setComposerEnabled(false);
      return;
    }
    setStatus(`${getAssistantModelLabel()} ready. ${getModeLabel()}.`);
    setSetup({ open: false });
    setComposerEnabled(!assistantBusy);
    updateAssistantSettingsPanel();
    return;
  }
  assistantReady = !!status?.installed && !!status?.authenticated;
  if (!status?.installed) {
    if (assistantInstallJustSucceeded) {
      setStatus(`Codex CLI installed, but ${assistantConfig.appName} cannot find it yet.`, "error");
      setSetup({
        open: true,
        install: false,
        login: false,
        text: `Restart ${assistantConfig.appName}, then refresh ArcBot status so the updated npm command path is picked up.`,
      });
      setComposerEnabled(false);
      return;
    }
    setStatus("Codex CLI is not installed.", "error");
    setSetup({
      open: true,
      install: true,
      login: false,
      text: "Install will run: npm install -g @openai/codex.",
    });
    setComposerEnabled(false);
    return;
  }
  assistantInstallJustSucceeded = false;
  if (!status?.authenticated) {
    setStatus("Codex CLI is installed but not signed in.", "error");
    setSetup({
      open: true,
      install: false,
      login: true,
      text: "Sign in to link this computer to your Codex account.",
    });
    setComposerEnabled(false);
    return;
  }
  setStatus(`Codex ready (${status.version || "installed"}). ${getModeLabel()}.`);
  setSetup({ open: false });
  setComposerEnabled(!assistantBusy);
  updateAssistantSettingsPanel();
}

function requestActivePageContext() {
  const activeTab = shell.state?.tabs?.find?.((tab) => tab.id === shell.state.activeId) || null;
  const baseContext = {
    available: false,
    tabId: activeTab?.id || "",
    tabType: activeTab?.type || "home",
    title: activeTab?.title || "",
  };
  const iframe = activeTab?.iframe || null;
  if (!iframe?.contentWindow) return Promise.resolve(baseContext);

  return new Promise((resolve) => {
    const requestId = `arcbot_context_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve({ ...baseContext, ...(value || {}), available: !!value?.available });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data || {};
      if (msg.type !== assistantMessageType("context-result") || msg.requestId !== requestId) return;
      finish(msg.context || {});
    };
    window.addEventListener("message", onMessage);
    try {
      iframe.contentWindow.postMessage({ type: assistantMessageType("context-request"), requestId }, "*");
    } catch {
      finish(baseContext);
      return;
    }
    const timeoutMs = activeTab?.type === "project_instance"
      ? Number(assistantConfig.projectInstanceContextTimeoutMs || assistantConfig.contextTimeoutMs || 900)
      : Number(assistantConfig.contextTimeoutMs || 900);
    setTimeout(() => finish(baseContext), Math.max(1, timeoutMs));
  });
}

function notifyActivePageJsonUpdated(result) {
  const activeTab = shell.state?.tabs?.find?.((tab) => tab.id === shell.state.activeId) || null;
  const iframe = activeTab?.iframe || null;
  if (!iframe?.contentWindow) return;
  try {
    iframe.contentWindow.postMessage({
      type: assistantMessageType("json-updated"),
      path: result?.targetPath || "",
    }, "*");
  } catch {
    // ignore stale iframe messaging
  }
}

function requestActiveDfmEditApproval(result) {
  const activeTab = shell.state?.tabs?.find?.((tab) => tab.id === shell.state.activeId) || null;
  const iframe = activeTab?.iframe || null;
  if (!iframe?.contentWindow) {
    return Promise.resolve({ ok: false, error: "No active DFM tab is available for approval." });
  }
  return new Promise((resolve) => {
    const requestId = `arcbot_dfm_approval_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(payload || { ok: false, error: "DFM approval did not return a result." });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data || {};
      if (msg.type !== assistantMessageType("dfm-edit-approval-result") || msg.requestId !== requestId) return;
      finish(msg);
    };
    window.addEventListener("message", onMessage);
    try {
      iframe.contentWindow.postMessage({
        type: assistantMessageType("dfm-edit-approval"),
        requestId,
        targetPath: result?.targetPath || "",
        originalJson: result?.originalJson || null,
        proposedJson: result?.proposedJson || null,
        reply: result?.text || "",
      }, "*");
    } catch (err) {
      finish({ ok: false, error: String(err?.message || err || "Could not open DFM approval review.") });
      return;
    }
    window.setTimeout(() => finish({ ok: false, error: "Timed out waiting for DFM edit approval." }), 120000);
  });
}

async function refreshAssistantStatus() {
  const host = getHostApi();
  if (!host?.codexAssistantStatus) {
    setStatus("ArcBot is available in the desktop app only.", "error");
    setSetup({ open: false });
    setComposerEnabled(false);
    return;
  }
  assistantStatusChecked = true;
  setStatus(isClaudeModel() ? "Checking Claude credentials..." : "Checking Codex CLI...");
  setComposerEnabled(false);
  try {
    const status = await host.codexAssistantStatus();
    applyStatus(status);
  } catch (err) {
    assistantReady = false;
    setStatus(getHostErrorMessage(err, "Codex status check failed."), "error");
    setComposerEnabled(false);
  }
}

function openAssistant() {
  const panel = $("aiAssistantPanel");
  applyFirstSessionOpenPanelSize(panel);
  $("aiAssistantLauncher")?.classList.add("assistant-open");
  panel?.classList.add("open");
  closeAssistantSettingsPanel();
  refreshAppContextTooltip();
  if (!assistantStatusChecked) refreshAssistantStatus();
  setTimeout(() => $("aiAssistantInput")?.focus(), 0);
}

function closeAssistant() {
  if (isAiAssistantLauncherVisible()) $("aiAssistantLauncher")?.classList.remove("assistant-open");
  $("aiAssistantPanel")?.classList.remove("open");
  closeAssistantSettingsPanel();
}

function closeModeMenu() {
  const button = $("aiAssistantModeButton");
  $("aiAssistantModeMenu")?.classList.remove("open");
  button?.setAttribute("aria-expanded", "false");
}

function closeSelectMenus() {
  closeModeMenu();
}

function toggleModeMenu(forceOpen) {
  const button = $("aiAssistantModeButton");
  const menu = $("aiAssistantModeMenu");
  if (!button || !menu) return;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !menu.classList.contains("open");
  menu.classList.toggle("open", shouldOpen);
  button.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

function getLauncherDefaultPosition(launcher) {
  const rect = launcher.getBoundingClientRect();
  const width = rect.width || 42;
  const height = rect.height || 42;
  const statusbarHeight = Number(shell.getStatusBarHeight?.() || 0);
  return {
    left: window.innerWidth - width - 18,
    top: window.innerHeight - statusbarHeight - height - 18,
  };
}

function readLauncherPosition() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSISTANT_LAUNCHER_POSITION_KEY) || "null");
    if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed;
  } catch {}
  return null;
}

function loadLauncherPosition(launcher) {
  const parsed = readLauncherPosition();
  if (parsed) return adaptLauncherPositionToWindow(launcher, parsed);
  return getLauncherDefaultPosition(launcher);
}

function saveLauncherPosition(launcher, left, top) {
  const tucked = getLauncherTuckedEdges(launcher, left, top);
  const anchor = getLauncherResizeAnchor(launcher, left, top, tucked);
  const payload = {
    left: Math.round(left),
    top: Math.round(top),
    tuckedX: tucked.x,
    tuckedY: tucked.y,
  };
  if (anchor) {
    payload.anchorCornerX = anchor.cornerX;
    payload.anchorCornerY = anchor.cornerY;
    payload.anchorOffsetX = anchor.offsetX;
    payload.anchorOffsetY = anchor.offsetY;
  }
  try {
    localStorage.setItem(ASSISTANT_LAUNCHER_POSITION_KEY, JSON.stringify(payload));
  } catch {}
}

function getLauncherMetrics(launcher) {
  const rect = launcher.getBoundingClientRect();
  const width = rect.width || 42;
  const height = rect.height || 42;
  const statusbarHeight = Number(shell.getStatusBarHeight?.() || 0);
  return {
    width,
    height,
    halfWidth: Math.round(width / 2),
    halfHeight: Math.round(height / 2),
    viewportWidth: Math.max(0, window.innerWidth),
    viewportHeight: Math.max(0, window.innerHeight - statusbarHeight),
  };
}

function getLauncherTuckedEdges(launcher, left, top) {
  const metrics = getLauncherMetrics(launcher);
  return {
    x: left < 0 ? "left" : (left + metrics.width > metrics.viewportWidth ? "right" : ""),
    y: top < 0 ? "top" : (top + metrics.height > metrics.viewportHeight ? "bottom" : ""),
  };
}

function getLauncherResizeAnchor(launcher, left, top, tucked) {
  if (!tucked?.x && !tucked?.y) return null;
  const metrics = getLauncherMetrics(launcher);
  const centerX = left + metrics.halfWidth;
  const centerY = top + metrics.halfHeight;
  const cornerX = tucked.x || (centerX <= metrics.viewportWidth / 2 ? "left" : "right");
  const cornerY = tucked.y || (centerY <= metrics.viewportHeight / 2 ? "top" : "bottom");
  return {
    cornerX,
    cornerY,
    offsetX: Math.round(Math.max(0, cornerX === "right" ? metrics.viewportWidth - centerX : centerX)),
    offsetY: Math.round(Math.max(0, cornerY === "bottom" ? metrics.viewportHeight - centerY : centerY)),
  };
}

function adaptLauncherPositionToWindow(launcher, position) {
  const metrics = getLauncherMetrics(launcher);
  let left = Number(position?.left || 0);
  let top = Number(position?.top || 0);
  const hasAnchor = ["left", "right"].includes(position?.anchorCornerX)
    && ["top", "bottom"].includes(position?.anchorCornerY)
    && Number.isFinite(position?.anchorOffsetX)
    && Number.isFinite(position?.anchorOffsetY);
  if (hasAnchor && (position?.tuckedX || position?.tuckedY)) {
    let centerX = position.anchorCornerX === "right"
      ? metrics.viewportWidth - Math.max(0, Number(position.anchorOffsetX))
      : Math.max(0, Number(position.anchorOffsetX));
    let centerY = position.anchorCornerY === "bottom"
      ? metrics.viewportHeight - Math.max(0, Number(position.anchorOffsetY))
      : Math.max(0, Number(position.anchorOffsetY));
    if (position.tuckedX === "left") centerX = 0;
    else if (position.tuckedX === "right") centerX = metrics.viewportWidth;
    if (position.tuckedY === "top") centerY = 0;
    else if (position.tuckedY === "bottom") centerY = metrics.viewportHeight;
    left = centerX - metrics.halfWidth;
    top = centerY - metrics.halfHeight;
  } else {
    if (position?.tuckedX === "left") left = -metrics.halfWidth;
    else if (position?.tuckedX === "right") left = metrics.viewportWidth - metrics.halfWidth;
    if (position?.tuckedY === "top") top = -metrics.halfHeight;
    else if (position?.tuckedY === "bottom") top = metrics.viewportHeight - metrics.halfHeight;
  }
  return { left, top };
}

function clampLauncherPosition(launcher, left, top, options = {}) {
  const { snap = true } = options;
  const metrics = getLauncherMetrics(launcher);
  const fullMaxLeft = Math.max(0, metrics.viewportWidth - metrics.width);
  const fullMaxTop = Math.max(0, metrics.viewportHeight - metrics.height);
  let nextLeft = Math.min(Math.max(left, -metrics.halfWidth), metrics.viewportWidth - metrics.halfWidth);
  let nextTop = Math.min(Math.max(top, -metrics.halfHeight), metrics.viewportHeight - metrics.halfHeight);
  if (snap) {
    if (nextLeft < 0) nextLeft = -metrics.halfWidth;
    else if (nextLeft > fullMaxLeft) nextLeft = metrics.viewportWidth - metrics.halfWidth;
    if (nextTop < 0) nextTop = -metrics.halfHeight;
    else if (nextTop > fullMaxTop) nextTop = metrics.viewportHeight - metrics.halfHeight;
  }
  return {
    left: nextLeft,
    top: nextTop,
  };
}

function updateLauncherTuckedState(launcher, left, top) {
  const tucked = getLauncherTuckedEdges(launcher, left, top);
  const nearLeft = tucked.x === "left";
  const nearRight = tucked.x === "right";
  const nearTop = tucked.y === "top";
  const nearBottom = tucked.y === "bottom";
  launcher.classList.toggle("tucked", nearLeft || nearRight || nearTop || nearBottom);
  launcher.classList.toggle("tucked-left", nearLeft);
  launcher.classList.toggle("tucked-right", nearRight);
  launcher.classList.toggle("tucked-top", nearTop);
  launcher.classList.toggle("tucked-bottom", nearBottom);
}

function applyLauncherPosition(launcher, position, options = {}) {
  const next = clampLauncherPosition(launcher, Number(position?.left || 0), Number(position?.top || 0), options);
  launcher.style.left = `${Math.round(next.left)}px`;
  launcher.style.top = `${Math.round(next.top)}px`;
  launcher.style.right = "auto";
  launcher.style.bottom = "auto";
  updateLauncherTuckedState(launcher, next.left, next.top);
  return next;
}

function initAssistantLauncherDrag(launcher) {
  let dragState = null;
  launcher.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = launcher.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    try { launcher.setPointerCapture(event.pointerId); } catch {}
  });

  launcher.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
    dragState.moved = true;
    launcher.classList.add("dragging");
    applyLauncherPosition(launcher, {
      left: dragState.left + dx,
      top: dragState.top + dy,
    }, { snap: false });
    event.preventDefault();
  });

  const endDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    try { launcher.releasePointerCapture(event.pointerId); } catch {}
    launcher.classList.remove("dragging");
    if (dragState.moved) {
      const rect = launcher.getBoundingClientRect();
      const next = applyLauncherPosition(launcher, { left: rect.left, top: rect.top });
      saveLauncherPosition(launcher, next.left, next.top);
      suppressLauncherClick = true;
      setTimeout(() => { suppressLauncherClick = false; }, 150);
    }
    dragState = null;
  };

  launcher.addEventListener("pointerup", endDrag);
  launcher.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", () => {
    if (!isAiAssistantLauncherVisible()) return;
    const next = applyLauncherPosition(launcher, loadLauncherPosition(launcher));
    saveLauncherPosition(launcher, next.left, next.top);
  });
}

function clampPanelPosition(panel, left, top) {
  const margin = 8;
  const rect = panel.getBoundingClientRect();
  const width = rect.width || 420;
  const height = rect.height || 420;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
  };
}

function readPanelSize() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSISTANT_PANEL_SIZE_KEY) || "null");
    if (parsed && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) return parsed;
  } catch {}
  return null;
}

function savePanelSize(panel) {
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  try {
    localStorage.setItem(ASSISTANT_PANEL_SIZE_KEY, JSON.stringify({
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }));
  } catch {}
}

function hasOpenedPanelThisSession() {
  try {
    return sessionStorage.getItem(ASSISTANT_PANEL_OPENED_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markPanelOpenedThisSession() {
  try {
    sessionStorage.setItem(ASSISTANT_PANEL_OPENED_SESSION_KEY, "1");
  } catch {}
}

function clampPanelSize(width, height) {
  const statusbarHeight = Number(shell.getStatusBarHeight?.() || 0);
  const maxWidth = Math.max(ASSISTANT_PANEL_MIN_WIDTH, window.innerWidth - 16);
  const maxHeight = Math.max(340, window.innerHeight - statusbarHeight - 16);
  return clampAssistantPanelSize(width, height, {
    minWidth: ASSISTANT_PANEL_MIN_WIDTH,
    minHeight: 340,
    maxWidth,
    maxHeight,
    fallbackWidth: ASSISTANT_PANEL_MIN_WIDTH,
    fallbackHeight: ASSISTANT_PANEL_DEFAULT_HEIGHT,
  });
}

function applyPanelSize(panel, size = readPanelSize()) {
  if (!panel || !size) return;
  const next = clampPanelSize(size.width, size.height);
  panel.style.width = `${Math.round(next.width)}px`;
  panel.style.height = `${Math.round(next.height)}px`;
}

function applyFirstSessionOpenPanelSize(panel) {
  if (!panel || hasOpenedPanelThisSession()) return;
  const saved = readPanelSize();
  const rect = panel.getBoundingClientRect();
  applyPanelSize(panel, {
    width: ASSISTANT_PANEL_MIN_WIDTH,
    height: saved?.height || rect.height || ASSISTANT_PANEL_DEFAULT_HEIGHT,
  });
  markPanelOpenedThisSession();
}

function applyPanelPosition(panel, left, top) {
  const next = clampPanelPosition(panel, left, top);
  panel.style.left = `${Math.round(next.left)}px`;
  panel.style.top = `${Math.round(next.top)}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function initAssistantResize(panel) {
  const handles = Array.from(document.querySelectorAll(".aiAssistantResizeHandle"));
  if (!handles.length) return;
  applyPanelSize(panel);
  let resizeState = null;

  const startResize = (event) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const rect = panel.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      edge: String(handle?.dataset?.resizeEdge || "se"),
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    try { handle.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  };

  const moveResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const dx = event.clientX - resizeState.startX;
    const dy = event.clientY - resizeState.startY;
    const edge = resizeState.edge;
    let width = resizeState.width;
    let height = resizeState.height;
    let left = resizeState.left;
    let top = resizeState.top;
    if (edge.includes("e")) width = resizeState.width + dx;
    if (edge.includes("w")) width = resizeState.width - dx;
    if (edge.includes("s")) height = resizeState.height + dy;
    if (edge.includes("n")) height = resizeState.height - dy;
    const next = clampPanelSize(width, height);
    if (edge.includes("w")) left = resizeState.left + resizeState.width - next.width;
    if (edge.includes("n")) top = resizeState.top + resizeState.height - next.height;
    applyPanelSize(panel, next);
    applyPanelPosition(panel, left, top);
  };

  const stopResize = (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch {}
    savePanelSize(panel);
    resizeState = null;
  };

  handles.forEach((handle) => {
    handle.addEventListener("pointerdown", startResize);
    handle.addEventListener("pointermove", moveResize);
    handle.addEventListener("pointerup", stopResize);
    handle.addEventListener("pointercancel", stopResize);
  });
}

function initAssistantDrag(panel) {
  const header = $("aiAssistantHeader");
  if (!header) return;
  let dragState = null;

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.("button")) return;
    const rect = panel.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    try { header.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  });

  header.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    applyPanelPosition(panel, event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  });

  const stopDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    try { header.releasePointerCapture(event.pointerId); } catch {}
    dragState = null;
  };

  header.addEventListener("pointerup", stopDrag);
  header.addEventListener("pointercancel", stopDrag);
  window.addEventListener("resize", () => {
    if (!panel.classList.contains("open")) return;
    const rect = panel.getBoundingClientRect();
    applyPanelPosition(panel, rect.left, rect.top);
  });
}

async function installCodexCli() {
  const host = getHostApi();
  if (!host?.codexAssistantInstall) return;
  assistantInstallJustSucceeded = false;
  const confirmed = window.confirm(
    `Install Codex CLI now?\n\n${assistantConfig.appName} will run: npm install -g @openai/codex`
  );
  if (!confirmed) return;
  assistantBusy = true;
  setStatus("Installing Codex CLI...");
  setSetup({ open: false });
  setComposerEnabled(false);
  try {
    const result = await host.codexAssistantInstall();
    if (!result?.ok) {
      setStatus(result?.error || "Codex CLI installation failed.", "error");
      setSetup({
        open: true,
        install: true,
        login: false,
        text: "Install will run: npm install -g @openai/codex.",
      });
      return;
    }
    shell.updateStatusBar?.("Codex CLI installed.");
    assistantInstallJustSucceeded = true;
    await refreshAssistantStatus();
  } catch (err) {
    setStatus(String(err?.message || err || "Codex CLI installation failed."), "error");
  } finally {
    assistantBusy = false;
    setComposerEnabled(assistantReady);
  }
}

async function loginCodexCli() {
  const host = getHostApi();
  if (!host?.codexAssistantLogin) return;
  const usingClaude = isClaudeModel();
  const confirmed = window.confirm(
    usingClaude
      ? "Open Claude sign-in now?\n\nA terminal window will run: claude login"
      : "Open Codex sign-in now?\n\nA terminal window will run: codex login"
  );
  if (!confirmed) return;
  try {
    const result = await host.codexAssistantLogin(usingClaude ? { provider: "anthropic" } : undefined);
    if (!result?.ok) {
      setStatus(result?.error || `Could not start ${usingClaude ? "Claude" : "Codex"} sign-in.`, "error");
      return;
    }
    setStatus(`Complete ${usingClaude ? "Claude" : "Codex"} sign-in, then refresh status.`);
  } catch (err) {
    setStatus(String(err?.message || err || `Could not start ${usingClaude ? "Claude" : "Codex"} sign-in.`), "error");
  }
}

async function cancelAssistantMessage() {
  if (!assistantBusy || !currentRequestId || assistantCancelRequested) return;
  const host = getHostApi();
  assistantCancelRequested = true;
  setComposerEnabled(false);
  appendActivity("Cancel requested", "activity");
  setStatus("Canceling ArcBot request...");
  try {
    if (!host?.codexAssistantCancel) throw new Error("ArcBot cancel is not available.");
    const result = await host.codexAssistantCancel(currentRequestId);
    if (!result?.ok && assistantHostRequestSubmitted) {
      setStatus(result?.error || "Could not cancel ArcBot request.", "error");
    }
  } catch (err) {
    setStatus(String(err?.message || err || "Could not cancel ArcBot request."), "error");
  }
}

async function sendAssistantMessage() {
  if (assistantBusy) return;
  const host = getHostApi();
  const input = $("aiAssistantInput");
  const text = String(input?.value || "").trim();
  if ((!text && !assistantAttachments.length) || !host?.codexAssistantSend) return;
  if (!currentSessionId) await ensureAssistantSession();
  if (!assistantReady) {
    setStatus("Install Codex CLI or sign in before sending.", "error");
    return;
  }

  const userText = text || "Use the attached file context.";
  const requestAttachments = assistantAttachments.map((attachment) => ({ ...attachment }));
  const visibleText = requestAttachments.length
    ? `${userText}\n\nAttached: ${requestAttachments.map((item) => item.name).join(", ")}`
    : userText;
  assistantMessages.push({ role: "user", content: visibleText, timestamp: nowIso() });
  appendMessage("user", visibleText);
  currentSessionTitle = assistantMessages.find((message) => message.role === "user")?.content?.slice(0, 42) || currentSessionTitle;
  updateAssistantSettingsPanel();
  if (input) input.value = "";
  assistantAttachments = [];
  renderAssistantAttachments();
  autoGrowAssistantInput();
  currentRequestId = `arcbot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  currentRunStartedAt = performance.now();
  currentStepStartedAt = currentRunStartedAt;
  assistantProgressSteps = createAssistantProgressSteps();
  assistantWorkCardExpanded = true;
  startAssistantProgressTicker();
  assistantCancelRequested = false;
  assistantHostRequestSubmitted = false;
  assistantActivities = [];
  resetAssistantActivityTyping();
  assistantDebugLogs = [];
  renderActivities();
  renderDebugLog();
  appendActivity(`Reading your request: "${userText.slice(0, 90)}${userText.length > 90 ? "..." : ""}"`, "activity", { elapsedMs: 0 });
  const pending = appendMessage("assistant", "Thinking ...");
  pending?.classList.add("thinking");
  currentPendingMessageEl = pending;
  await saveCurrentSession();

  assistantBusy = true;
  setComposerEnabled(false);
  setStatus(assistantAppContextEnabled ? "ArcBot is checking the active page context..." : "ArcBot is responding without app context...");
  appendActivity(
    assistantAppContextEnabled ? "Looking for usable data in the active app tab." : "App Context is off, so Codex will not receive active app contents.",
    "activity",
    { save: false },
  );
  try {
    const activeContext = assistantAppContextEnabled
      ? await requestActivePageContext()
      : {
          available: false,
          disabled: true,
          tabType: "off",
          title: "App Context Off",
          targetPath: "",
        };
    const panelActiveTab = shell.state?.tabs?.find?.((tab) => tab.id === shell.state.activeId) || null;
    currentContext = normalizeAssistantContextForPanel(activeContext, panelActiveTab);
    updateContextPanel();
    appendActivity(
      activeContext?.available
        ? formatAssistantContextScanStatus(activeContext)
        : formatAssistantContextScanStatus(activeContext, "No active app tab data was available for this request."),
      "activity",
      { save: false },
    );
    if (assistantCancelRequested) {
      const message = "Request canceled.";
      resolveAssistantPendingMessage(pending, message);
      assistantMessages.push({ role: "assistant", content: message, timestamp: nowIso() });
      appendActivity("Request canceled", "activity");
      failAssistantProgress("Request canceled");
      setStatus("ArcBot request canceled.");
      return;
    }
    setStatus(`ArcBot is responding in ${getModeLabel()}...`);
    assistantHostRequestSubmitted = true;
    const result = await host.codexAssistantSend({
      requestId: currentRequestId,
      sessionId: currentSessionId,
      mode: assistantMode,
      model: assistantModel,
      reasoningEffort: assistantReasoningEffort,
      messages: assistantMessages,
      activeContext,
      attachments: requestAttachments,
    });
    currentUsage = result?.usage || currentUsage;
    updateContextPanel();
    if (assistantCancelRequested && result?.ok) {
      const message = "Request canceled.";
      resolveAssistantPendingMessage(pending, message);
      assistantMessages.push({ role: "assistant", content: message, timestamp: nowIso() });
      appendActivity("Request canceled", "activity");
      failAssistantProgress("Request canceled");
      setStatus("ArcBot request canceled.");
      return;
    }
    if (!result?.ok) {
      const wasCanceled = !!result?.canceled || assistantCancelRequested;
      const message = wasCanceled ? "Request canceled." : (result?.error || "ArcBot request failed.");
      resolveAssistantPendingMessage(pending, message);
      assistantMessages.push({ role: "assistant", content: message, timestamp: nowIso() });
      if (wasCanceled) {
        setStatus("ArcBot request canceled.");
        appendActivity("Request canceled", "activity");
        failAssistantProgress("Request canceled");
      } else if (result?.needsAuth) {
        assistantReady = false;
        const isClaudeProvider = isClaudeModel();
        setStatus(`${isClaudeProvider ? "Claude" : "Codex CLI"} needs sign-in.`, "error");
        setSetup({
          open: true,
          install: false,
          login: true,
          text: `Sign in to link this computer to your ${isClaudeProvider ? "Claude" : "Codex"} account.`,
        });
      } else {
        setStatus(message, "error");
        appendActivity("Request failed", "error");
        failAssistantProgress(message);
      }
      return;
    }
    let reply = String(result?.text || "").trim() || "No response.";
    let editApplied = !!result?.editApplied;
    let approvalFailed = false;
    if (result?.editPendingApproval) {
      if (assistantConfig.enableDfmApproval) {
        appendActivity("Opening DFM version compare for approval.", "activity");
        setStatus("Review the proposed DFM edit before accepting it...");
        const approval = await requestActiveDfmEditApproval(result);
        if (approval?.ok && approval.accepted) {
          editApplied = true;
          reply = approval.message || reply || "Applied the approved DFM edit.";
          appendActivity("Approved and applied DFM edit.", "activity");
        } else if (approval?.ok && approval.accepted === false) {
          editApplied = false;
          reply = approval.message || "DFM edit was rejected. No changes were applied.";
          appendActivity("Rejected DFM edit. No changes were applied.", "activity");
        } else {
          editApplied = false;
          approvalFailed = true;
          reply = approval?.error || "DFM edit approval failed. No changes were applied.";
          appendActivity("DFM edit approval failed.", "error");
        }
      } else {
        editApplied = true;
        appendActivity("Edit completed.", "activity");
      }
    }
    await resolveAssistantPendingMessage(pending, reply, { animate: true });
    assistantMessages.push({ role: "assistant", content: reply, timestamp: nowIso() });
    if (editApplied && result?.editApplied) notifyActivePageJsonUpdated(result);
    appendActivity(editApplied ? "Edit completed." : "Response completed.", "activity");
    completeAssistantProgress(editApplied ? "Edit applied" : "Response completed");
    setStatus(
      approvalFailed
        ? "DFM edit approval failed."
        : editApplied ? "ArcBot edit completed." : `${isClaudeModel() ? getAssistantModelLabel() : "Codex"} ready. ${getModeLabel()}.`,
      approvalFailed ? "error" : "",
    );
  } catch (err) {
    const message = assistantCancelRequested ? "Request canceled." : String(err?.message || err || "ArcBot request failed.");
    resolveAssistantPendingMessage(pending, message);
    assistantMessages.push({ role: "assistant", content: message, timestamp: nowIso() });
    appendActivity(assistantCancelRequested ? "Request canceled" : "Request failed", assistantCancelRequested ? "activity" : "error");
    failAssistantProgress(message);
    setStatus(message, assistantCancelRequested ? "" : "error");
  } finally {
    currentRequestId = "";
    currentRunStartedAt = 0;
    currentStepStartedAt = 0;
    stopAssistantProgressTicker();
    renderActivities();
    currentPendingMessageEl = null;
    await saveCurrentSession();
    await refreshSessionList(currentSessionId);
    assistantBusy = false;
    assistantCancelRequested = false;
    assistantHostRequestSubmitted = false;
    setComposerEnabled(assistantReady);
  }
}

function handleAssistantEvent(event) {
  if (!event || event.requestId !== currentRequestId) return;
  if (event.type === "stdout") {
    appendDebugLog(event.text, "stdout");
    return;
  }
  if (event.type === "stderr") {
    appendDebugLog(event.text, "stderr");
    return;
  }
  if (event.type === "usage") {
    currentUsage = event.usage || currentUsage;
    updateContextPanel();
    appendDebugLog(event.text, "usage");
    return;
  }
  if (event.type === "context" && event.context) {
    currentContext = { ...(currentContext || {}), ...event.context };
    updateContextPanel();
    appendActivity(formatAssistantContextScanStatus(event.context), "activity");
    appendDebugLog(`${event.text}\n${JSON.stringify(event.context, null, 2)}`, "context");
    return;
  }
  const text = String(event.text || "").trim();
  if (!text) return;
  appendDebugLog(text, event.type || "activity");
  if (event.debugText) appendDebugLog(event.debugText, "debug");
  const displayText = formatAssistantActivityForCard(text, event);
  if (displayText) appendActivity(text, event.type || "activity", { displayText });
}

export function initAiAssistant() {
  ensureAiAssistantDom(assistantConfig);
  const launcher = $("aiAssistantLauncher");
  const panel = $("aiAssistantPanel");
  const composer = $("aiAssistantComposer");
  if (!launcher || !panel || !composer) return;
  const host = getHostApi();
  if (!host) {
    launcher.style.display = "none";
    return;
  }
  setAiAssistantLauncherVisible(isAiAssistantLauncherVisible());
  ensureAssistantSession();
  host.onCodexAssistantEvent?.(handleAssistantEvent);

  launcher.addEventListener("click", (event) => {
    if (suppressLauncherClick) {
      event.preventDefault();
      return;
    }
    if (panel.classList.contains("open")) closeAssistant();
    else openAssistant();
  });
  $("aiAssistantCloseBtn")?.addEventListener("click", closeAssistant);
  $("aiAssistantRefreshBtn")?.addEventListener("click", refreshAssistantStatus);
  $("aiAssistantSetupBtn")?.addEventListener("click", installCodexCli);
  $("aiAssistantLoginBtn")?.addEventListener("click", loginCodexCli);
  $("aiAssistantAttachBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAttachMenu();
  });
  $("aiAssistantAttachFileOption")?.addEventListener("click", attachAssistantContextFile);
  $("aiAssistantNewChatBtn")?.addEventListener("click", async () => {
    const result = await openOrCreateEmptyAssistantSession();
    closeHistoryPage();
    setStatus(result?.created
      ? "New ArcBot chat started."
      : result?.alreadyCurrent
        ? "ArcBot is already on an empty chat."
        : "Opened existing empty ArcBot chat.");
  });
  $("aiAssistantHistoryBtn")?.addEventListener("click", () => {
    const page = $("aiAssistantHistoryPage");
    if (page?.classList.contains("open")) closeHistoryPage();
    else openHistoryPage();
  });
  $("aiAssistantHistoryCloseBtn")?.addEventListener("click", () => {
    closeHistoryPage();
  });
  $("aiAssistantAppContextBtn")?.addEventListener("click", async () => {
    setAssistantAppContextEnabled(!assistantAppContextEnabled);
    if (assistantAppContextEnabled) {
      const activeContext = await requestActivePageContext();
      currentContext = normalizeAssistantContextForPanel(activeContext);
      updateContextPanel();
    }
    refreshAppContextTooltip({ probe: assistantAppContextEnabled });
  });
  $("aiAssistantAppContextBtn")?.addEventListener("mouseenter", () => {
    const tooltip = $("aiAssistantAppContextTooltip");
    if (tooltip) {
      renderAppContextTooltip(tooltip, getActiveTabPreviewContext());
      tooltip.classList.add("open");
    }
    refreshAppContextTooltip({ probe: assistantAppContextEnabled });
  });
  $("aiAssistantAppContextBtn")?.addEventListener("mouseleave", () => {
    $("aiAssistantAppContextTooltip")?.classList.remove("open");
  });
  $("aiAssistantDebugBtn")?.addEventListener("click", () => {
    const panel = $("aiAssistantDebugPanel");
    const open = !panel?.classList.contains("open");
    closeAssistantSettingsPanel();
    panel?.classList.toggle("open", open);
    $("aiAssistantDebugBtn")?.setAttribute("aria-expanded", open ? "true" : "false");
    renderDebugLog();
  });
  $("aiAssistantSettingsBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAssistantSettingsPanel();
  });
  $("aiAssistantFolderPermissionsBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openFolderPermissionsPage();
  });
  $("aiAssistantFolderPermissionsCloseBtn")?.addEventListener("click", () => {
    closeFolderPermissionsPage();
  });
  $("aiAssistantFolderAddBtn")?.addEventListener("click", () => {
    addAssistantReadableRoot();
  });
  $("aiAssistantPromptGuideBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openAssistantPromptGuide();
  });
  $("aiAssistantSettingsModelSelect")?.addEventListener("change", (event) => {
    setAssistantModel(event.target?.value);
  });
  $("aiAssistantSettingsReasoningSelect")?.addEventListener("change", (event) => {
    setAssistantReasoningEffort(event.target?.value);
  });
  $("aiAssistantCopyDebugBtn")?.addEventListener("click", async () => {
    const text = $("aiAssistantDebugLog")?.textContent || "";
    try {
      await navigator.clipboard.writeText(text);
      setStatus("ArcBot debug log copied.");
    } catch {
      setStatus("Could not copy ArcBot debug log.", "error");
    }
  });
  $("aiAssistantModeButton")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeAttachMenu();
    toggleModeMenu();
  });
  $("aiAssistantReviewModeOption")?.addEventListener("click", () => {
    closeModeMenu();
    setAssistantMode("review");
  });
  $("aiAssistantApprovalModeOption")?.addEventListener("click", () => {
    closeModeMenu();
    setAssistantMode("approve");
  });
  $("aiAssistantEditModeOption")?.addEventListener("click", (event) => {
    event.preventDefault();
    closeModeMenu();
    setAssistantMode("edit");
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (assistantBusy) {
      cancelAssistantMessage();
    } else {
      sendAssistantMessage();
    }
  });
  $("aiAssistantInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!assistantBusy) sendAssistantMessage();
    }
  });
  $("aiAssistantInput")?.addEventListener("input", autoGrowAssistantInput);
  autoGrowAssistantInput();

  document.addEventListener("pointerdown", (event) => {
    if (!event.target?.closest?.("#aiAssistantSettingsPanel") &&
        !event.target?.closest?.("#aiAssistantSettingsBtn")) {
      closeAssistantSettingsPanel();
    }
    if (event.target?.closest?.(".aiAssistantSelectWrap")) return;
    if (event.target?.closest?.("#aiAssistantAttachMenu") || event.target?.closest?.("#aiAssistantAttachBtn")) return;
    closeSelectMenus();
    closeAttachMenu();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeFolderPermissionsPage();
      closeAssistantSettingsPanel();
      closeSelectMenus();
      closeAttachMenu();
    }
  }, true);
  initAssistantDrag(panel);
  initAssistantResize(panel);
  initAssistantLauncherDrag(launcher);
  setAssistantAppContextEnabled(true);
  setAssistantModel(assistantModel, { save: false });
  setAssistantReasoningEffort(assistantReasoningEffort, { save: false });
  renderAssistantAttachments();
  loadAssistantReadableRoots();
  loadAssistantUserAvatarName();
  setComposerEnabled(false);
}
