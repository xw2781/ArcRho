# One app window owns a macro's UI commands

Status: Diagnosed 2026-09-13 from a failed ResQ export with two ArcRho apps open; broken into 3 session-sized steps estimated at 125 minutes of agent time, no decisions open; 0 of 3 done.
Last updated: 2026-09-13

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | A macro's windows stay in the app it was started from | [ ] | | 55 min | | |
| 2 | A stray question about a review table no longer kills a macro | [ ] | | 35 min | | |
| 3 | Checked with two apps open, written down, and released | [ ] | | 35 min | | |

Overall: 0 of 3 steps done. Estimated 125 min, actual so far 0 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in [README.md](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

## What happens today

Exporting a reserving class to ResQ failed on 2026-09-13 at 18:36 with `Review table is not available: review_pi_1789339016479_aqe2ki9jr5g`, raised from the macro's poll of the review table it had just opened. Nothing had been written to ResQ; the failure happened while the macro waited for the person to tick rows.

Two ArcRho frontends were running against one backend at that moment, which the startup log states plainly:

```
[22:20:05] ArcRho startup begin. packaged=false; appPath=C:\Users\xwei\Repos\ArcRho\frontend
[22:21:43] ArcRho startup begin. packaged=true;  appPath=...\Programs\ArcRho\resources\app.asar
[22:24:55] Leaving shared backend running for 1 other frontend client(s).
```

Both shells long-poll the same command queue, which the server access log shows as two client ports asking for work at the same time:

```
127.0.0.1:56283 - "POST /ui_automation/commands/poll HTTP/1.1" 200 OK
127.0.0.1:56305 - "POST /ui_automation/commands/poll HTTP/1.1" 200 OK
```

The dialog id begins with `review_pi_`, the marker the Project Instance host generates in [project_instance_review_table.js:58-59](../../frontend/ui/project_instance/project_instance_review_table.js#L58-L59), so the table really did open inside a Project Instance page in one of the two apps. The next command in the same conversation was answered by the other app, which had never heard of that dialog id and reported it missing.

## Why it happens

- [ui_automation_service.py](../../frontend/app_server/services/ui_automation_service.py) keeps one global queue. `poll_command` pops the oldest command and returns it to whichever client asked first; nothing records who a command belongs to.
- The poll request already carries a `client_id` ([schemas/ui_automation.py:16](../../frontend/app_server/schemas/ui_automation.py#L16)), the shell already generates one per page load ([ui_automation.js:9](../../frontend/ui/shell/ui_automation.js#L9)), and the service ignores it.
- A macro runs inside the shared app server, started by one window's `POST /scripting/run-macro` ([macro_window.js:1065-1074](../../frontend/ui/macro/macro_window.js#L1065-L1074)), so the owner is known at the moment the run begins and is simply not kept.
- The shell's follow-up routing in [ui_automation.js:834-858](../../frontend/ui/shell/ui_automation.js#L834-L858) is already owner-aware *within one app*: it pins a review's status and close commands to the tab that hosts it, and answers a cancelled completion when that tab is gone. A command that reaches the wrong app falls past that logic into the modal-dialog bookkeeping and throws.

The same split hits other commands more quietly. A progress update whose window lives in the other app opens a second progress window instead of updating the first ([ui_automation.js:1030-1039](../../frontend/ui/shell/ui_automation.js#L1030-L1039)), and a message box can appear over the app the person is not looking at.

## The design

Two independent layers, in this order.

**An owner travels with the command.** The window that starts a macro sends its own identity, the app server remembers it for that run and stamps every command the run submits, and a window only takes work addressed to it or addressed to nobody. The identity is the one the shell already generates for polling, so there is one name for a window, not two.

**A window that cannot own a command hands it back.** Asked about a review table or a progress window it does not have, a shell declines instead of raising, and the server offers the command to a different window. This is the safety net for the cases ownership cannot cover: a shell that reloaded mid-macro and now has a new identity, or a macro started from somewhere that has no window of its own.

An addressed command whose owner never comes back must not hang. After a short grace period any window may take it, which is what happens when the owning window is closed in the middle of a macro.

## Open decisions

None. Three questions came up while writing this plan and are answered here so no step has to guess:

- **An owner that never polls.** A command addressed to a window that has gone becomes claimable by any window after 3 seconds, rather than waiting for the caller's own timeout. The caller polls a review table twice a second, so 3 seconds is invisible in normal use and short enough that closing the owning app mid-macro still ends the macro cleanly rather than stalling it.
- **Two macros at once in one app server.** Out of scope. The owner is held for the duration of a run in the macro host; two runs overlapping in one process would share it. Macro runs are started from a window one at a time, and nothing in this plan makes overlapping runs worse than they are today.
- **Macros started from Arcode.** Out of scope for now, and stated as a known remainder in the domain doc by step 3. That path submits its capture and review commands from the service itself ([scripting_macro_service.py:1117-1197](../../frontend/app_server/services/scripting_macro_service.py#L1117-L1197)) with no window behind them, so those commands stay unaddressed and any window may answer them, exactly as today.

## Plan

### Step 1 — A macro's windows stay in the app it was started from

**Goal.** Every UI command a macro issues carries the identity of the window that started the macro, and only that window runs it.

**Read first.**

- This plan down to here.
- [ui_automation_service.py](../../frontend/app_server/services/ui_automation_service.py) in full (about 190 lines).
- [schemas/ui_automation.py](../../frontend/app_server/schemas/ui_automation.py) and [ui_automation_router.py](../../frontend/app_server/api/ui_automation_router.py).
- [ui_automation.js:1-30](../../frontend/ui/shell/ui_automation.js#L1-L30) and [ui_automation.js:1290-1315](../../frontend/ui/shell/ui_automation.js#L1290-L1315).
- [macro_window.js:1060-1080](../../frontend/ui/macro/macro_window.js#L1060-L1080) and [schemas/scripting.py:63-68](../../frontend/app_server/schemas/scripting.py#L63-L68).
- [scripting_macro_service.py:972-1100](../../frontend/app_server/services/scripting_macro_service.py#L972-L1100).
- [ui.py:256-282](../../python-api/src/arcrho_api/ui.py#L256-L282) in the public Python API, which is what a macro calls.

**Do.**

- [ ] Export the shell's existing client identity from the automation module so the whole shell page has one name for the window, and send it with the run-macro request.
- [ ] Carry it on the run-macro request model and into the macro service.
- [ ] Hold it in the public Python API for the length of the run, and include it on every command the macro submits. The macro host sets it before the macro source runs and clears it afterwards, so a macro's own code needs no change.
- [ ] Store the owner on the pending command in the queue, and hand a command out only to its owner, to any window when it has no owner, or to any window once the grace period has passed.
- [ ] Keep the window-side call sites unchanged: a macro still calls the same helpers, and a command submitted from anywhere else stays unaddressed.

**Tests.**

- [test_ui_automation_command_budget.py](../../frontend/tests/test_ui_automation_command_budget.py) gains a sibling covering the queue: an addressed command is refused to a stranger and given to its owner, an unaddressed one goes to whoever asks, and an addressed one falls back to a stranger after the grace period.
- [ui_automation_command_timeout.test.mjs](../../frontend/tests/ui_automation_command_timeout.test.mjs) gains a check that the shell sends one identity on both the poll and the run-macro request.

**Done when.** With two apps open, a macro started in one shows its progress window, its message boxes and its review table in that same app, and the other app never sees them.

Estimate: code edit 40 min, test/validation 15 min, total 55 min.

### Step 2 — A stray question about a review table no longer kills a macro

**Goal.** A window asked about a review table or progress window it does not host hands the command back instead of failing the macro.

**Read first.**

- This plan down to the Plan section.
- [ui_automation.js:740-860](../../frontend/ui/shell/ui_automation.js#L740-L860) and [ui_automation.js:1000-1060](../../frontend/ui/shell/ui_automation.js#L1000-L1060).
- [project_instance_review_table.js:89-125](../../frontend/ui/project_instance/project_instance_review_table.js#L89-L125).
- [ui_automation_service.py](../../frontend/app_server/services/ui_automation_service.py) as changed by step 1, and its router.

**Do.**

- [ ] Add a way for a window to decline a command, beside the existing cancel and complete paths, naming itself as it does so.
- [ ] Put a declined command back at the front of the queue and never offer it to the same window twice. When every window that could answer has declined, settle it with the error the caller sees today, so nothing bounces forever.
- [ ] Decline, rather than raise, when a review table status or close names a dialog this window does not hold.
- [ ] Decline, rather than open a second window, when a progress update names a progress window this window does not hold.
- [ ] Leave the existing behaviour for a dialog whose hosting page has genuinely closed: that still answers a cancelled completion, so a macro ends cleanly.

**Tests.**

- The queue test file from step 1 gains a declined command being re-offered to another window and never to the decliner, and the all-declined case settling with an error.
- [review_table.test.mjs](../../frontend/tests/review_table.test.mjs) gains a check that an unknown dialog id is declined rather than thrown on.

**Done when.** With ownership disabled or an identity deliberately stale, a review table poll answered by the wrong window is retried and answered correctly by the right one, and the macro finishes.

Estimate: code edit 25 min, test/validation 10 min, total 35 min.

### Step 3 — Checked with two apps open, written down, and released

**Goal.** Prove the fix in the app, record the behaviour, and get it onto the server.

**Read first.**

- This plan in full.
- [ui_automation.md](../../frontend/docs/app_server/domains/ui_automation.md), the domain doc that describes this bus.
- [Component Deployment Authorization](../../agent-instructions/component-deployment-authorization.md).

**Do.**

- [ ] Run the app twice, one development instance and the installed one, and export a reserving class to ResQ from one of them. The review table, the progress window and the completion message all appear in that app, and the export completes. This one needs ResQ and a real reserving class, so it is the user's time, not the agent's, and is not in the estimate below.
- [ ] Repeat with the owning app closed while the review table is open, and confirm the macro reports a cancelled review instead of a traceback. Also the user's time.
- [ ] Describe the ownership rule and the grace period in the domain doc, under External Interfaces and Data/State/Caches, and note that macros started from Arcode are still unaddressed.
- [ ] Add a release-note fragment under [frontend/changes/unreleased/](../../frontend/changes/unreleased/).
- [ ] Rebuild and redeploy with `python server-components/deploy.py`. The app server is bundled into the Bridge, the Engine and the Gateway, so all three are stale after steps 1 and 2; let the tool decide rather than naming components.

**Done when.** Both two-app checks pass, the domain doc and the fragment are in, and the deploy reports success.

Estimate: code edit 15 min, test/validation 20 min, total 35 min, plus the user's two checks in the app.

## Rough size

Three sessions, one per step, estimated at 125 minutes of agent time: 80 minutes of code edit and 45 minutes of test, validation and deploy. Step 1 is the largest at seven files plus tests; step 2 is about thirty lines across the shell and the queue; step 3 is a doc, a release note and the deploy. The two-app checks in step 3 are the user's time and are not counted.

## Out of scope

- Stopping a second app from starting, or warning about one. Two instances stay supported.
- Routing anything other than macro-issued commands. The UI regression harness submits commands with no window behind them and keeps working unchanged.
- The Arcode macro path, as recorded under Open decisions.
