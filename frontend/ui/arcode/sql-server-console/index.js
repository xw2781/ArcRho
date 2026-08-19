import { createSqlEditorPage } from "../shared/sql_mode.js?v=20260818a";

/**
 * SQL Server SQL editor: the generic editor framework in SQL mode, pointed at
 * the SQL Server engine. Its routes, wording, connection fields, and context
 * chips come from the engine descriptor in `shared/sql_engines.js`; profiles
 * are edited in the shell's Settings > Database Connections dialog.
 */
void createSqlEditorPage("sqlserver").boot();
