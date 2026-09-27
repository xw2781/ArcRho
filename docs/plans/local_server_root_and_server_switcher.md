# Local Server Root and Server Switcher

Status: Step 1 done 2026-09-26 — a private test server runs on the developer PC at `C:\Arco Server` beside production, with its own Gateway, credential and app profile, built from the working tree by `tools/local_server.py`. Steps 2-6 (server profiles, server identity, the switcher in the app, the active-server badge, the release) are planned and not started; offline use for every user is recorded as a direction with open decisions, not yet broken into steps.
Last updated: 2026-09-26
Related: [client_smb_retirement.md](client_smb_retirement.md) (the first work tested this way), [hosted_workspace_http_transport.md](hosted_workspace_http_transport.md)

**How this ships.** Step 1 changed only tools, docs and two launch-time switches in the desktop host that do nothing unless a launch sets them; it reaches users with the next frontend release and needs no server deploy. Steps 2 and 4-5 are frontend-release changes. Step 3 adds a field to the Gateway's capability answer, an additive server deploy that must land before the frontend release that checks it.

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | A private test server runs on the developer's PC beside production | [x] | 2026-09-26 | 90 min | not clocked | The developer can build, deploy and try server changes on their own PC; nobody else sees them. |
| 2 | The app remembers more than one server, each with its own sign-in | [ ] | | 70 min | | |
| 3 | The app refuses a server whose address and data folder do not belong together | [ ] | | 55 min | | |
| 4 | Switch servers from Server Connection, shown by name and address | [ ] | | 80 min | | |
| 5 | The window shows which server it is using whenever it is not production | [ ] | | 30 min | | |
| 6 | Deploy the server side and ship the app | [ ] | | 30 min | | |

