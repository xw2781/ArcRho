# Agent Commit Workflow

Use this workflow whenever an agent prepares a commit in this repository.

## Rule

Do not run push commands until the user separately approves the push.

Do not run `git add` or `git commit` until the user has either explicitly requested a commit in the current task or approved the exact scope after a commit plan. Treat requests such as "do a commit", "commit this", "commit the current changes", or "use the ArcRho commit workflow skill to commit" as commit approval for the current stated scope, so the agent should not stop for a second approval prompt.

Ask for clarification before staging only when the requested scope is ambiguous, the worktree contains changes clearly outside the user's request, or broad/risky changes need an explicit human choice.

## Preflight

1. Read the applicable `AGENTS.md` and `AGENT_GUIDELINES.md` files for the files being committed.
2. Inspect the worktree with:
   - `git status --short`
   - `git diff --stat`
   - `git diff --name-status`
3. Review relevant diffs before summarizing. Use targeted file diffs for large changes.
4. Run targeted validation when appropriate and feasible within the repository validation limit.

## Review Summary

Prepare a concise review before staging anything. If the user already requested a commit, present the review and proceed without waiting for another reply:

1. Group modifications into 1 to 7 logical groups.
2. When changes are wide across the repo, span multiple components, or include distinct themes, plan multiple commits by logical group instead of one large commit.
3. For each group, include:
   - Purpose or theme.
   - Representative files.
   - Risk level: low, medium, or high.
   - Validation performed or recommended.
4. Call out deleted files, generated files, dependency changes, release notes, and cross-component changes.
5. Provide best-practice suggestions when applicable, such as:
   - Commit generated docs separately if they obscure source changes.
   - Run a targeted test or smoke check before commit.
   - Avoid committing local-only debug files, logs, build output, or environment-specific paths.
   - Confirm broad deletions or dependency lockfile changes.

## Approval Prompt

Ask for final review and approval with the proposed commit message and exact scope only when the user asked for a commit plan, asked for review, or did not clearly authorize a commit. Use language like:

```text
Please review this commit plan. If it looks right, reply with explicit approval to commit, and tell me whether to include all groups or only specific groups.
```

Approval must be explicit. Treat vague replies such as "looks okay", "continue", or "do it" as insufficient when the scope is large or risky; ask for a clear confirmation.

## Commit Execution

1. Stage only the approved or pre-authorized files or groups. For multiple commits, stage and commit one logical group at a time.
2. Re-check staged content before each commit:
   - `git diff --cached --stat`
   - `git diff --cached --name-status`
3. Commit with the approved message.
4. Report the commit hash and any validation that was skipped or failed.
5. Do not push unless the user separately approves a push.

## Helper

Use `tools/agent_commit_push.ps1` only when a separate final typed confirmation is desired. For an explicit "commit" request that already authorizes the action, do not use helpers that stop for another confirmation; rely on the staged diff checks before committing.
