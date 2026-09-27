// Server tab: the servers this PC knows, which one is in use, adding one, and switching, plus the
// components of the server in use and, for a server whose folder is on this PC, starting and
// stopping it. The listing, health checks, folder reads, component status, start and stop come
// from the app server; switching goes through the shell, which owns the unsaved-changes guard
// and the restart.
import {
  COMPONENT_VISIBILITY_TICK_MS,
  SERVER_ACTION_POLL_MS,
  addServerProblem,
  buildComponentGroups,
  buildServerRows,
  componentPanelState,
  healthQuery,
  isSetAtLaunch,
  serverActionMessage,
  serverActionOutcome,
  serverControlView,
  serverLabel,
  shouldRefreshComponents,
  switchResultMessage,
} from "./server_model.js?v=20260927a";

const $ = (id) => document.getElementById(id);
const hostApi = () => window.ADAHost || window.parent?.ADAHost || null;
const SWITCH_REPLY_TIMEOUT_MS = 20000;

const state = {
  listing: null,
  health: new Map(),
  expanded: new Set(),
  inspectedRoot: "",
  autoName: "",
  inspectSeq: 0,
  pendingConfirm: null,
};

const components = {
  status: null,
  error: "",
  inFlight: false,
  lastFetchAt: 0,
  wasHidden: false,
  // The start or stop under way: { kind: "start" | "stop", startedAt }.
  action: null,
};

function setMessage(text, tone = "", id = "svMessage") {
  const el = $(id);
  el.textContent = text || "";
  el.classList.toggle("error", tone === "error");
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.detail || `Request failed (${response.status}).`));
  return data;
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function healthState(row) {
  const health = state.health.get(row.key);
  if (!row.gatewayUrl) return { tone: "unknown", text: "No Gateway address is known for this server." };
  if (!health) return { tone: "checking", text: "Checking the Gateway..." };
  return health.ok
    ? { tone: "ok", text: "The Gateway is answering." }
    : { tone: "error", text: health.detail || "The Gateway is not answering." };
}

function renderDetails(row) {
  const list = makeEl("dl", "svDetails");
  const { details } = row;
  const credential = details.credentialExists
    ? details.credentialFile
    : `${details.credentialFile} (created on the first switch)`;
  for (const [label, value] of [
    ["Folder", details.folder],
    ["Credential File", credential],
    ["User", details.user || "Not signed in yet"],
    ["Health", healthState(row).text],
  ]) {
    list.append(makeEl("dt", "", `${label} : `), makeEl("dd", "", value));
  }
  return list;
}

