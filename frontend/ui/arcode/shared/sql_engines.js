/**
 * The SQL engines Arcode can edit against, described once.
 *
 * Two surfaces read this: the SQL editor pages, which need the query routes,
 * the wording, and the connection fields their context bar shows, and the
 * shell's Database Connections dialog, which needs the same routes and the
 * profile form for each engine. Neither restates a route name, a field list,
 * or a product name of its own.
 */

/** Text escaping for the two surfaces below, so neither carries its own copy. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

/** Shared JSON transport for every engine call, so no caller rebuilds it. */
export async function fetchEngineJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || payload?.detail || `Request failed: ${response.status}`);
  return payload;
}

const SNOWFLAKE = {
  id: "snowflake",
  tabType: "snowflake",
  pageType: "snowflake",
  productName: "Snowflake",
  sqlLabel: "Snowflake SQL",
  defaultTitle: "Snowflake SQL",
  routes: {
    connections: "/snowflake/connections",
    save: "/snowflake/connections",
    delete: "/snowflake/connections/delete",
    query: "/snowflake/query",
    test: "/snowflake/test-connection",
    reset: "/snowflake/reset-connection",
  },
  // A Snowflake session is cached per profile, so Reconnect ends it and the
  // next Run opens a new one without the previous session's temporary tables.
  reconnectLabel: "Reconnect",
  reconnectTitle: "Close the Snowflake session, dropping its temporary tables",
  // A new file is named so that reopening it routes back to this editor.
  suggestedFileName: "query.snowflake.sql",
  connectorMissingStatus: "Snowflake connector is not installed in this runtime.",
  connectionsErrorPrefix: "Could not load Snowflake connections",
  emptyConnectionsMessage: "No Snowflake connection profile is configured. Use Settings > Database Connections to add one.",
  supportsDefaultConnection: false,
  contextFields: [
    { keys: ["role"], label: "Role" },
    { keys: ["warehouse"], label: "Warehouse" },
    { keys: ["database"], label: "Database" },
    { keys: ["schema", "schema_name"], label: "Schema" },
  ],
  profileFields: [
    { key: "name", label: "Connection Name", type: "text" },
    { key: "account", label: "Account", type: "text", placeholder: "org-account" },
    { key: "user", label: "User", type: "text" },
    {
      key: "authenticator",
      label: "Authenticator",
      type: "select",
      options: [
        { value: "externalbrowser", label: "External Browser (SSO)" },
      ],
    },
    { key: "role", label: "Role", type: "text" },
    { key: "warehouse", label: "Warehouse", type: "text" },
    { key: "database", label: "Database", type: "text" },
    // A stored profile names this `schema`, but `schema` is reserved on the
    // request model, so the save request carries it as `schema_name`.
    { key: "schema", label: "Schema", type: "text", wireKey: "schema_name" },
  ],
  formHint: "Sign-in uses your browser. No password is stored.",
};

const SQL_SERVER = {
  id: "sqlserver",
  tabType: "sqlserver",
  pageType: "sqlserver",
  productName: "SQL Server",
  sqlLabel: "T-SQL",
  defaultTitle: "SQL Server",
  routes: {
    connections: "/sqlserver/connections",
    save: "/sqlserver/connections",
    delete: "/sqlserver/connections/delete",
    query: "/sqlserver/query",
    test: "/sqlserver/test-connection",
    reset: "/sqlserver/reset-connection",
  },
  reconnectLabel: "Reconnect",
  reconnectTitle: "Start the next Run on a fresh SQL Server connection",
  suggestedFileName: "query.mssql.sql",
  connectorMissingStatus: "SQL Server support is not installed in this runtime.",
  connectionsErrorPrefix: "Could not load SQL Server connections",
  emptyConnectionsMessage: "No SQL Server connection is configured. Use Settings > Database Connections to add one.",
  supportsDefaultConnection: true,
  contextFields: [
    { keys: ["server"], label: "Server" },
    { keys: ["database"], label: "Database" },
    { keys: ["authentication"], label: "Authentication" },
  ],
  profileFields: [
    { key: "name", label: "Connection Name", type: "text" },
    { key: "server", label: "Server", type: "text", placeholder: "host\\instance" },
    { key: "database", label: "Database", type: "text" },
    {
      key: "authentication",
      label: "Authentication",
      type: "select",
      options: [
        { value: "windows", label: "Windows Authentication" },
      ],
    },
  ],
  formHint: "Queries run as your Windows account. No password is stored.",
};

export const SQL_ENGINES = [SQL_SERVER, SNOWFLAKE];

export function getSqlEngine(engineId) {
  return SQL_ENGINES.find((engine) => engine.id === String(engineId || "").trim()) || null;
}

/** First non-empty profile value among the keys a context chip may use. */
export function profileFieldValue(profile, keys) {
  for (const key of keys || []) {
    const value = String(profile?.[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}
