---
name: arcrho-plan-breakdown
description: Restructure an ArcRho plan document into steps that one agent context (a 1M session or one workflow subagent) can finish end to end, put a plain-language progress checklist at the top that the executing agents keep current, and run the finished plan as a workflow of one subagent per step. Use proactively without asking for permission to use the skill when the user asks to break a plan into sessions or session-sized steps, add a progress checklist or progress tracking to a plan, make a plan agent-executable, prepare a plan doc for implementation, or run, execute, or work through a plan that carries the Progress table (as a workflow or step by step).
---

# ArcRho Plan Breakdown

## Purpose

A plan doc in `docs/plans/` or `frontend/docs/plans/` is written for two readers: the user, who wants to see progress without reading code, and the agent that will execute one step in one fresh context. This skill produces a plan that serves both, tells an executing agent how to keep the progress record current, and describes how the whole plan is run unattended as a workflow of subagents, one per step.

## When invoked to restructure a plan

1. Read the whole plan, the repo instructions (`AGENT_GUIDELINES.md`, `docs/plans/README.md`), and enough of the code the plan cites to judge each step's real size. Do not change the plan's decisions; if a decision is missing, record it under an "Open decisions" section with a recommended answer rather than choosing silently.
2. Keep every section the plan already has that explains *why* (the question, the investigation, the measurements, the decisions). Agents read those before starting a step. Only the "Plan" section is restructured.
3. Split the work into steps that each fit one context. A step fits when all of these hold:
   - One goal a user could describe in one sentence.
   - One commit. Nothing in the step depends on a decision that is still open, because a workflow subagent cannot ask the user anything.
   - The files it touches are listable by name and fit in roughly a dozen; a step that touches every producer of a contract, or every reader of a field, is its own step.
   - Its tests are part of the step, not a later one.
   - It crosses at most one component boundary (app server, frontend, Engine, Bridge, Gateway, tools). A change that needs the same contract on several components becomes "contract and producers", then "readers", then "backfill" as separate steps.
   - A deploy is always its own final step.
   Order the steps so each one's inputs already exist, and say which steps are independent.
4. Write each step with this template, using the plan's own headings style:
   - `### Step N — <title>`
   - **Goal.** One or two sentences.
   - **Read first.** The sections of the plan and the code ranges the agent must read, as links; skills or memory notes that apply. Nothing more, so the session stays small.
   - **Do.** A checkbox list of the concrete changes.
   - **Tests.** Which test files gain what.
   - **Done when.** An observable condition, not "the code is written".
   - **Estimate.** One line in the form `Estimate: code edit N min, test/validation N min, total N min.` See "Estimating the work" below. The executing agent appends its actual to this same line.
5. Put the Progress table and the "How agents work this plan" section at the top, directly under the `Status:` and `Last updated:` lines, using the formats below.
6. Update the `Status:` line, `Last updated:`, and the plan's row in `docs/plans/README.md` (or the frontend plans index) to say the plan is broken into N session-sized steps and where implementation stands.
7. Refresh the "Rough size" section, if the plan has one, so it gives the estimated total and its two parts, and says how many steps carry it.

## The Progress table

Plain language only. No file names, function names, field names, endpoints or component names. Each row says what a user would notice when the step is done.

```markdown
## Progress

Plain-language tracking. The agent that finishes a step ticks its box, fills in the date, and leaves one short line on what a user would notice. Nothing technical goes here.

| # | Step | Done | Date | Est. | Actual | What changed for the user |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Coarser views of a hand-entered triangle add up correctly | [ ] | | 45 min | | |
| 2 | Every dataset records the shape its data is really stored at | [ ] | | 70 min | | |

Overall: 0 of N steps done. Estimated 115 min, actual so far 0 min.
```

- A ticked row reads `[x]`, the date is `YYYY-MM-DD`, and the last cell is one sentence in the same plain register as the step title.
- **Est.** is the step's whole estimate in minutes, written when the plan is broken into steps and never edited afterwards. **Actual** is what the step really took, written by the agent that finishes it. The two-part split lives in the step's own `Estimate:` line, so the table stays readable.
- The Overall line carries the estimated total for every step and the actual total of the finished ones, so the gap is visible without opening a single step.
- A step that was skipped or dropped is not ticked; its last cell says "Dropped: <one plain reason>" and the Overall line counts it out of the total, estimate included.
- A step that is started but not finished stays unticked; the last cell may say "In progress" with the date, and is replaced when the step lands.

## Estimating the work

Every step carries an estimate, and the plan carries their total. The unit is **minutes of agent time**: one fresh context taking the step from its "Read first" list to its commit. It is not a human day, and it is not a calendar figure.

Split every estimate in two, because they behave differently and only one of them is under the agent's control:

1. **Code edit** — reading the ranges the step names, writing the change, and writing its tests.
2. **Test/validation run** — running the suites, launching the app for a check, a deploy, and the re-runs after a failure.

Write it as one line at the end of the step: `Estimate: code edit 25 min, test/validation 15 min, total 40 min.` Put the total in the Progress table's **Est.** column and the sum of every step in "Rough size".

Estimate the median run in which the step goes as written. No safety margin and no padding for the unexpected: a step that goes wrong records its real time and the reason, which is what makes the next estimate better. An estimate that is quietly doubled "to be safe" destroys that signal and is worse than a wrong one.

