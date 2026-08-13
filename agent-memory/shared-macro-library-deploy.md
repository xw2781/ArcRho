---
name: shared-macro-library-deploy
description: Always publish all active repo macros to the shared server macro library (E:\ArcRho Server\shared\macros) after adding or editing any macro
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 90c9b468-e273-490b-a34f-ef077a04430a
  modified: 2026-07-31T17:55:12.438Z
---

Whenever any active macro in `python-api/macros` is added or edited (after the usual local deploy to `C:\Users\xwei.PRCINS\Documents\ArcRho\macros`), also publish the active macros to the official shared macro library.

**Why:** The user distributes macros to all ArcRho users through the server's shared library (`E:\ArcRho Server\shared\macros`, the app default resolved in `frontend/app_server/config.py`); the app's Macro Library window reads that folder and users copy macros locally from it.

**How to apply:** Run `python publish_macro_library.py` from `python-api/macros/` (Python 3.10). The script validates Version/Release Note headers, archives each replaced library copy under `archive/<stem>/<version>/`, replaces atomically, and skips unchanged files. This rule is codified in `AGENTS.md` (ArcRho Macro Source) and `python-api/macros/README.md` (as of 2026-07-31).

Note: on 2026-07-31 the user's local macro folder was intentionally emptied for a library-import test; the 13 prior local macros (including 10 not tracked in the repo, e.g. validate_notes.py, triangle_diagnostics.py) were preserved under `C:\Users\xwei.PRCINS\Documents\ArcRho\macros\archive\pre_library_test_20260731\`.
