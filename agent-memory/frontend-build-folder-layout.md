---
name: frontend-build-folder-layout
description: frontend/build keeps the six runnable scripts at the top level and helpers in subfolders; moving a build script requires fixing its own path anchor
metadata:
  node_type: memory
  type: project
  originSessionId: 05c09575-2234-4404-bf4e-fcede99def6e
  modified: 2026-08-13T18:54:22.306Z
---

Reorganized 2026-08-13. `frontend\build\README.md` is the index — read it before hunting for a
build script.

Top level holds only what a human runs: `build_app_from_local_repo.bat`,
`build_app_via_local_workspace.bat`, `change_app_version.bat`, `create_build_source_zip.bat`,
`deploy_build_share.bat`, `sync_published_release.bat`. Helpers live in `docs/`, `installer/`,
`release/`, `transport/`, `arcbot_runtime/`, `helpers/`, plus the pre-existing `build_share/`
and `python_packages/`.

Three traps learned while doing it, which apply to any further move:

1. **Self-anchoring paths.** Several helpers derive the frontend root from their own location
   (`Path(__file__).resolve().parents[2]`, `path.resolve(__dirname, "..", "..")`,
   `Join-Path $scriptDir "..\..\.."`). Move one a level deeper without fixing its anchor and it
   silently resolves to `build\` instead of `frontend\` — no error, just wrong paths.
2. **`.gitignore` collisions.** The root `.gitignore` ignores a bare `runtime/` for engine
   state, which swallowed a `build\runtime\` subfolder: `git add` refused it while the sibling
   folders added fine, so a commit would have recorded the deletions and dropped the files.
   The folder is named `arcbot_runtime` to dodge that. Check any new folder name with
   `git add -An <dir>` — `git check-ignore -v` on a directory reports misleading empty-pattern
   matches here.
3. **PyInstaller stays put.** `server.spec`, `arcode_server.spec`, `server_entry.py`,
   `arcode_server_entry.py`, the two python-server bats, `check_python_build_env.py`, and
   `write_backend_artifact_manifest.py` were deliberately left at the top level: the entry
   modules resolve `BASE_DIR` at runtime inside the frozen app, so a path mistake there ships
   to users instead of failing the build.

`transport\create_build_source_zip.ps1` carries the authoritative list of every required build
input. Running it with `-Check` verifies all of them exist and is the fastest way to prove a
layout change did not break the two-PC build. See [[arcrho-local-release-build]].
