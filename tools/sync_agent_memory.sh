#!/usr/bin/env bash
# Commit and push agent-memory/ so memories follow the repository across machines.
#
# The agent harness writes memories into its own project directory, which is a
# junction into agent-memory/ (see tools/link_agent_memory.ps1). That makes the
# writes land in the working tree, but nothing commits them, so two machines
# drift apart silently. This runs from a Stop hook and closes that gap.
#
# It touches agent-memory/ and nothing else: the pathspec form of git commit
# ignores whatever is staged elsewhere, so a task's in-progress work is never
# swept into a memory commit.

set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

changed() {
  ! git diff --quiet -- agent-memory ||
    ! git diff --cached --quiet -- agent-memory ||
    [ -n "$(git ls-files --others --exclude-standard -- agent-memory)" ]
}

changed || exit 0

# A memory commit must never land in the middle of someone else's operation.
git_dir="$(git rev-parse --git-dir)"
if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] ||
  [ -f "$git_dir/MERGE_HEAD" ] || [ -f "$git_dir/CHERRY_PICK_HEAD" ]; then
  exit 0
fi

# Detached HEAD has nowhere to push; leave the memories for a human to place.
branch="$(git symbolic-ref --quiet --short HEAD)" || exit 0

git add -- agent-memory || exit 0
git commit --quiet -m "chore(memory): sync agent memories from $(hostname)" \
  -- agent-memory || exit 0

subject="$(git log -1 --format=%h)"

# Push only when the branch already tracks a remote. A rejected push (someone
# else pushed first) leaves the commit local; the next run carries it.
if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  if git push --quiet >/dev/null 2>&1; then
    printf '{"systemMessage":"Memories synced and pushed (%s on %s)."}\n' "$subject" "$branch"
    exit 0
  fi
  printf '{"systemMessage":"Memories committed (%s) but the push failed; it will retry."}\n' "$subject"
  exit 0
fi

printf '{"systemMessage":"Memories committed (%s); %s tracks no remote, so nothing was pushed."}\n' "$subject" "$branch"
