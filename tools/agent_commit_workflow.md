# Agent Commit Workflow

Use this workflow whenever an agent prepares a commit in this repository.

## Rule

Do not run `git add`, `git commit`, or push commands until the user has reviewed the proposed commit plan and explicitly approved the commit.

## Preflight

1. Read the applicable `AGENTS.md` files for the files being committed.
2. Inspect the worktree with:
   - `git status --short`
   - `git diff --stat`
   - `git diff --name-status`
3. Review relevant diffs before summarizing. Use targeted file diffs for large changes.
4. Run targeted validation when appropriate and feasible within the repository validation limit.

## Review Summary

Present a concise review for the user before staging anything:

1. Group modifications into 1 to 7 logical groups.
2. For each group, include:
   - Purpose or theme.
   - Representative files.
   - Risk level: low, medium, or high.
   - Validation performed or recommended.
3. Call out deleted files, generated files, dependency changes, release notes, and cross-component changes.
4. Provide best-practice suggestions when applicable, such as:
   - Split into multiple commits when unrelated work is mixed.
   - Commit generated docs separately if they obscure source changes.
   - Run a targeted test or smoke check before commit.
   - Avoid committing local-only debug files, logs, build output, or environment-specific paths.
   - Confirm broad deletions or dependency lockfile changes.

## Approval Prompt

Ask for final review and approval with the proposed commit message and exact scope. Use language like:

```text
Please review this commit plan. If it looks right, reply with explicit approval to commit, and tell me whether to include all groups or only specific groups.
```

Approval must be explicit. Treat vague replies such as "looks okay", "continue", or "do it" as insufficient when the scope is large or risky; ask for a clear confirmation.

## After Approval

1. Stage only the approved files or groups.
2. Re-check staged content:
   - `git diff --cached --stat`
   - `git diff --cached --name-status`
3. Commit with the approved message.
4. Report the commit hash and any validation that was skipped or failed.
5. Do not push unless the user separately approves a push.

## Helper

After staging approved files, use `tools/agent_commit_push.ps1` to show the staged summary and require a final typed confirmation before the commit is created.
