// Server tab: the servers this PC knows, which one is in use, adding one, and switching.
// The listing, health checks and folder reads come from the app server; switching goes through
// the shell, which owns the unsaved-changes guard and the restart.
import {
  addServerProblem,
  buildServerRows,
  healthQuery,
  isSetAtLaunch,
  serverAddress,
  serverLabel,
  switchResultMessage,
} from "./server_model.js?v=20260926a";

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
  pendingSwitch: null,
};

function setMessage(text, tone = "") {
  const el = $("svMessage");
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
  $("svAddAddress").textContent = "Choose a folder to read its address.";
}

async function inspectFolder() {
  const folder = $("svAddFolder").value.trim();
  const seq = ++state.inspectSeq;
  state.inspectedRoot = "";
  if (!folder) return;
  const address = $("svAddAddress");
  address.textContent = "Reading the folder...";
  try {
    const response = await fetch(`/server_profiles/inspect?root=${encodeURIComponent(folder)}`, { cache: "no-store" });
    const data = await readJson(response);
    if (seq !== state.inspectSeq) return;
    state.inspectedRoot = data.root;
    address.textContent = serverAddress(data.gateway_url) || "Not found in this folder's Gateway settings.";
    const nameInput = $("svAddName");
    if (!nameInput.value.trim() || nameInput.value === state.autoName) {
      nameInput.value = data.name || "";
      state.autoName = nameInput.value;
    }
    setMessage("");
  } catch (error) {
    if (seq !== state.inspectSeq) return;
    address.textContent = "Not a server folder.";
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
  const problem = addServerProblem(state.listing, { name, inspectedRoot: state.inspectedRoot });
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
      body: JSON.stringify({ name, root: state.inspectedRoot }),
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

function openSwitchConfirm(row) {
  state.pendingSwitch = row;
  $("svConfirmMessage").textContent = `Switch to ${row.label}? The app restarts to connect to it, and your open tabs reopen afterwards.`;
  $("svConfirmOverlay").hidden = false;
  $("svConfirmCancel").focus();
}

function closeSwitchConfirm() {
  state.pendingSwitch = null;
  $("svConfirmOverlay").hidden = true;
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

async function confirmSwitch() {
  const row = state.pendingSwitch;
  closeSwitchConfirm();
  if (!row) return;
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
  $("svRefreshBtn").addEventListener("click", () => void loadServers());
  $("svAddBtn").addEventListener("click", openAddForm);
  $("svAddCancel").addEventListener("click", closeAddForm);
  $("svAddBrowse").addEventListener("click", () => void browseFolder());
  $("svAddFolder").addEventListener("change", () => void inspectFolder());
  $("svAddForm").addEventListener("submit", (event) => void saveServer(event));
  $("svConfirmCancel").addEventListener("click", closeSwitchConfirm);
  $("svConfirmOk").addEventListener("click", () => void confirmSwitch());
  $("svConfirmOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeSwitchConfirm();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("svConfirmOverlay").hidden) closeSwitchConfirm();
  });
}

wire();
void loadServers();
