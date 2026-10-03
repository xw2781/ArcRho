# Arco screenshot user guide

Choose **Help → User Guide** in Arco. The app reads its current server profile and opens that Gateway's `/user-guide/` URL in the browser. For an offline copy, open [index.html](index.html) and keep this entire folder together.

All 15 chapters use the same screenshot format, navigation, accessible image viewer, and responsive layout. The user-facing term is **Project Page**; the existing `project-instance.html` filename remains a stable link. Obsolete `manual.css` and `manual.js` have been removed.

## Content and screenshot ownership

The chapter HTML owns the instructions and captions. Current application controls under `ui/project_instance` and `ui/method_pages/dfm`, together with their domain docs, own the behavior being described. `guide.js` derives chapter navigation and each page's contents links, and progressively adds image enlargement and step controls. There are no remote assets or dependencies. All walkthrough figures remain readable without JavaScript and in print.

The PNGs in `assets/monthly-insurance/` are direct region captures of the real application GUI taken on 2026-10-03 using `tools/agent_screen_control/agent_screen_control.ps1`. They contain no reconstructed controls, substituted pixels, or generated artwork. DFM images were recaptured after the user restored the default table colors. Captures omit personal account details, unrelated project tabs, and the agent-control overlay. The step viewer uses real before/after screenshots instead of an autoplaying GIF. Chapters reuse the same image when they refer to the same UI state.

## Demo preparation

The user authorized changes to `Monthly_Insurance_Dataset` and selected `Commercial Auto\All States\CH02\Comprehensive`. The canonical CSV and deterministic generator own the fake source values; the project builder owns the corresponding sample aggregate formulas.

- Scaled all nine monetary fields in the 339,444-row source to exactly 1% of their previous values. Counts and exposure remain unchanged. Renamed Commercial Auto's fake Physical Damage coverage to Comprehensive without adding rows, and corrected the affected aggregate formula to count each coverage once. The updated generator reproduces the CSV byte-for-byte.
- Imported and refreshed the source through the normal HTTP/Engine workflow, then prepared 21 input datasets on the selected segment. Project origin/development headers were warmed through the standard header endpoint. Annual views show origins 2016–2025 and development ages 5m–113m at May 2026.
- Created `Guide Paid Ultimate` and `Guide Reported Ultimate` through the public DFM builder and hosted save route, with 12/12 periods, Volume - all selections, tail 1.0000, and Earned Premium ratio basis. `Guide Selected Ultimate` combines those outputs with equal 1:1 weights. Baseline totals are respectively $191,513.70, $190,859.91, and $191,186.80.
- Applied the fictional reviewer **Jordan Lee** with [the server-local maintenance helper](../../tools/anonymize_monthly_insurance_demo.py). This explicitly scoped helper changes existing author fields only in this fake project, uses the canonical JSON formatter, and rebuilds affected indexes through HTTP. It runs on the Server PC against local disk; it is not a client SMB fallback or an authentication override. Windows identity and shared user mappings are unchanged. GUI saves stamp the real actor, so rerun the helper after the last demo save.
- The GUI walkthrough exercises input loading, an exclusion, a different average selection, restoration of the baseline, Results, Notes, and Save. The final demo remains at the baseline factors.

The repository screen-control tool does not support typing. Initial method names and note text were prepared through the API, and the Excel sample workbook was prepared on disk before opening it. Text-entry keystrokes were not tested. The real Excel add-in's Refresh Workbook and Insert Function actions were exercised; Insert returned the complete 10×10 triangle, matching Arco's displayed annual values. ArcBot's captured state is offline and requires its local setup; no AI prompt was sent. ResQ screenshots show the macro entry point, not an external transfer.

## Server publication

`server-components/src/arcrho_gateway/user_guide.py` owns the public URL, deployed folder name, and allowed asset types. `frontend/user-manual` is the source; publication mirrors it to `<Server root>/user-guide` with the existing staged deployment/rollback mechanism. Gateway serves only that directory over HTTP, without a client share or local-file fallback. Guide URLs carry no credentials. The HTTP route does not expose project data or directory listings.

The Gateway build publishes the guide automatically. Later guide-only updates need no executable rebuild:

```powershell
py -3.10 server-components/publish_user_guide.py
```

Rollout order is Gateway first, then the desktop Help menu. This is additive and leaves released clients compatible. Restart the development Electron app to load both its new main/preload bridge and menu code; a page refresh alone cannot update the host bridge.

## Validation

Run the browser regression from the repository root:

```powershell
& frontend/node-portable/node.exe frontend/tests/user_manual.e2e.cjs
# After deployment, use the configured Gateway URL:
& frontend/node-portable/node.exe frontend/tests/user_manual.e2e.cjs --base-url=http://NE7SASWPN02.PRCINS.NET:28767/user-guide/
```

The browser regression discovers Home and every chapter. It validates navigation, terminology, links, image decoding, desktop/narrow layouts, step controls, image dialog/focus, print, and JavaScript-disabled reading. Offline mode blocks network requests; hosted mode permits only the configured guide origin/path and checks published links/assets over HTTP. Browser profiles live under repository `test/` and are removed afterward. Visible desktop capture and visual review use the repository screen-control tool separately.

The final 2026-10-03 run passed **936 offline** and **1,395 hosted** browser assertions across all 16 pages, with 29 image placements and 25 unique screenshots. Every hosted guide link and asset returned HTTP 200; both runs had no browser console errors or unexpected network requests. The final visible GUI check used the restarted app's **Help → User Guide** menu and confirmed the browser opened the current Gateway URL, then opened the deployed DFM chapter. This validates the tutorial workflows and guide presentation; it does not imply every external integration was executed.

Gateway's focused transport/publication and existing regression suites passed 57 checks. Build request `build-261003-154742-469-xwei` completed successfully, publishing the guide to `E:\ArcRho Server\user-guide` and rebuilding/redeploying Gateway. Its new heartbeat and `/api/health` were verified. The unrelated pre-existing Bridge staleness was left outside this task; its canonical bundled source roots contain no changes from this work.

The demo generator's output parity passed. Its existing project-builder test suite has one unchanged assertion expecting obsolete `force=true` tree reads; the target function is identical to the pre-task version and the unrelated assertion was left unchanged.

From `frontend`, also run:

```powershell
py -3.10 tools/docs_index_builder.py --write
py -3.10 tools/docs_index_builder.py --check
py -3.10 build/release/release_notes.py check
```

Application behavior changes are limited to Help → User Guide and the Gateway documentation route. Persisted project schemas and calculation contracts are unchanged.
