import { createSqlConsole } from "../shared/sql_console.js?v=20260817a";

/**
 * Snowflake console: the shared SQL console pointed at the Snowflake routes.
 * Connection profiles come from `%APPDATA%\Arcode\snowflake_connections.json`
 * and are picked here, not edited here.
 */
const SNOWFLAKE_ENGINE = {
  id: "snowflake",
  pageType: "snowflake",
  productName: "Snowflake",
  sqlLabel: "Snowflake SQL",
  defaultTitle: "Snowflake SQL",
  routes: {
    connections: "/snowflake/connections",
    query: "/snowflake/query",
    test: "/snowflake/test-connection",
  },
  connectorMissingStatus: "Snowflake connector is not installed in this runtime.",
  connectionsErrorPrefix: "Could not load Snowflake connections",
  emptyConnectionsMessage: "No Snowflake connection profile is configured.",
};

void createSqlConsole(SNOWFLAKE_ENGINE).boot();
