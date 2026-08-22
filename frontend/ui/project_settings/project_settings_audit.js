import {
  clearTableSkeletonRows,
  renderTableSkeletonRows,
} from "./project_settings_skeleton.js?v=20260821pstree1";

export class AuditLogStore {
  constructor(options = {}) {
    this.auditLogBody = options.auditLogBody || null;
    this.auditLogStatus = options.auditLogStatus || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.initTableColumnResizing = options.initTableColumnResizing || null;
    this.loadSeq = 0;
    this.byProject = new Map();
    this.loadedProjects = new Set();
  }

  normalizeProjectKey(name) {
    return String(name || "").trim().toLowerCase();
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  getProjectState(projectName) {
    const key = this.normalizeProjectKey(projectName);
    if (!this.byProject.has(key)) {
      this.byProject.set(key, {
        columns: ["Timestamp", "User", "Action"],
        rows: [],
      });
    }
    return this.byProject.get(key);
  }

  setStatus(msg, isError = false) {
    if (!this.auditLogStatus) return;
    this.auditLogStatus.textContent = msg || "";
    this.auditLogStatus.classList.toggle("error", !!isError);
  }

  /** Flowing placeholder rows while the log is read from the project folder. */
  renderLoading() {
    renderTableSkeletonRows(this.auditLogBody, { columns: 3 });
  }

  renderEmpty(message) {
    if (!this.auditLogBody) return;
    clearTableSkeletonRows(this.auditLogBody);
    this.auditLogBody.innerHTML = `
      <tr>
        <td colspan="3" class="dataset-types-empty">${this.escapeHtml(message || "No audit log entries.")}</td>
      </tr>
    `;
  }

  normalizePayload(payload) {
    const fallback = {
      columns: ["Timestamp", "User", "Action"],
      rows: [],
    };
    if (!payload || typeof payload !== "object") return fallback;

    const rawCols = Array.isArray(payload.columns) ? payload.columns : fallback.columns;
    const columns = rawCols.map((v) => String(v ?? "").trim()).filter(Boolean);
    const effectiveCols = columns.length ? columns : fallback.columns;
    const width = Math.max(3, effectiveCols.length);

    const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
    const rows = [];
    for (const raw of rawRows) {
      if (!Array.isArray(raw)) continue;
      const row = [];
      for (let i = 0; i < width; i++) row.push(String(raw[i] ?? ""));
      if (row.some((v) => String(v).trim() !== "")) rows.push(row);
    }
    return { columns: effectiveCols.slice(0, 3), rows };
  }

  renderTable(projectName) {
    if (!this.auditLogBody) return;
    if (!projectName) {
      this.renderEmpty("Select a project to load audit log.");
      return;
    }
    const state = this.getProjectState(projectName);
    const rows = Array.isArray(state.rows) ? state.rows : [];
    if (!rows.length) {
      this.renderEmpty("No audit records yet.");
      return;
    }

    clearTableSkeletonRows(this.auditLogBody);
    this.auditLogBody.innerHTML = "";
    for (const raw of rows) {
      const tr = document.createElement("tr");
      const ts = String(raw[0] ?? "");
      const user = String(raw[1] ?? "");
      const action = String(raw[2] ?? "");
      for (const value of [ts, user, action]) {
        const td = document.createElement("td");
        const text = document.createElement("div");
        text.className = "rct-cell-text";
        text.textContent = value;
        td.appendChild(text);
        tr.appendChild(td);
      }
      this.auditLogBody.appendChild(tr);
    }
    if (typeof this.initTableColumnResizing === "function") {
      this.initTableColumnResizing("auditLogTable", [150, 110, 260]);
    }
  }

  async ensureLoaded(projectName) {
    const key = this.normalizeProjectKey(projectName);
    if (!key) return false;
    if (this.loadedProjects.has(key)) return true;

    const state = this.getProjectState(projectName);
    try {
      const res = await this.fetchImpl(`/audit_log?project_name=${encodeURIComponent(projectName)}&limit=2000`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const out = await res.json();
      const parsed = this.normalizePayload(out?.data);
      state.columns = [...parsed.columns];
      state.rows = parsed.rows.map((r) => r.map((v) => String(v ?? "")));
      this.loadedProjects.add(key);
      return true;
    } catch (err) {
      this.setStatus(`Load error: ${err.message}`, true);
      state.columns = ["Timestamp", "User", "Action"];
      state.rows = [];
      return false;
    }
  }

  async load(projectName, force = false) {
    const requestSeq = ++this.loadSeq;
    if (!projectName) {
      this.renderEmpty("Select a project to load audit log.");
      this.setStatus("");
      return;
    }
    const key = this.normalizeProjectKey(projectName);
    if (force) this.loadedProjects.delete(key);

    this.setStatus("Loading audit log...");
    // A cached log renders in the same tick; only a real read needs the frame.
    if (!this.loadedProjects.has(key)) this.renderLoading();
    const loadedOk = await this.ensureLoaded(projectName);
    if (requestSeq !== this.loadSeq) return;
    this.renderTable(projectName);
    if (loadedOk) this.setStatus("");
  }

  async append(projectName, action) {
    const name = String(projectName || "").trim();
    const desc = String(action || "").trim();
    if (!name || !desc) return false;
    try {
      const res = await this.fetchImpl("/audit_log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: name,
          action: desc,
        }),
      });
      if (!res.ok) return false;
      await this.load(name, true);
      return true;
    } catch {
      return false;
    }
  }
}
