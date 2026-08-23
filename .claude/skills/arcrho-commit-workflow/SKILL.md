---
name: arcrho-commit-workflow
description: Prepare, review, stage, and create commits safely in the ArcRho monorepo. Use proactively without asking for permission to use the skill when the user asks to commit changes, prepare a commit plan, stage files, create a commit, push ArcRho repository changes, or otherwise perform git operations that would update the index, refs, or remote state.
---

# ArcRho Commit Workflow

## Invocation

Use this skill automatically for ArcRho commit, staging, and push requests. Do not ask the user whether to use the skill first.

When the user explicitly asks to create a commit using this skill, treat that request as approval to inspect, plan, stage, and commit the current stated scope without stopping for another approval prompt. Do not ask "are you sure?" or require a second confirmation unless the requested scope is ambiguous, the worktree contains changes clearly outside the user's request, or the operation includes a push.

## Source Of Truth

Read the applicable repository instructions before preparing a commit:

- Read `AGENTS.md` and `AGENT_GUIDELINES.md` at the ArcRho repo root.
- Read any nested `AGENTS.md` files that apply to the files being committed, including `frontend/AGENTS.md` before committing files under `frontend/`.
- Read `tools/agent_commit_workflow.md` when present. Treat it as the detailed source of truth if it differs from this skill.

## Hard Rule

Do not run push commands until the user separately approves the push.

Do not run `git add` or `git commit` until the user has either explicitly asked for a commit in the current request or approved the exact scope after a commit plan. Treat requests such as "do a commit", "commit this", "commit the current changes", or "use this skill to commit" as commit approval for the current stated scope.

## Preflight

Inspect the worktree before proposing any commit:

```powershell
git status --short
git diff --stat
git diff --name-status
```

Review relevant diffs before summarizing. Use targeted file diffs when the full diff is large.

Run targeted validation when appropriate and feasible within the repository validation limit. Respect ArcRho runtime preferences from `AGENT_GUIDELINES.md`, including Python 3.10 preference, bundled frontend Node/npm preference, and the 120-second default validation limit.

## Commit Plan

Present a concise review before staging anything:

- Group modifications into 1 to 7 logical groups.
- When changes are wide across the repo, span multiple components, or include distinct themes, plan multiple commits by logical group instead of one large commit.
- For each group, include the purpose or theme, representative files, risk level (`low`, `medium`, or `high`), and validation performed or recommended.
- Call out deleted files, generated files, dependency changes, release notes, and cross-component changes.
- Include best-practice suggestions when applicable, such as committing generated docs separately, running a targeted smoke check, excluding local-only debug files or build output, and confirming broad deletions or lockfile changes.

For multi-commit plans, include the proposed commit message and exact scope for each commit.

If the user asked only for a commit plan or review, ask for final approval with language like:

```text
Please review this commit plan. If it looks right, reply with explicit approval to create these commits, and tell me whether to include all groups or only specific groups.
```

If the user already asked to commit using this skill, present the plan briefly and proceed without waiting for another reply.

## Commit Execution

Stage only the files or groups in the approved or pre-authorized scope. For a multi-commit plan, create one commit at a time in the approved order, staging only that commit's files before each commit.

After staging, re-check the staged content:

```powershell
git diff --cached --stat
git diff --cached --name-status
```

Use `tools/agent_commit_push.ps1` only when a separate final typed confirmation is desired. For an explicit "commit using this skill" request, do not use helpers that stop for another confirmation; rely on the staged diff checks above before committing.

Commit with the approved message. Report the commit hash and any validation that was skipped, timed out, or failed.

Do not push unless the user separately approves a push.