Overall: 1 of 6 steps done. Estimated 355 min; step 1 was not clocked.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in the [plans index](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

## The local test root (in use)

A second, independent server root on the developer PC. Production (`E:\ArcRho Server`, the Server PC share) is never written by it.

```
py -3.10 tools/local_server.py init                  # folders, config, local Gateway registry, credential, Orchestrator
py -3.10 tools/local_server.py copy-project          # NJ_Annual_Prod_202605_Fake by default; --overwrite to refresh
py -3.10 tools/local_server.py deploy                # build Engine + Gateway from this working tree into the local root
py -3.10 tools/local_server.py start | stop | status
py -3.10 tools/local_server.py launch-app            # dev-mode app against the local root
```

What keeps it apart from production:

| Concern | How it is kept apart |
| :--- | :--- |
| Server data | Every component finds its root from where its exe sits, and heartbeats, request queues, receipts and kill switches are all under the root. The tool refuses a root that is a network path, not on a local fixed disk, or the production root. |
| Builds | `deploy` sets both `ARCRHO_DEPLOY_ROOT` and `ARCRHO_ROOT` to the local root and drops every inherited root override. Without `ARCRHO_ROOT` the Engine and Orchestrator builds look for their kill switches under the repository instead. |
| Network | The local Gateway registry binds `127.0.0.1:28767`, written before the Gateway first starts. Left to itself the Gateway writes a registry bound to every interface. |
| Sign-in | The local credential is `%APPDATA%\ArcRho\arcrho_gateway.local.json`. The production credential `arcrho_gateway.json` is untouched, and so are the Excel add-in and scripts, which always use it. |
| The app | `launch-app` sets `ARCRHO_SERVER_ROOT`, `ARCRHO_GATEWAY_CONFIG`, a separate Electron profile (`ARCRHO_USER_DATA_DIR`, so it never reuses a running app's backend) and backend port 28785. ArcBot follows `ARCRHO_SERVER_ROOT` too. |
| ResQ | Not available: ResQ lives only on the Server PC. The local root never starts a Bridge, so ResQ import, export and sync are production-only. |
| Components | Engine and Gateway are built from the working tree. The Orchestrator is copied from production by `init`; it starts the Engines and the Gateway and cleans stale heartbeats. `stop` uses the root's kill switches, never a process kill, so nothing on another root is touched. |

Known limits, none of which writes to production:

- A copied project still names the production share as its **import source** (`field_mapping.json`, `source/source_import.json`), so a source refresh on the local root reads production's source files. It never writes there.
- Five project-level caches store absolute `E:\ArcRho Server` paths; on the local root they miss and rebuild the first time they are read.
- `%APPDATA%\ArcRho\prefs`, `app_endpoint.json` and the logs under `%LOCALAPPDATA%\ArcRho\logs` are shared by every app on the PC. A macro or notebook run outside the app finds "the running app" through `app_endpoint.json`, whichever app wrote it last.
- `arcrho_api.gateway` (scripts and notebooks) always signs with the production credential; it ignores `ARCRHO_GATEWAY_CONFIG` until step 2.
- Ports are per machine, so one local root runs at a time.
- There is no Build Listener for the local root; `deploy` runs the build scripts directly, which is fast on a local disk.
- Never save the Server Connection page in a `launch-app` session. It writes the per-machine `workspace_paths.json` that the production app also reads.

## Why a switcher, and what the investigation found (2026-09-26)

Changing the root on the Server Connection page today is unsafe for anything but production:

- **The Gateway does not follow the root.** Enrollment returns "existing" whenever a credential file exists (`python-api/src/arcrho_api/hosted_save_enrollment.py`, `enroll_once`). After switching the root to another server, hosted reads, saves and calculations still go to the old Gateway while share-only routes use the new folder. The client never checks which root a Gateway serves.
- **Two resolvers.** `arcrho_api/config.py` owns root resolution, but `frontend/app_server/config.py` has its own reader and writer of `workspace_paths.json` with a different order, and `arcrho_api` caches the file value at import and never reloads it, so macros keep the old root until the backend restarts.
- **Pages keep the old server.** A switch posts a message to open tabs; Project Instance and Home ignore it.
- **The server is shown nowhere** but the dialog's path field: not in the status bar, title bar or About box.
- **Profiles need a path for now.** Until retirement-plan steps 11, 18 and 20 land, many features still read the share, so a server entry must carry its folder as well as its address.

## Open decisions

1. **What the app shows as the server's identity.** Recommended: the profile name and its Gateway address, for example `Production — NE7SASWPN02:28767` and `Local test — 127.0.0.1:28767`, with the folder path in a details section. A custom `arco://` scheme reads well but is not a real address and cannot be pasted into a browser for a health check.
2. **Switching restarts the app server, not the window.** Recommended, because it clears every per-process cache and the stale `arcrho_api` root in one step. The alternative, a live switch, needs every page to handle the change message, and two do not today.
3. **Offline use for every user** (not broken into steps yet). The installer already detects a local root and can start the Launcher at login; the missing pieces are shipping the Gateway and Credential in the server payload, seeding a loopback Gateway registry and enrolling the installing user, making the Bridge optional, and — the large one — moving projects between the user's PC and production. Recommended scope for a first version: **a local sandbox**. The user copies a project down and works on it freely, and nothing is pushed back. True offline editing with sync-back needs a conflict rule per file kind and is a separate plan.

## Suggestions

- **Give every server an identity.** Put a `server_id` (a GUID written once) in `<root>\config\config.json` and return it from the Gateway's `/api/capabilities`. The client stores it in the profile and refuses a Gateway whose id does not match the folder it is pointed at. This closes the mixed-server hazard for good, and it is what makes a URL-only profile safe after SMB retirement. It is step 3.
- **One credential per server.** Derive the credential file from the profile id (`arcrho_gateway.json` for production, `arcrho_gateway.<id>.json` otherwise) instead of storing it, and route every reader — app server, `arcrho_api.gateway`, the credential helper — through one helper. The Excel add-in stays tied to the server it was installed from.
- **Show the active server.** A small badge in the title bar whenever the active server is not production, so a test session is never mistaken for real work.
- **Keep `workspace_root` at the top of `workspace_paths.json`.** The installer and the running-app probe read that field, so a profile list must mirror the active root into it.
- **Grow the dev control center.** `tools/arcrho_dev_control` could show the local root's heartbeats and run `deploy`, `start` and `stop`, as it already does for the dev app.
- **Test the SMB retirement against the local root first.** Each deploy step in that plan becomes "deploy locally, check, then deploy to production".

## Rough size

Estimated 355 minutes across 6 steps: 220 minutes of code edit and 135 of test, validation and deploy. Step 1 is done. Offline use for every user is not estimated until decision 3 is taken.

## Plan

### Step 1 — Local test root (done 2026-09-26)

**Goal.** A private server root on the developer PC that server components can be built into and the dev app pointed at, without touching production.

**Do.**
- [x] `tools/local_server.py` with `init`, `copy-project`, `deploy`, `start`, `stop`, `status` and `launch-app`, and its tests in `tools/tests/test_local_server.py`.
- [x] `ARCRHO_USER_DATA_DIR` in `frontend/electron/main.js`, so a second dev app has its own Electron profile and backend.
- [x] ArcBot follows `ARCRHO_SERVER_ROOT` (`frontend/electron/arcbot_host.js`).
- [x] Stand up `C:\Arco Server`, copy the Fake project, build Engine and Gateway, check heartbeats and health.
- [x] "Local test root" in `AGENT_GUIDELINES.md` and the deployment authorization doc.

**Done when.** `status` shows a live Orchestrator, Engine and Gateway, and the Gateway health check answers on `127.0.0.1:28767`.

Estimate: code edit 55 min, test/validation 35 min, total 90 min. Actual: not clocked; it was done in the same session as the audit.

### Step 2 — Server profiles

**Goal.** The app keeps a list of servers, one active, each with its own folder, address and credential; one module owns it.

**Read first.** `python-api/src/arcrho_api/config.py` (`get_server_root`, the workspace-paths reader and writer); `frontend/app_server/config.py` (`load_workspace_paths`, `save_workspace_paths`, `get_gateway_config_path`); `python-api/src/arcrho_api/gateway.py`; `frontend/app_server/api/workspace_paths_router.py`.

**Do.**
- [ ] `profiles` and `active_profile` in `workspace_paths.json`, owned by `arcrho_api.config`; the active root mirrored into `workspace_root`. With no `profiles` key, one `default` profile is built in memory from today's file and nothing is written.
- [ ] One credential-path helper in `arcrho_api.config`: `ARCRHO_GATEWAY_CONFIG`, then the active profile. `app_server/config.py` and `arcrho_api/gateway.py` use it.
- [ ] `app_server/config.py` delegates its reader and writer to `arcrho_api.config` and drops its own.
- [ ] `GET /server_profiles`, `POST /server_profiles`, `POST /server_profiles/activate` (activate then asks for the existing app restart).

**Tests.** Migration from today's file writes nothing; env overrides still win; each profile resolves its own credential.

**Done when.** Two profiles can be stored and activated from the API, and each activation uses its own credential.

Estimate: code edit 50 min, test/validation 20 min, total 70 min.

### Step 3 — Server identity

**Goal.** A server says which one it is, and the client refuses a Gateway that serves a different root from the one it is pointed at.

**Read first.** `server-components/src/server_config.py`; the capabilities handler in `server-components/src/arcrho_gateway/main.py`; `frontend/app_server/services/workspace_read_client.py` (`cached_gateway_capabilities`).

**Do.**
- [ ] `server_id` written once into `config.json` by `ensure_server_config`.
- [ ] `/api/capabilities` returns it (additive).
- [ ] The client compares it with the active root's `config.json` and refuses with a plain message on mismatch.

**Tests.** Mismatch refused; a Gateway that sends no id is refused on a Client PC once this ships (all users run the latest version).

**Done when.** Pointing the app at the local folder with the production credential is refused rather than served.

Estimate: code edit 35 min, test/validation 20 min, total 55 min.

### Step 4 — The switcher on the Server Connection page

**Goal.** The user picks a server by name and address, adds one by choosing its folder, and switching restarts the app server.

**Read first.** `frontend/ui/shell/root_path_settings.js`; the dialog in `frontend/ui/index.html`; `frontend/ui/shell/app_lifecycle.js` (restart and reload); skill `arcrho-ui-design`.

**Do.**
- [ ] One row per profile: name, address, a health dot from `/api/health`, the active one marked.
- [ ] Add server: pick the folder; the address fills in from the folder's Gateway registry; the name is editable.
- [ ] A details section with the folder, credential file and user.
- [ ] Switching is blocked while any tab has unsaved changes; an env override shows the server as "set at launch" and read-only.
- [ ] Bump the `?v=` stamps and the tests that pin them.

**Tests.** Node tests for the list, add and blocked switch.

**Done when.** The developer switches between production and the local root from the app and back, and each side's saves land on its own server.

Estimate: code edit 55 min, test/validation 25 min, total 80 min.

### Step 5 — Active-server badge

**Goal.** The title bar shows the server's name whenever it is not production.

**Read first.** The title bar in `frontend/ui/index.html` and its shell script; `GET /workspace_paths`.

**Do.**
- [ ] `GET /workspace_paths` returns the active profile's name and whether it is the default.
- [ ] A small badge in the title bar when it is not.

**Tests.** Node test for the badge.

**Done when.** A `launch-app` session and a switched session both show the badge; production shows none.

Estimate: code edit 20 min, test/validation 10 min, total 30 min.

### Step 6 — Deploy and release

**Goal.** Production's Gateway reports its identity, then the app that checks it ships.

**Do.**
- [ ] Deploy to the local root and check; then `python server-components/deploy.py`.
- [ ] Release fragment for the switcher and the badge; the frontend release follows the server deploy.

**Done when.** Production's `/api/capabilities` carries `server_id` and the released app switches servers.

Estimate: code edit 5 min, test/validation 25 min, total 30 min.
