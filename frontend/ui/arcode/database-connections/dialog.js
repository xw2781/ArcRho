import {
  SQL_ENGINES,
  escapeHtml,
  fetchEngineJson,
  getSqlEngine,
} from "../shared/sql_engines.js?v=20260818a";

/**
 * Database Connections: the one place Arcode connection profiles are managed.
 *
 * The dialog lives in the shell, under Settings > Database Connections, rather
 * than inside a SQL editor page, so a profile can be added before any editor
 * tab is open and so both engines are edited the same way. What each engine
 * stores, which routes it uses, and whether it has a default profile all come
 * from `shared/sql_engines.js`; this module only renders and edits.
 *
 * No credential is ever collected here: SQL Server uses the signed-in Windows
 * account and Snowflake signs in through the browser.
 */

const $ = (id) => document.getElementById(id);

function fieldMarkup(field) {
  const control = field.type === "select"
    ? `<select id="dbcField_${field.key}" class="dbcInput">${
      field.options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")
    }</select>`
    : `<input id="dbcField_${field.key}" class="dbcInput" type="text" spellcheck="false"${
      field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ""
    }/>`;
  return `
    <label class="dbcField">
      <span class="dbcFieldLabel">${escapeHtml(field.label)}</span>
      ${control}
    </label>`;
}

function dialogMarkup() {
  return `
    <section class="dbcDialog" role="dialog" aria-modal="true" aria-labelledby="dbcTitle">
      <header class="dbcHeader">
        <span id="dbcTitle" class="dbcTitle">Database Connections</span>
        <button id="dbcCloseBtn" class="dbcIconBtn" type="button" aria-label="Close database connections">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <div class="dbcEngineTabs" role="tablist" aria-label="Database engine">
        ${SQL_ENGINES.map((engine) => `
          <button class="dbcEngineTab" type="button" role="tab" data-engine="${engine.id}" aria-selected="false">
            ${escapeHtml(engine.productName)}
          </button>`).join("")}
      </div>

      <div class="dbcBody">
        <aside class="dbcSidebar" aria-label="Saved connections">
          <div id="dbcList" class="dbcList" role="listbox" aria-label="Saved connections"></div>
          <button id="dbcNewBtn" class="dbcBtn" type="button">New Connection</button>
        </aside>

        <form id="dbcForm" class="dbcForm" autocomplete="off"></form>
      </div>

      <footer class="dbcFooter">
        <button id="dbcDeleteBtn" class="dbcBtn danger" type="button">Delete</button>
        <span class="dbcFooterSpacer"></span>
        <button id="dbcTestBtn" class="dbcBtn" type="button">Test</button>
        <button id="dbcCancelBtn" class="dbcBtn" type="button">Close</button>
        <button id="dbcSaveBtn" class="dbcBtn primary" type="button">Save</button>
      </footer>
    </section>`;
}

