# Agent Project Data Access

Agents may view on-disk metadata JSON files under `E:\ArcRho Server\projects` only for project `NJ_Annual_Prod_202605_Fake` by default.

Do not read metadata JSON files on disk for any other ArcRho Server project unless the user gives explicit permission for that project in the current session.

If a user references another ArcRho Server project without giving session-specific permission to read its on-disk metadata JSON files, ask for that permission or ask the user to provide the needed excerpts directly in the chat.

When inspecting sidecars, method JSON, dataset JSON, or related migration/refactor issues and the request does not explicitly specify a reserving-class data path, use `E:\ArcRho Server\projects\NJ_Annual_Prod_202605_Fake\data\PRNJ - PA_%5C_PA_%5C_All States_%5C_Direct Group_%5C_COL` as the default ArcRho Server data folder.

This restriction applies to agent tool use and analysis only; it does not change runnable scripts that a human may execute, such as `python-api/resq_data_migration.py`.