function renderRow(row) {
  const expanded = state.expanded.has(row.key);
  const item = makeEl("div", `svRow${row.chip ? " current" : ""}`);
  item.setAttribute("role", "listitem");
  const main = makeEl("div", "svRowMain");

  const toggle = makeEl("button", "svExpand");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} details for ${row.name}`);
  toggle.addEventListener("click", () => {
    if (state.expanded.has(row.key)) state.expanded.delete(row.key);
    else state.expanded.add(row.key);
    renderList();
  });

  const health = healthState(row);
  const dot = makeEl("span", `svDot ${health.tone}`);
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", health.text);

  const label = makeEl("span", "svLabel", row.label);
  const chip = makeEl("span", "svChip", row.chip);
  chip.hidden = !row.chip;

  const switchBtn = makeEl("button", "svBtn svSwitchBtn", "Switch");
  switchBtn.type = "button";
  switchBtn.disabled = !row.canSwitch;
  switchBtn.classList.toggle("placeholder", !!row.chip);
  switchBtn.addEventListener("click", () => openSwitchConfirm(row));

  main.append(toggle, dot, label, chip, switchBtn);
  item.append(main);
  if (expanded) item.append(renderDetails(row));
  return item;
}

function renderList() {
  const list = $("svServerList");
  const rows = buildServerRows(state.listing);
  list.replaceChildren(...rows.map(renderRow));
  if (!rows.length) list.replaceChildren(makeEl("div", "svEmpty", "No servers are saved on this PC."));
  const saved = state.listing?.profiles?.length || 0;
  $("svServerCount").textContent = saved ? `${saved} saved` : "";
}

function render() {
  const launched = isSetAtLaunch(state.listing);
  $("svLaunchNotice").hidden = !launched;
  $("svAddBtn").disabled = launched || !state.listing;
  if (launched) closeAddForm();
  renderList();
}

async function checkHealth(rows) {
  await Promise.all(rows.filter((row) => row.gatewayUrl).map(async (row) => {
    try {
      const response = await fetch(`/server_profiles/health${healthQuery(row)}`, { cache: "no-store" });
      state.health.set(row.key, await readJson(response));
    } catch (error) {
      state.health.set(row.key, { ok: false, detail: String(error?.message || error) });
    }
    renderList();
  }));
}

async function loadServers() {
  setMessage("");
  try {
    const response = await fetch("/server_profiles", { cache: "no-store" });
    state.listing = await readJson(response);
  } catch (error) {
    state.listing = null;
    render();
    $("svServerList").replaceChildren(makeEl("div", "svEmpty", "The server list could not be read."));
    setMessage(String(error?.message || error), "error");
    return;
  }
  state.health.clear();
  render();
  void checkHealth(buildServerRows(state.listing));
}

// Components ---------------------------------------------------------------------------------

function renderComponentGroup(group) {
  const body = makeEl("tbody", "svCompGroup");
  const head = makeEl("tr", "svCompGroupRow");
  const cell = makeEl("th", "");
  cell.colSpan = 5;
  cell.scope = "rowgroup";
  const line = makeEl("div", "svCompGroupLine");
  const stop = group.stopSwitch
    ? makeEl("span", "svStopChip", "Stop Switch On")
    : makeEl("span", "svStopOff", "Stop switch off");
  line.append(makeEl("span", "svCompRole", group.label), makeEl("span", "svCount", group.summary), stop);
  cell.append(line);
  head.append(cell);
  body.append(head);
  for (const row of group.rows) {
    const tr = makeEl("tr", "svCompRow");
    const status = makeEl("span", `svStatus ${row.stale ? "stale" : "active"}`, row.status);
    const statusCell = makeEl("td", "");
    statusCell.append(status);
    tr.append(
      makeEl("td", "svCompName", group.label),
      makeEl("td", "", row.machine),
      makeEl("td", "", row.user),
      makeEl("td", "svCompHeard", row.heard),
      statusCell,
    );
    body.append(tr);
  }
  return body;
}

function renderControls() {
  const view = serverControlView(components.status, components.action, Date.now());
  $("svControlNote").textContent = view.note;
  $("svControlProgress").textContent = view.progress;
  $("svStartBtn").hidden = !view.show;
  $("svStopBtn").hidden = !view.show;
  $("svStartBtn").disabled = !view.canStart;
  $("svStopBtn").disabled = !view.canStop;
}

function renderComponents() {
  renderControls();
  const host = $("svComponents");
  const view = componentPanelState(components.status, components.error);
  $("svComponentsSource").textContent = view.kind === "ready" ? view.source : "";
  if (view.kind !== "ready") {
    host.replaceChildren(makeEl("div", `svEmpty${view.kind === "loading" ? "" : " error"}`, view.message));
    return;
  }
  const table = makeEl("table", "svCompTable");
  const headRow = makeEl("tr", "");
  for (const label of ["Component", "Machine", "User", "Last Heard", "Status"]) {
    const th = makeEl("th", "", label);
    th.scope = "col";
    headRow.append(th);
  }
  const thead = makeEl("thead", "");
  thead.append(headRow);
  table.append(thead, ...buildComponentGroups(components.status).map(renderComponentGroup));
  host.replaceChildren(table);
}

async function loadComponents() {
  components.inFlight = true;
  try {
    const response = await fetch("/server/status", { cache: "no-store" });
    components.status = await readJson(response);
    components.error = "";
  } catch (error) {
    components.error = String(error?.message || error);
  } finally {
    components.inFlight = false;
    components.lastFetchAt = Date.now();
  }
  followServerAction();
  renderComponents();
}

// Ends a start or stop once the heartbeats show it finished, or once it has waited too long.
function followServerAction() {
  const { action } = components;
  const outcome = serverActionOutcome(components.status, action, Date.now());
  if (!outcome || outcome === "waiting") return;
  components.action = null;
  const message = serverActionMessage(action.kind, outcome);
  setMessage(message.text, message.tone, "svControlMessage");
}

// An inactive shell tab keeps its page loaded but hides its frame, which the page's own
// visibility state does not report, so the frame's layout is checked too.
function componentsOnScreen() {
  if (document.visibilityState !== "visible") return false;
  let frame = null;
  try { frame = window.frameElement; } catch { frame = null; }
  return !frame || frame.getClientRects().length > 0;
}

function componentTick() {
  const visible = componentsOnScreen();
  if (!visible) {
    components.wasHidden = true;
    return;
  }
  const now = Date.now();
  const ask = components.action
    ? !components.inFlight && now - components.lastFetchAt >= SERVER_ACTION_POLL_MS
    : shouldRefreshComponents({ ...components, visible, now });
  components.wasHidden = false;
  if (components.action) renderControls();
  if (ask) void loadComponents();
}

// Start and stop -----------------------------------------------------------------------------

async function runServerAction(kind) {
  setMessage(kind === "start" ? "Starting the server..." : "Stopping the server...", "", "svControlMessage");
  components.action = { kind, startedAt: Date.now() };
  renderControls();
  try {
    await readJson(await fetch(`/server/${kind}`, { method: "POST" }));
  } catch (error) {
    components.action = null;
    renderControls();
    setMessage(String(error?.message || error), "error", "svControlMessage");
    return;
  }
  if (!components.inFlight) void loadComponents();
}

function confirmStop() {
  openConfirm({
    title: "Stop Server",
    message: "This window uses this server, so it cannot open, save or calculate until you start it again.",
    okText: "Stop Server",
    danger: true,
    onOk: () => void runServerAction("stop"),
  });
}

// Add server ---------------------------------------------------------------------------------

function openAddForm() {
  const form = $("svAddForm");
  form.hidden = false;
  $("svAddBrowse").hidden = typeof hostApi()?.pickFolder !== "function";
  $("svAddFolder").focus();
}

function closeAddForm() {
  const form = $("svAddForm");
  if (form.hidden) return;
  form.hidden = true;
  form.reset();
  state.inspectedRoot = "";
  state.autoName = "";
}

async function inspectFolder() {
  const folder = $("svAddFolder").value.trim();
  const seq = ++state.inspectSeq;
  state.inspectedRoot = "";
  if (!folder) return;
  try {
    const response = await fetch(`/server_profiles/inspect?root=${encodeURIComponent(folder)}`, { cache: "no-store" });
    const data = await readJson(response);
    if (seq !== state.inspectSeq) return;
    state.inspectedRoot = data.root;
    const nameInput = $("svAddName");
    if (!nameInput.value.trim() || nameInput.value === state.autoName) {
      nameInput.value = data.name || "";
      state.autoName = nameInput.value;
    }
    setMessage("");
  } catch (error) {
    if (seq !== state.inspectSeq) return;
    setMessage(String(error?.message || error), "error");
  }
}

async function browseFolder() {
  const host = hostApi();
  if (typeof host?.pickFolder !== "function") return;
  try {
    const picked = String(await host.pickFolder($("svAddFolder").value.trim()) || "").trim();
    if (!picked) return;
    $("svAddFolder").value = picked;
    await inspectFolder();
  } catch (error) {
    setMessage(`Folder selection failed: ${error?.message || error}`, "error");
  }
}

async function saveServer(event) {
  event.preventDefault();
  if ($("svAddFolder").value.trim() && !state.inspectedRoot) await inspectFolder();
  const name = $("svAddName").value.trim();
  const address = $("svAddAddress").value.trim();
  const problem = addServerProblem(state.listing, { name, inspectedRoot: state.inspectedRoot, address });
  if (problem) {
    setMessage(problem, "error");
    return;
  }
  const saveBtn = $("svAddSave");
  saveBtn.disabled = true;
  try {
    const response = await fetch("/server_profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, root: state.inspectedRoot, gateway_url: address }),
    });
    state.listing = await readJson(response);
    closeAddForm();
    render();
    setMessage(`Added ${name}.`);
    void checkHealth(buildServerRows(state.listing));
  } catch (error) {
    setMessage(String(error?.message || error), "error");
  } finally {
    saveBtn.disabled = false;
  }
}

// Switch -------------------------------------------------------------------------------------

function openConfirm({ title, message, okText, danger = false, onOk }) {
  state.pendingConfirm = onOk;
  $("svConfirmTitle").textContent = title;
  $("svConfirmMessage").textContent = message;
  const ok = $("svConfirmOk");
  ok.textContent = okText;
  ok.classList.toggle("primary", !danger);
  ok.classList.toggle("danger", danger);
  $("svConfirmOverlay").hidden = false;
  $("svConfirmCancel").focus();
}

function closeConfirm() {
  state.pendingConfirm = null;
  $("svConfirmOverlay").hidden = true;
}

function acceptConfirm() {
  const onOk = state.pendingConfirm;
  closeConfirm();
  if (onOk) onOk();
}

function openSwitchConfirm(row) {
  openConfirm({
    title: "Switch Server",
    message: `Switch to ${row.label}? The app restarts to connect to it, and your open tabs reopen afterwards.`,
    okText: "Switch and Restart",
    onOk: () => void confirmSwitch(row),
  });
}

// The shell checks every tab for unsaved changes, activates the server and restarts the app.
function requestSwitch(profileId) {
  const requestId = `server-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let timer = 0;
    const onMessage = (event) => {
      const msg = event.data;
      if (event.source !== window.parent || msg?.type !== "arcrho:server-switch-result" || msg.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(msg);
    };
    window.addEventListener("message", onMessage);
    timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "The app did not answer the switch request." });
    }, SWITCH_REPLY_TIMEOUT_MS);
    window.parent.postMessage({ type: "arcrho:server-switch", requestId, id: profileId }, window.location.origin);
  });
}

