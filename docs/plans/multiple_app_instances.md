# More than one ArcRho app on one PC

Status: Diagnosed 2026-09-13 from a failed ResQ export with two ArcRho apps open, then widened the same day from the macro fix alone to full support for two windows side by side; broken into 7 session-sized steps estimated at 325 minutes of agent time, no decisions open; 0 of 7 done.
Last updated: 2026-09-13

## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Opening a second app no longer disturbs the first | [ ] | | 40 min | | |
| 2 | A macro's windows stay in the app it was started from | [ ] | | 55 min | | |
| 3 | A stray question about a review table no longer kills a macro | [ ] | | 35 min | | |
| 4 | Closing the last window really shuts the app down | [ ] | | 60 min | | |
| 5 | Scripts and screenshots can pick which app they mean | [ ] | | 60 min | | |
| 6 | What a second window can and cannot remember is known | [ ] | | 30 min | | |
| 7 | Checked with two apps open, written down, and released | [ ] | | 45 min | | |

Overall: 0 of 7 steps done. Estimated 325 min, actual so far 0 min.

## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in [README.md](README.md).
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.

## What happens today

Exporting a reserving class to ResQ failed on 2026-09-13 at 18:36 with `Review table is not available: review_pi_1789339016479_aqe2ki9jr5g`, raised from the macro's poll of the review table it had just opened. Nothing had been written to ResQ; the failure happened while the macro waited for the person to tick rows.

Two ArcRho frontends were running, a development build and the installed app, and the logs show what they did to each other:

```
[22:20:05] ArcRho startup begin. packaged=false; appPath=C:\Users\xwei\Repos\ArcRho\frontend
[22:21:43] ArcRho startup begin. packaged=true;  appPath=...\Programs\ArcRho\resources\app.asar
[22:21:45] ERROR: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 28765)
[22:21:52] INFO:  Uvicorn running on http://127.0.0.1:28765
[22:24:55] Leaving shared backend running for 1 other frontend client(s).
```

The installed app could not bind the port, killed the listener holding it, and took it. The development window's pages address that same port, so from 22:21:52 it was driven by the installed app's server, and the server's access log shows two clients asking for work at once:

```
127.0.0.1:56283 - "POST /ui_automation/commands/poll HTTP/1.1" 200 OK
127.0.0.1:56305 - "POST /ui_automation/commands/poll HTTP/1.1" 200 OK
```

