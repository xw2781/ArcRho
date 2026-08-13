---
name: arcrho-local-release-build
description: Release ArcRho from the PC holding the repo with build_app_from_local_repo.bat; it builds in place so the bookkeeping lands in the working tree
metadata:
  node_type: memory
  type: project
  originSessionId: 05c09575-2234-4404-bf4e-fcede99def6e
  modified: 2026-08-13T18:54:05.703Z
---

Since 2026-08-13 there are two release routes, and both run the same build body in
`frontend\build\build_app_via_local_workspace.bat`:

- `frontend\build\build_app_from_local_repo.bat` — one PC, no ZIP, no build share, no
  listener. Run `--check` first; it validates everything and builds nothing.
- `BUILD_FROM_ZIP_ON_SECOND_PC.md` — the original two-PC ZIP workflow, unchanged. Use it when
  the PC holding the repo cannot run the toolchain.

The local route sets `ARCRHO_BUILD_IN_PLACE=1`, which makes the wrapper skip the ZIP wait and
the workspace extraction and build against the repo's own `frontend`. The consequence worth
remembering: **the build writes into the working tree**. `package.json`, `package-lock.json`,
`ui\index.html`, `ui\splash.html`, `docs\releases\<version>.md`, and
`changes\unreleased` → `changes\archive\<version>` all change as the build runs. That is why
there is no sync-back step — `sync_published_release.py --bookkeeping-only` just refreshes the
docs index and commits those paths. A build that fails after the version step leaves the bump
behind; `git checkout --` the four version files to undo it.

Two prerequisites bite on the client PC (see [[dev-pc-and-client-pc-identity]]):

- `frontend\node-portable\codex.cmd` was **missing** here as of 2026-08-13, which fails the
  ArcBot runtime smoke that is the build's very first step. `node-portable` is not in Git.
  Fix with `frontend\build\arcbot_runtime\refresh_bundled_codex_runtime.ps1`. The `--check` mode runs this
  same smoke, so it catches the gap in seconds instead of after a version bump.
- `PYTHON_API_PACKAGE_DIR` defaults to `E:\ArcRho Server\packages`, which is a mapped drive
  onto the Dev PC, so an ArcRho build still needs that machine up. Override the variable to
  build without it; Arcode does not publish the wheel at all.

`gh` must be authenticated: the version step derives the next version from the GitHub Releases
history and deliberately fails rather than falling back to `package.json`.

Build contracts are pinned by `frontend\tests\bundled_codex_runtime.test.mjs` — edit a build
script and run that file. Note test 4 fails on this PC purely because of the missing
`codex.cmd` above, not because of any change.
