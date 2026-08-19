import { inferSqlDialect } from "../../ai-assistant/skills.js?v=20260726a";
import { createEditorPage } from "./editor_framework.js?v=20260818a";
import { escapeHtml, fetchEngineJson, getSqlEngine, profileFieldValue } from "./sql_engines.js?v=20260818a";

/**
 * SQL editor mode for the generic Arcode editor framework.
 *
 * A SQL editor page is the plain code editor plus three engine-specific
 * things: a connection picker, a context bar naming the active profile, and a
 * Run that sends the statement to the engine and shows the result set in the
 * panel the framework already draws. Everything else - the Monaco editor, the
 * file lifecycle, disk-conflict handling, the ArcBot contract, Save, and the
 * workspace explorer beside it - comes from the framework and the shell.
 *
 * Connection profiles are edited in the shell's Settings > Database
 * Connections dialog, not here; this page only picks one and reloads the list
 * when the shell reports a change.
 */

const QUERY_ROW_LIMIT = 1000;

export function createSqlEditorPage(engineId) {
  const engine = getSqlEngine(engineId);
  if (!engine) throw new Error(`Unknown SQL engine: ${engineId}`);

  let connections = {};
  let activeConnection = "";
  let page = null;

  const $ = (id) => document.getElementById(id);

  function renderContextBar() {
    const profile = connections[activeConnection] || {};
    const bar = $("contextBar");
    if (!bar) return;
    bar.innerHTML = engine.contextFields.map((field) => {
      const value = profileFieldValue(profile, field.keys) || "-";
      return `<span class="sqlcChip">${escapeHtml(field.label)}: ${escapeHtml(value)}</span>`;
    }).join("");
    bar.hidden = false;
  }

  function renderConnections() {
    const select = $("connectionSelect");
    const names = Object.keys(connections);
    if (select) {
      select.textContent = "";
      if (!names.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No connections";
        select.appendChild(option);
      } else {
        names.forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          select.appendChild(option);
        });
        if (!activeConnection || !connections[activeConnection]) activeConnection = names[0];
        select.value = activeConnection;
      }
    }
    if (!names.length) activeConnection = "";
    renderContextBar();
    page?.updateCommandState();
  }

  async function reloadConnections({ select = "" } = {}) {
    const requested = String(select || "").trim();
    try {
      const result = await fetchEngineJson(engine.routes.connections);
      connections = result?.connections && typeof result.connections === "object" ? result.connections : {};
      if (requested && connections[requested]) activeConnection = requested;
      else if (!activeConnection || !connections[activeConnection]) {
        activeConnection = result?.defaultConnection || Object.keys(connections)[0] || "";
      }
      renderConnections();
      if (result?.connectorAvailable === false) {
        page?.setStatus(result?.connectorError || engine.connectorMissingStatus);
      } else if (!Object.keys(connections).length) {
        renderMessage(engine.emptyConnectionsMessage);
        page?.setStatus(engine.emptyConnectionsMessage);
      }
      return result;
    } catch (err) {
      page?.setStatus(`${engine.connectionsErrorPrefix}: ${String(err?.message || err)}`);
      return null;
    }
  }

  function renderPanelShell() {
    page.setPanelBody(`
      <div class="sqlcResultsBody">
        <div id="messageBox" class="sqlcMessage">Run a query to see results.</div>
        <div id="tableWrap" class="sqlcTableWrap"></div>
      </div>`);
  }

  function renderMessage(message, { error = false } = {}) {
    const box = $("messageBox");
    const wrap = $("tableWrap");
    if (wrap) wrap.textContent = "";
    if (!box) return;
    box.classList.toggle("error", !!error);
    box.style.display = "block";
    box.textContent = message;
  }

  function renderResults(result) {
    const box = $("messageBox");
    const wrap = $("tableWrap");
    const parts = [];
    if (result?.queryId) parts.push(`Query ${result.queryId}`);
    if (typeof result?.rowCount === "number") parts.push(`${result.rowCount} row${result.rowCount === 1 ? "" : "s"}`);
    if (result?.truncated) parts.push("truncated");
    page.setRunInfo(parts.join(" | "));

    if (!result?.ok) {
      renderMessage(result?.error || "Query failed.", { error: true });
      return;
    }
    const columns = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!columns.length) {
      const affected = Number(result?.rowsAffected);
      renderMessage(Number.isFinite(affected) && affected > 0
        ? `Query completed. ${affected} row${affected === 1 ? "" : "s"} affected.`
        : "Query completed with no result set.");
      return;
    }
    if (box) box.style.display = "none";
    if (!wrap) return;
    wrap.innerHTML = `
      <table class="sqlcTable">
        <thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((row) => `
            <tr>${columns.map((_, index) => `<td title="${escapeHtml(row?.[index])}">${escapeHtml(row?.[index])}</td>`).join("")}</tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  async function runQuery({ code, selectionOnly }) {
    const sql = String(code || "");
    if (!sql.trim()) {
      renderMessage("SQL is empty.", { error: true });
      return;
    }
    page.setRunning(true, "engine");
    page.setRunInfo("Running");
    page.setStatus(`Running ${engine.productName} ${selectionOnly ? "selection" : "query"}...`);
    try {
      const result = await fetchEngineJson(engine.routes.query, {
        method: "POST",
        body: JSON.stringify({ sql, connection: activeConnection, limit: QUERY_ROW_LIMIT }),
      });
      renderResults(result);
      page.setStatus(result?.ok ? "Query completed." : "Query failed.");
    } catch (err) {
      renderMessage(String(err?.message || err), { error: true });
      page.setStatus("Query failed.");
    } finally {
      page.setRunning(false);
    }
  }

  async function reconnect() {
    page.setStatus(`Reconnecting to ${engine.productName}...`);
    try {
      const result = await fetchEngineJson(engine.routes.reset, {
        method: "POST",
        body: JSON.stringify({ connection: activeConnection }),
      });
      page.setStatus(result?.message || `${engine.productName} connection reset.`);
    } catch (err) {
      page.setStatus(`Reconnect failed: ${String(err?.message || err)}`);
    }
  }

  const mode = {
    id: engine.id,
    tabType: engine.tabType,
    pageType: engine.pageType,
    defaultTitle: engine.defaultTitle,
    language: "sql",
    panelTitle: "Results",
    suggestedFileName: engine.suggestedFileName,
    fileFilters: [
      { name: "SQL Files", extensions: ["sql"] },
      { name: "All Files", extensions: ["*"] },
    ],
    restart: {
      label: engine.reconnectLabel,
      title: engine.reconnectTitle,
      run: () => reconnect(),
    },
    canRun: () => !!connections[activeConnection],
    run: ({ code, selectionOnly }) => runQuery({ code, selectionOnly }),
    clearPanel: () => renderMessage("Run a query to see results."),
    assistantContext: () => ({ sqlDialect: inferSqlDialect({ pageType: engine.pageType }) }),
    onReady: async (editorPage) => {
      page = editorPage;
      const lead = $("toolbarLead");
      if (lead) {
        lead.innerHTML = `<select id="connectionSelect" class="sqlcSelect" aria-label="${escapeHtml(engine.productName)} connection"></select>`;
        $("connectionSelect")?.addEventListener("change", (event) => {
          activeConnection = event.target.value || "";
          renderContextBar();
          page.updateCommandState();
        });
      }
      renderPanelShell();
      renderContextBar();
      // The shell owns profile editing, so the page reloads its picker instead
      // of holding a list that the dialog has already changed.
      page.onMessage((msg) => {
        if (msg?.type === "arcode:database-connections-changed") void reloadConnections();
      });
      await reloadConnections();
    },
  };

  return createEditorPage(mode);
}
