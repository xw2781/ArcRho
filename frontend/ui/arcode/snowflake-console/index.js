import { createSqlEditorPage } from "../shared/sql_mode.js?v=20260818a";

/**
 * Snowflake SQL editor: the generic editor framework in SQL mode, pointed at
 * the Snowflake engine. Its routes, wording, connection fields, and context
 * chips come from the engine descriptor in `shared/sql_engines.js`.
 */
void createSqlEditorPage("snowflake").boot();
