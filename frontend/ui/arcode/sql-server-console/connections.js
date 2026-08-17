import { fetchConsoleJson } from "../shared/sql_console.js?v=20260817a";

/**
 * Connection manager for the Arcode SQL Server console.
 *
 * Profiles name a server and a database only: queries run as the signed-in
 * Windows account, so the dialog never asks for or stores a credential. The
 * app server owns validation and the stored payload; this module only edits.
 */

const ROUTES = {
  save: "/sqlserver/connections",
  delete: "/sqlserver/connections/delete",
};

const $ = (id) => document.getElementById(id);

export function createConnectionsDialog(console_) {
  // The profile being edited. Empty means the form adds a new connection, so
  // saving after a rename updates in place instead of leaving the old one.
  let editingName = "";
  let defaultConnectionName = "";

  function setMessage(text, { error = false } = {}) {
    const box = $("dialogMessage");
    if (!box) return;
    box.textContent = String(text || "");
    box.classList.toggle("error", !!error);
  }

  function formValues() {
    return {
      name: String($("fieldName")?.value || "").trim(),
      server: String($("fieldServer")?.value || "").trim(),
      database: String($("fieldDatabase")?.value || "").trim(),
      authentication: String($("fieldAuthentication")?.value || "windows").trim(),
    };
  }

  function fillForm(profile, { isDefault = false } = {}) {
    $("fieldName").value = String(profile?.name || "");
    $("fieldServer").value = String(profile?.server || "");
    $("fieldDatabase").value = String(profile?.database || "");
    $("fieldAuthentication").value = String(profile?.authentication || "windows");
    $("fieldDefault").checked = !!isDefault;
    $("deleteConnectionBtn").disabled = !editingName;
  }

  function renderList(selectedName) {
    const list = $("connectionList");
    if (!list) return;
    list.textContent = "";
    const connections = console_.getConnections();
    const names = Object.keys(connections);
    if (!names.length) {
      const empty = document.createElement("p");
      empty.className = "sqlsListEmpty";
      empty.textContent = "No saved connections yet.";
      list.appendChild(empty);
      return;
    }
    names.forEach((name) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sqlsListRow";
      row.setAttribute("role", "option");
      row.dataset.connection = name;
      const selected = name === selectedName;
      row.setAttribute("aria-selected", String(selected));
      row.classList.toggle("selected", selected);
      const title = document.createElement("span");
      title.className = "sqlsListName";
      title.textContent = name;
      const detail = document.createElement("span");
      detail.className = "sqlsListDetail";
      const profile = connections[name] || {};
      detail.textContent = [profile.server, profile.database].filter(Boolean).join(" / ");
      row.append(title, detail);
      row.addEventListener("click", () => selectConnection(name));
      list.appendChild(row);
    });
  }

  function isDefaultConnection(name) {
    return !!name && name === defaultConnectionName;
  }

  function selectConnection(name) {
    const profile = console_.getConnections()[name];
    if (!profile) return;
    editingName = name;
    fillForm(profile, { isDefault: isDefaultConnection(name) });
    renderList(name);
    setMessage("");
  }

  function startNewConnection() {
    editingName = "";
    fillForm({ authentication: "windows" }, { isDefault: !Object.keys(console_.getConnections()).length });
    renderList("");
    setMessage("");
    $("fieldName")?.focus();
  }

  async function refresh({ select = "" } = {}) {
    const result = await console_.reloadConnections({ select });
    defaultConnectionName = String(result?.defaultConnection || "");
    const target = String(select || console_.getActiveConnection() || "");
    if (console_.getConnections()[target]) selectConnection(target);
    else startNewConnection();
  }

  async function saveConnection() {
    const profile = formValues();
    const button = $("saveConnectionBtn");
    if (button) button.disabled = true;
    try {
      await fetchConsoleJson(ROUTES.save, {
        method: "POST",
        body: JSON.stringify({
          connection: editingName,
          profile,
          make_default: !!$("fieldDefault")?.checked,
        }),
      });
      await refresh({ select: profile.name });
      setMessage(`Saved ${profile.name}.`);
      console_.setStatus(`Saved SQL Server connection ${profile.name}.`);
    } catch (err) {
      setMessage(String(err?.message || err), { error: true });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function deleteConnection() {
    if (!editingName) return;
    const name = editingName;
    if (!window.confirm(`Remove the SQL Server connection "${name}"?`)) return;
    const button = $("deleteConnectionBtn");
    if (button) button.disabled = true;
    try {
      await fetchConsoleJson(ROUTES.delete, {
        method: "POST",
        body: JSON.stringify({ connection: name }),
      });
      await refresh();
      setMessage(`Removed ${name}.`);
      console_.setStatus(`Removed SQL Server connection ${name}.`);
    } catch (err) {
      setMessage(String(err?.message || err), { error: true });
    } finally {
      if (button) button.disabled = !editingName;
    }
  }

  function isOpen() {
    return !$("connectionsBackdrop")?.hidden;
  }

  function close() {
    const backdrop = $("connectionsBackdrop");
    if (backdrop) backdrop.hidden = true;
  }

  async function open() {
    const backdrop = $("connectionsBackdrop");
    if (!backdrop) return;
    backdrop.hidden = false;
    setMessage("");
    await refresh({ select: console_.getActiveConnection() });
    $("fieldName")?.focus();
  }

  function init() {
    $("manageConnectionsBtn")?.addEventListener("click", () => void open());
    $("newConnectionBtn")?.addEventListener("click", startNewConnection);
    $("saveConnectionBtn")?.addEventListener("click", () => void saveConnection());
    $("deleteConnectionBtn")?.addEventListener("click", () => void deleteConnection());
    $("closeConnectionsBtn")?.addEventListener("click", close);
    $("cancelConnectionsBtn")?.addEventListener("click", close);
    $("connectionsBackdrop")?.addEventListener("mousedown", (event) => {
      if (event.target === event.currentTarget) close();
    });
    $("connectionForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveConnection();
    });
    window.addEventListener("keydown", (event) => {
      if (!isOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Enter" && event.target?.classList?.contains("sqlsInput")) {
        event.preventDefault();
        void saveConnection();
      }
    });
  }

  return { init, open, close };
}