The dialog id begins with `review_pi_`, the marker the Project Instance host generates in [project_instance_review_table.js:58-59](../../frontend/ui/project_instance/project_instance_review_table.js#L58-L59), so the table really did open inside a Project Instance page in one of the two apps. The next command in the same conversation was answered by the other app, which had never heard of that dialog id and reported it missing.

Two further consequences were confirmed on the same machine the same evening. Two app servers were still running with no window behind them, from 18:25 and 18:41. And the file that tells an outside script where the app is holds one entry, so a macro run from a terminal reaches whichever app started last.

## What is already right

Do not rebuild these while working this plan.

- **Another Windows user cannot be disturbed.** Reuse is refused unless the health reply carries the same Electron profile, and a listener belonging to another profile is explicitly left alone ([backend_health_compatibility.js:79-107](../../frontend/electron/backend_health_compatibility.js#L79-L107), [backend_lifecycle.js:348-368](../../frontend/electron/backend_lifecycle.js#L348-L368)).
- **Live windows are already countable.** Each app writes a marker naming its process and port, dead ones are pruned on read, and the count decides whether a departing app stops the server ([backend_lifecycle.js:184-249](../../frontend/electron/backend_lifecycle.js#L184-L249)).
- **A free port is already found when the preferred one is busy** ([backend_port.js:28-37](../../frontend/electron/backend_port.js#L28-L37)).
- **Preference files merge instead of overwriting.** The project-user store deep-merges a patch under a write lock ([project_user_preferences_service.py:250-275](../../frontend/app_server/services/project_user_preferences_service.py#L250-L275)) and the local store merges at the top level ([scripting_preferences_service.py:256-300](../../frontend/app_server/services/scripting_preferences_service.py#L256-L300)), so two windows changing different settings do not clobber each other.
- **Two windows on one object already warn each other.** The open-window change watch alerts and offers a reload when another writer touches the file ([object_change_watch.md](../../frontend/docs/app_server/domains/object_change_watch.md)).
- **Saving the same reserving class is already serialised** by the propagation hold, which refuses the second save rather than interleaving it.

## Why it happens

- **The port is taken by force.** When the preferred port is held by a listener this app cannot reuse, it kills the process holding it and takes the port ([backend_lifecycle.js:348-368](../../frontend/electron/backend_lifecycle.js#L348-L368), called from [backend_lifecycle.js:502](../../frontend/electron/backend_lifecycle.js#L502)). Nothing asks whether a live window is using that server. A development build and an installed app never look compatible to each other, so whichever starts second kills the first one's server.
- **Commands have no addressee.** The queue hands the oldest command to whoever asks first ([ui_automation_service.py](../../frontend/app_server/services/ui_automation_service.py)). The poll request already carries an identity ([schemas/ui_automation.py:16](../../frontend/app_server/schemas/ui_automation.py#L16)) that the shell already generates ([ui_automation.js:9](../../frontend/ui/shell/ui_automation.js#L9)), and the service ignores it.
- **The shell is owner-aware only inside one app.** Follow-up commands are pinned to the tab hosting a review, and a closed tab answers a cancelled completion ([ui_automation.js:834-858](../../frontend/ui/shell/ui_automation.js#L834-L858)). A command that arrives in the wrong app falls past that into the modal bookkeeping and throws. A progress update for an unknown window opens a second progress window instead ([ui_automation.js:1030-1039](../../frontend/ui/shell/ui_automation.js#L1030-L1039)).
- **Nobody stops an inherited server.** The owner leaves it running when other windows are attached ([backend_lifecycle.js:551-572](../../frontend/electron/backend_lifecycle.js#L551-L572)), and the windows that inherit it never owned it, so their own exit skips the shutdown. The server outlives every window.
- **Restart is a marker in a folder, not a message to one window.** Writing it restarts the server for every window attached to it ([config.py:416-417](../../frontend/app_server/config.py#L416-L417), [app_shell.py:11-12](../../frontend/app_shell.py#L11-L12)).
- **The address book holds one entry.** The endpoint file is rewritten by each launch ([backend_port.js:45-62](../../frontend/electron/backend_port.js#L45-L62)) and read as the single answer by the public Python API ([ui.py:103-127](../../python-api/src/arcrho_api/ui.py#L103-L127)). The window-ready marker an automation harness waits for behaves the same way ([main.js:182-205](../../frontend/electron/main.js#L182-L205)).

## The design

Four rules, and the steps implement them in this order.

**An app never takes something another live app is using.** The preferred port is claimed only when no live window claims it; otherwise the new app starts its own server on a free port, which the launcher already knows how to do. A listener with no live window behind it is still cleared, because that is the case the killing was written for.

**Every macro command names the window that should run it.** The window that starts a macro sends its own identity, the server keeps it for that run and stamps the commands the run submits, and a window takes only work addressed to it or addressed to nobody. An addressed command whose owner never comes back becomes free to anyone after a short grace period.

**A window that cannot own a command hands it back.** Asked about a review table or progress window it does not hold, a shell declines instead of raising, and the server offers the command elsewhere. This is the safety net for what ownership cannot cover, such as a shell that reloaded and now has a new identity.

**The server's life follows the windows, not one privileged window.** The last window to leave stops the server whether or not it started it, and restarting the app is scoped to the windows that share that server, with the person told when others are attached.

Two smaller things follow from those rules: the endpoint and window-ready files list every running app rather than the newest one, and whatever a second window cannot remember is measured and written down rather than guessed at.

## Open decisions

None. Six questions came up while writing this plan and are answered here so no step has to guess.

- **Do we forbid a second app instead?** No. Running two is wanted, occasionally, and the whole plan exists to make it safe.
- **A sibling holds the preferred port.** The new app starts its own server on a free port. It clears a listener only when no live window claims it, which keeps the original purpose of the killing, cleaning up a server left behind by an older build of the same app.
- **An owner that never polls.** A command addressed to a window that has gone becomes claimable by any window after 3 seconds, rather than waiting for the caller's own timeout. The caller polls a review table twice a second, so the delay is invisible in normal use and short enough that closing the owning app mid-macro ends the macro cleanly instead of stalling it.
- **Two macros at once in one server.** Out of scope. The owner is held for the length of a run, and two overlapping runs in one server would share it. Runs are started from a window one at a time, and nothing here makes overlap worse than it is today.
- **Macros started from Arcode.** Out of scope, and named as a known remainder in the domain doc by step 7. That path submits its commands from the service itself ([scripting_macro_service.py:1117-1197](../../frontend/app_server/services/scripting_macro_service.py#L1117-L1197)) with no window behind them, so they stay unaddressed and any window may answer them, as today.
- **If a second window cannot save its browser-stored settings.** Step 6 measures it and records the answer; it does not move any setting to another store. Moving settings between storage scopes is its own change with its own review, and would be a separate plan.

## Plan

Steps 1 to 3 are ordered: the port fix removes the cross-attachment that makes ownership ambiguous. Steps 4, 5 and 6 are independent of each other and of steps 2 and 3, and may be taken in any order once step 1 is in. Step 7 is last.

### Step 1 — Opening a second app no longer disturbs the first

**Goal.** A second ArcRho app that cannot share the running server starts its own on a free port instead of killing the one in use.

**Read first.**

- This plan down to the Plan section.
- [backend_lifecycle.js:184-249](../../frontend/electron/backend_lifecycle.js#L184-L249), [backend_lifecycle.js:317-400](../../frontend/electron/backend_lifecycle.js#L317-L400) and [backend_lifecycle.js:488-525](../../frontend/electron/backend_lifecycle.js#L488-L525).
- [backend_port.js](../../frontend/electron/backend_port.js) in full (about 80 lines).
- [backend_health_compatibility.js:79-107](../../frontend/electron/backend_health_compatibility.js#L79-L107).

**Do.**

- [ ] Decide whether a listener may be cleared from the live window markers and the health reply, not from compatibility alone: a port claimed by a live window of this profile is left alone, a port held by a server with no live window behind it is still cleared.
- [ ] Put that decision in a plain function beside the other port helpers, where a test can reach it without Electron, and call it from the startup sequence.
- [ ] When the preferred port is left alone, fall through to the free-port path that already exists, and log which port was taken and why in the same voice as the existing fallback message.
- [ ] Leave the reuse path untouched: an app that finds a compatible server still shares it rather than starting a second one.

**Tests.**

- [backend_port.test.mjs](../../frontend/tests/backend_port.test.mjs) gains the new decision: a live sibling's port is left alone, an abandoned server's port is cleared, another profile's port is left alone, and a free preferred port is taken.

**Done when.** Starting the installed app while a development build is running leaves the development server alive, the installed app comes up on its own port, and each window's pages come from its own app.

Estimate: code edit 30 min, test/validation 10 min, total 40 min.

### Step 2 — A macro's windows stay in the app it was started from

**Goal.** Every UI command a macro issues carries the identity of the window that started the macro, and only that window runs it.

**Read first.**

- This plan down to the Plan section.
- [ui_automation_service.py](../../frontend/app_server/services/ui_automation_service.py) in full (about 190 lines).
- [schemas/ui_automation.py](../../frontend/app_server/schemas/ui_automation.py) and [ui_automation_router.py](../../frontend/app_server/api/ui_automation_router.py).
- [ui_automation.js:1-30](../../frontend/ui/shell/ui_automation.js#L1-L30) and [ui_automation.js:1290-1315](../../frontend/ui/shell/ui_automation.js#L1290-L1315).
- [macro_window.js:1060-1080](../../frontend/ui/macro/macro_window.js#L1060-L1080) and [schemas/scripting.py:63-68](../../frontend/app_server/schemas/scripting.py#L63-L68).
- [scripting_macro_service.py:972-1100](../../frontend/app_server/services/scripting_macro_service.py#L972-L1100).
- [ui.py:256-282](../../python-api/src/arcrho_api/ui.py#L256-L282) in the public Python API, which is what a macro calls. This step touches the frontend and that package together; they land in one commit.

**Do.**

- [ ] Export the shell's existing client identity from the automation module so the whole shell page has one name for the window, and send it with the run-macro request.
- [ ] Carry it on the run-macro request model and into the macro service.
- [ ] Hold it in the public Python API for the length of the run, and include it on every command the macro submits. The macro host sets it before the macro source runs and clears it afterwards, so a macro's own code needs no change.
- [ ] Store the owner on the pending command in the queue, and hand a command out only to its owner, to any window when it has no owner, or to any window once the grace period has passed.
- [ ] Keep the other call sites unchanged: a command submitted from anywhere else stays unaddressed and any window may answer it.

**Tests.**

- [test_ui_automation_command_budget.py](../../frontend/tests/test_ui_automation_command_budget.py) gains a sibling covering the queue: an addressed command is refused to a stranger and given to its owner, an unaddressed one goes to whoever asks, and an addressed one falls back to a stranger after the grace period.
- [ui_automation_command_timeout.test.mjs](../../frontend/tests/ui_automation_command_timeout.test.mjs) gains a check that the shell sends one identity on both the poll and the run-macro request.

**Done when.** With two apps sharing one server, a macro started in one shows its progress window, its message boxes and its review table in that same app, and the other app never sees them.

Estimate: code edit 40 min, test/validation 15 min, total 55 min.

### Step 3 — A stray question about a review table no longer kills a macro

**Goal.** A window asked about a review table or progress window it does not hold hands the command back instead of failing the macro.

**Read first.**

- This plan down to the Plan section.
- [ui_automation.js:740-860](../../frontend/ui/shell/ui_automation.js#L740-L860) and [ui_automation.js:1000-1060](../../frontend/ui/shell/ui_automation.js#L1000-L1060).
- [project_instance_review_table.js:89-125](../../frontend/ui/project_instance/project_instance_review_table.js#L89-L125).
- [ui_automation_service.py](../../frontend/app_server/services/ui_automation_service.py) as changed by step 2, and its router.

**Do.**

- [ ] Add a way for a window to decline a command, beside the existing cancel and complete paths, naming itself as it does so.
- [ ] Put a declined command back at the front of the queue and never offer it to the same window twice. When every window that could answer has declined, settle it with the error the caller sees today, so nothing bounces forever.
- [ ] Decline, rather than raise, when a review table status or close names a dialog this window does not hold.
- [ ] Decline, rather than open a second window, when a progress update names a progress window this window does not hold.
- [ ] Leave the existing behaviour for a dialog whose hosting page has genuinely closed: that still answers a cancelled completion, so a macro ends cleanly.

**Tests.**

- The queue test file from step 2 gains a declined command being re-offered to another window and never to the decliner, and the all-declined case settling with an error.
- [review_table.test.mjs](../../frontend/tests/review_table.test.mjs) gains a check that an unknown dialog id is declined rather than thrown on.

**Done when.** With an identity deliberately stale, a review table poll answered by the wrong window is retried and answered correctly by the right one, and the macro finishes.

Estimate: code edit 25 min, test/validation 10 min, total 35 min.

### Step 4 — Closing the last window really shuts the app down

**Goal.** The server stops when the last window using it leaves, whichever window started it, and restarting the app says what else is attached.

**Read first.**

- This plan down to the Plan section.
- [backend_lifecycle.js:184-249](../../frontend/electron/backend_lifecycle.js#L184-L249) and [backend_lifecycle.js:527-572](../../frontend/electron/backend_lifecycle.js#L527-L572).
- [main.js:2135-2165](../../frontend/electron/main.js#L2135-L2165) and [main.js:2205-2230](../../frontend/electron/main.js#L2205-L2230).
- The restart and shutdown markers: [config.py:410-425](../../frontend/app_server/config.py#L410-L425) and [app_shell.py:1-40](../../frontend/app_shell.py#L1-L40).

**Do.**

- [ ] Make the departing window count the live windows rather than its own ownership: the last one asks the server to stop, whether it started that server or inherited it.
- [ ] Keep the existing guard that a window never stops a server another live window is still using.
- [ ] Tell the person, when an in-app restart is asked for and other windows share that server, that those windows restart too, and let them go ahead or stop.
- [ ] Clear a server left behind by an earlier session at startup, which step 1's decision already identifies, so today's two abandoned servers cannot accumulate.

**Tests.**

- A new test beside [backend_port.test.mjs](../../frontend/tests/backend_port.test.mjs) for the stop-or-keep decision, driven by marker sets rather than live processes: last window stops it, a window with siblings does not, a window that inherited the server still stops it when alone.

**Done when.** Closing both windows leaves no app server process behind, and an in-app restart with two windows open warns before it restarts both.

Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 5 — Scripts and screenshots can pick which app they mean

**Goal.** The files that publish a running app list every one of them, and the public Python API picks deliberately instead of taking the newest write.

**Read first.**

- This plan down to the Plan section.
- [backend_port.js:39-75](../../frontend/electron/backend_port.js#L39-L75).
- [main.js:178-215](../../frontend/electron/main.js#L178-L215).
- [ui.py:103-140](../../python-api/src/arcrho_api/ui.py#L103-L140). This step touches the Electron host and that package together; they land in one commit.

**Do.**

- [ ] Make the endpoint file hold an entry per running app, keyed by process, with the newest first and dead entries dropped on write, while keeping the single-app shape readable by anything that has not been updated.
- [ ] Do the same for the window-ready marker an automation harness waits on, so it can wait for a named window rather than the newest one.
- [ ] Let the public Python API choose: by default the newest live entry, and by an explicit process or port when the caller names one.
- [ ] Keep the existing rule that an app removes only its own entry on exit.

**Tests.**

- [backend_port.test.mjs](../../frontend/tests/backend_port.test.mjs) gains the list shape: two apps each appear, a dead entry is dropped, and an app removes only its own entry.
- A Python test beside the other public-API tests for choosing the newest live entry and for an explicitly named one.

**Done when.** With two apps running, the endpoint file names both, and a macro run from a terminal reaches the one it was told to.

Estimate: code edit 40 min, test/validation 20 min, total 60 min.

### Step 6 — What a second window can and cannot remember is known

**Goal.** Settle by measurement whether a second window's browser-stored settings survive, and write the answer down.

**Read first.**

- This plan down to the Plan section, and the Open decisions entry for this step.
- [User Preference Storage Scopes](../../agent-instructions/user-preference-storage-scopes.md).
- The memory note on launching the app detached and reading a screenshot back.

**Do.**

- [ ] With two apps running, change a browser-stored setting in each window, close both, reopen, and record which survived. The colour theme is the cheapest one to move.
- [ ] Record the result in the preference-scopes instruction as a short paragraph on what a second window can remember.
- [ ] Change no storage in this step. If the second window cannot persist, the note says so plainly and names it as the reason a separate plan may move those keys.

**Tests.** None. This step is a measurement and a note.

**Done when.** The preference-scopes instruction answers, from an observation rather than a guess, what a second window keeps and what it loses.

Estimate: code edit 10 min, test/validation 20 min, total 30 min.

### Step 7 — Checked with two apps open, written down, and released

**Goal.** Prove the whole thing in the app, record the behaviour, and get it onto the server.

**Read first.**

- This plan in full.
- [ui_automation.md](../../frontend/docs/app_server/domains/ui_automation.md), the domain doc that describes the command bus.
- [Component Deployment Authorization](../../agent-instructions/component-deployment-authorization.md).

**Do.**

- [ ] Start a development build and the installed app together and confirm each keeps its own server, each window loads its own pages, and neither restarts the other.
- [ ] Export a reserving class to ResQ from one of them. The review table, the progress window and the completion message all appear in that app, and the export completes. This one needs ResQ and a real reserving class, so it is the user's time, not the agent's, and is not in the estimate below.
- [ ] Repeat with the owning app closed while the review table is open, and confirm the macro reports a cancelled review instead of a traceback. Also the user's time.
- [ ] Close both windows and confirm no app server is left running.
- [ ] Describe the ownership rule, the grace period and the port behaviour in the domain doc, and note that macros started from Arcode are still unaddressed.
- [ ] Add a release-note fragment under [frontend/changes/unreleased/](../../frontend/changes/unreleased/).
- [ ] Rebuild and redeploy with `python server-components/deploy.py`. The app server is bundled into the Bridge, the Engine and the Gateway, so all three are stale after steps 2 and 3; let the tool decide rather than naming components.

**Done when.** The two-app checks pass, the domain doc and the fragment are in, and the deploy reports success.

Estimate: code edit 20 min, test/validation 25 min, total 45 min, plus the user's two checks in the app.

## Rough size

Seven sessions, one per step, estimated at 325 minutes of agent time: 205 minutes of code edit and 120 minutes of test, validation and deploy. Steps 2 and 5 each touch the frontend and the public Python API together; every other step stays inside one component. The ResQ checks in step 7 are the user's time and are not counted.

## Out of scope

- Stopping a second app from starting, or warning about one. Two instances are the point.
- A single window shared between two app processes, or two windows sharing one open method's state. The change watch already tells a window when another writer moved its file.
- Moving any setting between storage scopes, as recorded under Open decisions.
- The Arcode macro path, as recorded under Open decisions.
- Reducing the doubled polling two windows cause on the server share. That is transport work and belongs with the hosted-transport plans.