Leave out anything that is not the agent working: waiting on the user, permission prompts, and any part of the step a person has to do at the Server PC. Name that part in the step and say it is the user's time.

Starting anchors, in agent minutes, until recorded actuals replace them:

| Work | Minutes |
| :--- | :--- |
| Orienting in one module the step names | 2-5 |
| One focused edit in a file already read | 2-4 |
| A new test file with a handful of cases | 8-15 |
| One Python test module run | 1-2 |
| The frontend Node suite | 3-6 |
| Launching the app and driving one check through it | 10-20 |
| A rebuild and deploy of the stale components | 10-25 |

When an actual lands at more than twice or less than half its estimate, the finishing agent adds one clause to the step's `Estimate:` line saying why. When that keeps happening, say so in the report rather than silently absorbing it, so these anchors get rewritten.

## The "How agents work this plan" section

Include it verbatim, adjusting only the file links:

```markdown
## How agents work this plan

- Take the first unticked step in the Progress table. One step is one context (a session or one workflow subagent), one commit.
- Note the clock before the first file is read and again at the commit, keeping the two parts apart: time spent reading and editing, and time spent running tests, checks and deploys.
- Read the sections between here and the Plan before starting, then only the files the step names. Do not read ahead into later steps.
- A step is done when its "Done when" list holds, its tests pass, and the commit is in. In that same commit: tick the Progress row, write the date, the actual minutes and the one-line user note, update the "Overall" count and actual total, append the actual to the step's `Estimate:` line, and update the `Status:` line at the top and this plan's row in the plans index.
- If a step turns out to need a decision that is not in "Open decisions", stop, record the question there, commit that note alone, and report it rather than guessing.
- Do not start a step while the previous one is uncommitted.
```

## When invoked while executing a step

- Before starting, confirm the previous row is ticked and the tree is clean of that step's work. If not, stop and report.
- Read the clock (`date`) before opening the first file, again when the edits and the tests are written, and again at the commit. The first gap is the code-edit time, the second is the test/validation time. Round to whole minutes; do not reconstruct them from memory afterwards.
- Do the step as written. If the step's "Read first" list turns out to be insufficient, read what is needed, then add the missing item to that step's list in the same commit so the next reader benefits.
- On completion, in the same commit as the code: tick the row, date it, write the actual minutes and the plain-language note, append `Actual: code edit N min, test/validation N min, total N min.` to the step's `Estimate:` line, update the Overall line and its actual total, the `Status:` line, `Last updated:`, and the plans-index row. Use the `arcrho-commit-workflow` skill for the commit; the user's request to run the plan is the authorization to commit each step.
- Report the actual against the estimate in the result, whichever way it went. An estimate beaten is as useful as one missed, and a step that ran long because of something the plan did not foresee says what that was in one clause.
- When the last step lands, move the plan to the `completed/` folder and update the plans index, as `docs/plans/README.md` describes.

## Running the whole plan as a workflow

The user runs a prepared plan unattended by asking to "run the plan as a workflow" (or with the `ultracode` keyword). That request is the opt-in the Workflow tool requires and the authorization for every per-step commit. The orchestrating session does this:

1. Read the plan's Progress table and its "Plan" section only far enough to list the steps, their order, and which are independent. Load the `workflow-authoring` skill before writing the script.
2. Write one script that runs the unticked steps **in order**, one `agent()` call per step, sequential unless the plan says two steps are independent. Never parallelise steps that touch the same files or the same contract.
3. Each subagent's prompt is short and self-contained. It names the plan file and the step number, says to invoke this skill and follow the plan's "How agents work this plan" rules, and asks for a structured result: `status` (`done` / `blocked`), the commit hash, the plain-language note written into the Progress row, the actual minutes as `edit_minutes` and `test_minutes`, and for `blocked` the question recorded under "Open decisions". Use a result schema so the script can branch on `status`.
4. After each step the script checks the result. On `done`, continue. On `blocked` or an error, stop the workflow and return what is known; do not start the next step, because it would build on an unfinished one.
5. Before the deploy step, stop and return unless the user's request explicitly included deploying. A deploy is outward-facing and stays a user decision.
6. When the script returns, the orchestrating session re-reads the Progress table from disk, confirms the ticks match the commits (`git log --oneline` since the run started), and reports in plain language: steps done, the commit list, the estimated and actual time side by side, and any blocker with its question.

Sizing reminder: a workflow that runs more than the session's agent guideline (fifteen by default) is fine when each agent is one plan step, but say so in the report and keep one agent per step; do not split a step across agents to stay under the count.

## What not to do

- Do not put technical detail in the Progress table; the step sections hold it. The time columns are the exception and stay.
- Do not pad an estimate, and do not rewrite one after the fact to match what a step really took. The estimate is a record of what was expected, and the pair is only worth keeping while both halves are honest.
- Do not renumber steps once execution has started; append a new step instead and note where it fits.
- Do not merge steps to save sessions; a step that cannot be finished and tested in one context is split, not stretched.
- Do not tick a row for work that is not committed.
- Do not let a workflow subagent guess at an open decision, push to the remote, or deploy; those stay with the user.
