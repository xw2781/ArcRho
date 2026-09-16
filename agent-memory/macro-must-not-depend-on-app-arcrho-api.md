---
name: macro-must-not-depend-on-app-arcrho-api
description: A macro imports arcrho_api from the installed app's build, so a macro change must never depend on an arcrho_api change made in the same turn
metadata:
  type: project
---

Macros in `python-api/macros` run inside the installed ArcRho app and import
`arcrho_api` from the wheel the app was built with
(`%LOCALAPPDATA%\Programs\ArcRho\resources\python_packages\arcrho_api-*.whl`),
not from this checkout. `publish_macro_library.py` ships the macro file and the
ResQ migration support bundle only — it does not ship `arcrho_api`, which
reaches users solely through a full app build.

So a published macro at its new version can still produce the old result: it
called a shared helper the installed app has an older copy of. This happened on
2026-09-16 with "Generate Notes for Combined Adjustment" v1.7.0, which delegated
the growth-basis wording to `adjustment_description` and kept writing
`growth adjustment--counts`; v1.7.1 brackets the basis in the macro itself.

**Why:** the macro library and the app release on different cadences, so the
macro is the only half of the pair a user picks up immediately.

**How to apply:** put the behaviour a macro owns in the macro file, even when a
similar helper exists in `arcrho_api`; call `arcrho_api` only for long-stable
things. When a shared contract genuinely has to change, change `arcrho_api` for
the reading side, still have the macro produce the new output on its own, and
say the reading side is live only after the next app build. Test the macro with
the shared helper swapped for its older implementation. Written up in
"A macro must stand on its own" in `python-api/macros/README.md` and in
[[all-users-run-latest-app-version]] territory — note that rule is about the
*app*, and macros move ahead of it. See also [[shared-macro-library-deploy]].
