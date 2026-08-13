# Memory Index

- [Agent memory lives in the repo](agent-memory-in-repo.md) — memories are tracked in agent-memory/ and reach the harness path through a directory junction created by tools/link_agent_memory.ps1
- [Shared macro library deploy rule](shared-macro-library-deploy.md) — after editing any active macro, publish all active macros to E:\ArcRho Server\shared\macros via publish_macro_library.py
- [Bridge restart after deploy](bridge-restart-after-deploy.md) — after build_exe.py check apps.bridge.auto_create_instance (flips over time); if false, Start-Process the exe manually; bridges are per user session since 2026-08-07
- [ResQ COM probe](resq-com-probe.md) — read-only ResQ COM debugging via arcrho_bridge venv python + ResQ3Automation.ResQApplication
- [Dev UI cache and restart](arcrho-dev-ui-cache-restart.md) — in-app restart can't pick up frontend/ui edits; ARCRHO_UI_VERSION is pinned per supervisor, and ?v= must be bumped in every importer
- [Theme CSS version pins](theme-css-version-pins.md) — bumping dark/high_contrast ?v= requires updating the pinned stamps in color_theme.test.mjs (splash, dfm, shared high-contrast stamp)
- [Launching ArcRho detached](arcrho-launch-electron-detached.md) — use Win32_Process.Create + start_electron.bat; poll app_ui_ready.json (written once); crash logs in %APPDATA%\arcrho-electron\logs
- [Frontend node test suite](frontend-node-test-suite.md) — run with node-portable + glob; 4 tests already fail at HEAD, baseline via git worktree before blaming a change
- [Python test runner](python-test-runner.md) — no interpreter here has pytest; pip install --target into a repo-local .pytest-tools, and 6 python-api tests already fail at HEAD
- [DFM save propagation profile](dfm-save-propagation-profile.md) — dependent propagation is ~80% of DFM save I/O; offline profiling harness technique and data-engine offload feasibility notes (2026-08-06)
- [ResQ PercentageDevelopedType enum](resq-percentage-developed-enum.md) — 4 codes incl. pdCumDevFactorsAdjusted=3; typelib constants via gencache; GetCapeCodeMethod for full CC objects
- [Project duplication diagnostics](project-duplication-diagnostics.md) — the UI error is redacted by contract; read status JSON history (varying vs fixed stop point) and runtime\logs\project_duplication.log
- [Macro method-notes persistence](macro-method-notes-persistence.md) — method notes cross payload flows only via the transient `method metadata.method notes` carrier; macro→Notes-tab wiring added 2026-08-12, Save persists to sidecar
