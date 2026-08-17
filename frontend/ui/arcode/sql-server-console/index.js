import { createSqlConsole } from "../shared/sql_console.js?v=20260817a";
import { createConnectionsDialog } from "./connections.js?v=20260817a";

/**
 * SQL Server console: the shared SQL console pointed at the T-SQL routes, plus
 * the connection manager Snowflake does not have. Profiles live in
 * `%APPDATA%\Arcode\sql_server_connections.json` and are edited here.
 */
const SQL_SERVER_ENGINE = {
  id: "sqlserver",
  pageType: "sqlserver",
  productName: "SQL Server",
  sqlLabel: "T-SQL",
  defaultTitle: "SQL Server",
  routes: {
    connections: "/sqlserver/connections",
    query: "/sqlserver/query",
    test: "/sqlserver/test-connection",
  },
  connectorMissingStatus: "SQL Server support is not installed in this runtime.",
  connectionsErrorPrefix: "Could not load SQL Server connections",
  emptyConnectionsMessage: "No SQL Server connection is configured. Use Connections to add one.",
};

const sqlConsole = createSqlConsole(SQL_SERVER_ENGINE);
const connectionsDialog = createConnectionsDialog(sqlConsole);

connectionsDialog.init();
void sqlConsole.boot();
