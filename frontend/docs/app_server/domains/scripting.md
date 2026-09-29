# Scripting intelligence

<!-- MANUAL:BEGIN -->
`app_server/services/scripting_intelligence.py` owns name resolution, callable
metadata, unfinished-call argument tracking, completion, and cell execution
semantics. `scripting_service.py` supplies the live namespace identified by
`X-Scripting-Session-Id`, keeping notebook sessions isolated.

Both full ArcRho and standalone Arcode expose `POST /scripting/complete`, using
the existing `{code, cursor_pos}` inspection request. The response carries
`signature` (or null), `active_parameter`, and `suggestions`. Completion resolves
names and dotted attributes from that session and Python built-ins, without
calling the function or executing the unfinished cell. Keyword suggestions and
signature parameter labels come from `inspect.signature`; functions without an
introspectable signature retain their docstring. `POST /scripting/inspect` shares
the same callable metadata and adds `parameters` to its existing response.

Both `/scripting/run` and `/scripting/run-stream` delegate source execution to
the same helper. A cell containing `?name`, `?module.name`, or `name?` prints the
available signature and full docstring, without calling the target or replacing
the last-expression `_` value. An unresolved name is an ordinary execution
error. Normal Python cells retain their final-expression display behavior.
Definitions and imports must already exist in the session; this is runtime
introspection, not static analysis of unexecuted cells.

No saved notebook schema or project-data transport changes.
The existing generic `read_json`/`read_csv` script helpers in
`scripting_service.py` still open user-supplied paths directly, including SMB
paths. Local-file access is part of their scripting purpose; project-data
access through these helpers should move to dedicated Gateway-backed helpers.
<!-- MANUAL:END -->
