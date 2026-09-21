# TODO

## Local test server root on the developer PC

**Goal.** Run a second, independent ArcRho Server root at `C:\Arco Server` on the developer PC (`L-H2MQ6280FVP`), so agents deploy and exercise server components there before anything touches production at `E:\ArcRho Server`. The developer PC is then both a client of production and the host of the test root.

**What the code already supports (found 2026-09-20).**

- The server root is resolved in one place, `python-api/src/arcrho_api/config.py`: in-process override, then `ARCRHO_SERVER_ROOT` / `ARCRHO_RUNTIME_SERVER_ROOT`, then `%APPDATA%\ArcRho\workspace_paths.json`, then the running desktop app, then the packaged default. Nothing needs the root to be called `ArcRho Server` or to sit on `E:`.
- Frozen server components derive their root from their own exe location under `<root>\apps\<App>\`, and every peer signal (heartbeats, request queues, kill switches, receipts) is root-relative. Two roots never collide on disk.
- `arcrho_server_deployer` takes `--root` and creates `apps`, `config`, `projects`, `requests`, `runtime`. `server-components/deploy.py` and every `build_exe.py` honour `ARCRHO_DEPLOY_ROOT`; on a local fixed disk the build script also starts the deployed exe.
- Project folders hold no absolute paths: projects are discovered by listing `<root>\projects`, and sidecars, indexes, and method JSON are addressed by name. A project can be copied between roots without rewriting.
- When the client's root changes through the Server Connection page, the app re-enrols with the Gateway named in `<root>\config\arcrho_gateway.json`, so the client picks up the test Gateway on its own.

**What does not carry over.**

- Only two components bind TCP ports: Gateway (28767) and Admin Control (28766). Production runs them on the Server PC, so a local set does not collide with production, but the test root's `arcrho_gateway.json` must advertise `client_url = http://127.0.0.1:28767` instead of the Server PC name.
- ResQ lives only on the Server PC, so the Bridge and every ResQ import or sync stay out of scope for the local root. Everything else (Engine jobs, Gateway reads and saves, propagation, duplication, rules and source refresh) runs locally.
- The test root has no Build Listener, so `deploy.py` cannot submit a request there. Use the documented fallback: run the component's `build_exe.py` with `ARCRHO_DEPLOY_ROOT=C:\Arco Server`, or deploy the Orchestrator and let it host the listener. Decide during step 3.
- `workspace_paths.json`, the client Gateway file, and renderer prefs are per machine, so flipping the Server Connection page to the test root also flips the production client on this PC. Agents should instead launch the dev-mode app with `ARCRHO_SERVER_ROOT` and `ARCRHO_GATEWAY_CONFIG` set, leaving the production client untouched.
- The desktop app's first-run auto-search scans drives D: to Z: for a folder named `ArcRho Server`; it will never find `C:\Arco Server`. Manual entry or the env var is fine; no code change.
- Being a local disk, `is_network_path` returns false, so file waits use the fast watcher path rather than the SMB cadence. Correctness is unchanged; SMB timing bugs will not reproduce locally.

**Steps.**

1. **Bootstrap tool** `tools/local_server_root.py init --root "C:\Arco Server"`. Runs the deployer's install/adopt for the folder layout, then seeds `config\` from production: `config.json` with `root` rewritten and the ResQ block dropped, `arcrho_gateway.json` with the local `client_url` and only the developer's user entry, `dataset_number_formats.json` and `username_index.*` copied as is. Idempotent; refuses to run when the root already holds `projects`. Check whether anything under `shared\python-api`, `shared\macros`, or `venvs` is read by the Engine or Gateway at run time and copy only what is.
2. **Project copy tool** `tools/local_server_root.py copy-project <name> [--overwrite]`. Straight folder copy of `E:\ArcRho Server\projects\<name>` into the local root, skipping `*.lock`, `.tmp*`, and temporary view caches. Add `--from` to copy back the other way only if a test result ever needs to be promoted; otherwise leave production write-free. Respect the project-data access rule: the default project is `NJ_Annual_Prod_202605_Fake`.
3. **Deploy Engine and Gateway locally** with `ARCRHO_DEPLOY_ROOT=C:\Arco Server` through each component's `build_exe.py`, then start them and check the heartbeats under `runtime\instances` and `GET http://127.0.0.1:28767/api/health`. Record the exact commands in `agent-instructions/component-deployment-authorization.md` as the test-first route.
4. **Client against the test root**: launch the dev-mode desktop app with `ARCRHO_SERVER_ROOT=C:\Arco Server` and `ARCRHO_GATEWAY_CONFIG=%APPDATA%\ArcRho\arcrho_gateway.local.json`. Verify enrolment happens under the env override too (today it is triggered by the Server Connection page); if it does not, add the enrolment call to startup when the env override is set. Open the copied project, save a method, run a rules save, and confirm the jobs land in the local `requests\` folders.
5. **Agent instructions**: add a short "Local test root" section to `AGENT_GUIDELINES.md` and the deployment authorization doc. Default order for a server-component change becomes deploy to the local root, verify, then deploy to production. The production deploy stays governed by the ship-impact rule below.
6. **Optional later**: a `pytest` fixture that builds a deployer-shaped root under `tmp_path` and replaces the per-test monkeypatching in `frontend/tests/dependent_propagation_workspace_stub.py`; and a Build Listener in the local root so `deploy.py` works unchanged.

**Effort.**

| Step | Size | Notes |
| :--- | :--- | :--- |
| 1 Bootstrap tool | half a session | deployer does the layout; the work is seeding `config\` correctly |
| 2 Copy tool | small | a filtered `copytree`; the Fake project is 5,514 files, 101 MB, so seconds over SMB |
| 3 Local deploy | half a session | commands exist; the cost is the first frozen build on this PC plus verification |
| 4 Client verification | half to one session | the enrolment-under-env-override question is the only likely code change |
| 5 Instructions | small | |
| Total | two to three agent sessions | steps 1 and 2 can run in one; 3 and 4 in another |

**Risks.** Anything the Engine or Gateway reads outside `projects\`, `config\`, `requests\`, `runtime\` (the `shared\` and `venvs\` folders) is unverified until step 1. Renderer prefs in `%APPDATA%\ArcRho\prefs` are shared between the production client and the test client on this PC.

## Ship-impact statement and deploy gate (done 2026-09-20)

Recorded in `agent-instructions/component-deployment-authorization.md`:

- Before code changes, agents state how a feature ships: frontend release only, server component redeploy only, or both in a given order, plus the concrete risk to users on the latest released app.
- The standing rebuild/redeploy authorization applies only when the released app cannot break. Otherwise the agent stops before building and reports what breaks and what release sequence is needed.