async function confirmSwitch(row) {
  if (window.parent === window) {
    setMessage("Switching servers needs the Arco window.", "error");
    return;
  }
  setMessage(`Switching to ${row.label}...`);
  const result = await requestSwitch(row.profileId);
  const message = switchResultMessage(result, serverLabel(row.name, row.gatewayUrl));
  setMessage(message.text, message.tone);
  if (result?.ok && !result.restartRequired) void loadServers();
}

function wire() {
  $("svRefreshBtn").addEventListener("click", () => {
    void loadServers();
    if (!components.inFlight) void loadComponents();
  });
  document.addEventListener("visibilitychange", componentTick);
  window.setInterval(componentTick, COMPONENT_VISIBILITY_TICK_MS);
  $("svAddBtn").addEventListener("click", openAddForm);
  $("svAddCancel").addEventListener("click", closeAddForm);
  $("svAddBrowse").addEventListener("click", () => void browseFolder());
  $("svAddFolder").addEventListener("change", () => void inspectFolder());
  $("svAddForm").addEventListener("submit", (event) => void saveServer(event));
  $("svStartBtn").addEventListener("click", () => void runServerAction("start"));
  $("svStopBtn").addEventListener("click", confirmStop);
  $("svConfirmCancel").addEventListener("click", closeConfirm);
  $("svConfirmOk").addEventListener("click", acceptConfirm);
  $("svConfirmOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeConfirm();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("svConfirmOverlay").hidden) closeConfirm();
  });
}

wire();
void loadServers();
componentTick();