export function createDatabaseConnectionsDialog({ onChanged, setStatus } = {}) {
  // The profile being edited. Empty means the form adds a new connection, so
  // saving after a rename updates in place instead of leaving the old one.
  let engine = SQL_ENGINES[0];
  let editingName = "";
  let connections = {};
  let defaultConnectionName = "";
  let wired = false;

  const report = (text) => setStatus?.(text);

  function setMessage(text, { error = false } = {}) {
    const box = $("dbcMessage");
    if (!box) return;
    box.textContent = String(text || "");
    box.classList.toggle("error", !!error);
  }

  function renderForm() {
    const form = $("dbcForm");
    if (!form) return;
    form.innerHTML = `
      ${engine.profileFields.map(fieldMarkup).join("")}
      ${engine.supportsDefaultConnection ? `
        <label class="dbcCheckField">
          <input id="dbcFieldDefault" type="checkbox"/>
          <span>Open New Tabs With This Connection</span>
        </label>` : ""}
      <p class="dbcHint">${escapeHtml(engine.formHint)}</p>
      <p id="dbcMessage" class="dbcMessage" role="status"></p>`;
  }

  function formValues() {
    const profile = {};
    for (const field of engine.profileFields) {
      profile[field.wireKey || field.key] = String($(`dbcField_${field.key}`)?.value || "").trim();
    }
    return profile;
  }

  function formName() {
    return String($("dbcField_name")?.value || "").trim();
  }

  function fillForm(profile, { isDefault = false } = {}) {
    for (const field of engine.profileFields) {
      const input = $(`dbcField_${field.key}`);
      if (!input) continue;
      const stored = profile?.[field.key] ?? profile?.[field.wireKey || field.key] ?? "";
      input.value = field.type === "select"
        ? String(stored || field.options[0]?.value || "")
        : String(stored || "");
    }
    const defaultBox = $("dbcFieldDefault");
    if (defaultBox) defaultBox.checked = !!isDefault;
    const deleteBtn = $("dbcDeleteBtn");
    if (deleteBtn) deleteBtn.disabled = !editingName;
    const testBtn = $("dbcTestBtn");
    if (testBtn) testBtn.disabled = !editingName;
  }

  function renderList(selectedName) {
    const list = $("dbcList");
    if (!list) return;
    list.textContent = "";
    const names = Object.keys(connections);
    if (!names.length) {
      const empty = document.createElement("p");
      empty.className = "dbcListEmpty";
      empty.textContent = "No saved connections yet.";
      list.appendChild(empty);
      return;
    }
    names.forEach((name) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dbcListRow";
      row.setAttribute("role", "option");
      const selected = name === selectedName;
      row.setAttribute("aria-selected", String(selected));
      row.classList.toggle("selected", selected);
      const title = document.createElement("span");
      title.className = "dbcListName";
      title.textContent = name;
      const detail = document.createElement("span");
      detail.className = "dbcListDetail";
      const profile = connections[name] || {};
      // Two chip fields say enough to tell profiles apart in a list.
      detail.textContent = engine.contextFields
        .slice(0, 2)
        .map((field) => field.keys.map((key) => profile[key]).find(Boolean))
        .filter(Boolean)
        .join(" / ");
      row.append(title, detail);
      row.addEventListener("click", () => selectConnection(name));
      list.appendChild(row);
    });
  }

  function selectConnection(name) {
    const profile = connections[name];
    if (!profile) return;
    editingName = name;
    fillForm(profile, { isDefault: !!name && name === defaultConnectionName });
    renderList(name);
    setMessage("");
  }

  function startNewConnection() {
    editingName = "";
    fillForm({}, { isDefault: !Object.keys(connections).length });
    renderList("");
    setMessage("");
    $("dbcField_name")?.focus();
  }

  async function loadConnections({ select = "" } = {}) {
    try {
      const result = await fetchEngineJson(engine.routes.connections);
      connections = result?.connections && typeof result.connections === "object" ? result.connections : {};
      defaultConnectionName = String(result?.defaultConnection || "");
      if (result?.connectorAvailable === false) {
        setMessage(result?.connectorError || engine.connectorMissingStatus);
      }
    } catch (err) {
      connections = {};
      defaultConnectionName = "";
      setMessage(`${engine.connectionsErrorPrefix}: ${String(err?.message || err)}`, { error: true });
    }
    const target = String(select || editingName || defaultConnectionName || "");
    if (connections[target]) selectConnection(target);
    else startNewConnection();
  }

  function renderEngineTabs() {
    document.querySelectorAll(".dbcEngineTab").forEach((tab) => {
      const selected = tab.dataset.engine === engine.id;
      tab.classList.toggle("selected", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
  }

  async function selectEngine(engineId) {
    const next = getSqlEngine(engineId);
    if (!next || next.id === engine.id) return;
    engine = next;
    editingName = "";
    renderEngineTabs();
    renderForm();
    await loadConnections();
  }

  async function saveConnection() {
    const button = $("dbcSaveBtn");
    if (button) button.disabled = true;
    try {
      const name = formName();
      const payload = { connection: editingName, profile: formValues() };
      if (engine.supportsDefaultConnection) payload.make_default = !!$("dbcFieldDefault")?.checked;
      await fetchEngineJson(engine.routes.save, { method: "POST", body: JSON.stringify(payload) });
      editingName = name;
      await loadConnections({ select: name });
      setMessage(`Saved ${name}.`);
      report(`Saved ${engine.productName} connection ${name}.`);
      onChanged?.();
    } catch (err) {
      setMessage(String(err?.message || err), { error: true });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function deleteConnection() {
    if (!editingName) return;
    const name = editingName;
    if (!window.confirm(`Remove the ${engine.productName} connection "${name}"?`)) return;
    const button = $("dbcDeleteBtn");
    if (button) button.disabled = true;
    try {
      await fetchEngineJson(engine.routes.delete, {
        method: "POST",
        body: JSON.stringify({ connection: name }),
      });
      editingName = "";
      await loadConnections();
      setMessage(`Removed ${name}.`);
      report(`Removed ${engine.productName} connection ${name}.`);
      onChanged?.();
    } catch (err) {
      setMessage(String(err?.message || err), { error: true });
    } finally {
      if (button) button.disabled = !editingName;
    }
  }

  /** Test the saved profile, so what is tested is what an editor tab will use. */
  async function testConnection() {
    if (!editingName) {
      setMessage("Save the connection before testing it.");
      return;
    }
    const button = $("dbcTestBtn");
    if (button) button.disabled = true;
    setMessage(`Testing ${editingName}...`);
    try {
      const result = await fetchEngineJson(engine.routes.test, {
        method: "POST",
        body: JSON.stringify({ sql: "", connection: editingName, limit: 1 }),
      });
      const ok = !!result?.ok;
      setMessage(ok ? `${editingName} connected.` : (result?.error || "Connection test failed."), { error: !ok });
      report(`${engine.productName} connection test ${ok ? "succeeded" : "failed"}.`);
    } catch (err) {
      setMessage(String(err?.message || err), { error: true });
    } finally {
      if (button) button.disabled = !editingName;
    }
  }

  function isOpen() {
    return !$("dbcBackdrop")?.hidden;
  }

  function close() {
    const backdrop = $("dbcBackdrop");
    if (backdrop) backdrop.hidden = true;
  }

  function wire() {
    if (wired) return;
    wired = true;
    $("dbcBackdrop").innerHTML = dialogMarkup();
    renderForm();
    document.querySelectorAll(".dbcEngineTab").forEach((tab) => {
      tab.addEventListener("click", () => void selectEngine(tab.dataset.engine || ""));
    });
    $("dbcNewBtn")?.addEventListener("click", startNewConnection);
    $("dbcSaveBtn")?.addEventListener("click", () => void saveConnection());
    $("dbcDeleteBtn")?.addEventListener("click", () => void deleteConnection());
    $("dbcTestBtn")?.addEventListener("click", () => void testConnection());
    $("dbcCloseBtn")?.addEventListener("click", close);
    $("dbcCancelBtn")?.addEventListener("click", close);
    $("dbcBackdrop")?.addEventListener("mousedown", (event) => {
      if (event.target === event.currentTarget) close();
    });
    $("dbcForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveConnection();
    });
    window.addEventListener("keydown", (event) => {
      if (!isOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Enter" && event.target?.classList?.contains("dbcInput")) {
        event.preventDefault();
        void saveConnection();
      }
    });
  }

  async function open() {
    const backdrop = $("dbcBackdrop");
    if (!backdrop) return;
    wire();
    backdrop.hidden = false;
    renderEngineTabs();
    setMessage("");
    await loadConnections();
    $("dbcField_name")?.focus();
  }

  return { open, close, isOpen };
}
