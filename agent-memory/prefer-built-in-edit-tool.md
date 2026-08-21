---
name: prefer-built-in-edit-tool
description: Change files with the built-in Edit/Write tools so the VS Code extension shows a diff panel; use shell rewrites only for genuine bulk work
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f937f9c8-1a49-4b26-90e0-1670bdb9f59d
  modified: 2026-08-21T14:39:33.879Z
---

Make file changes with the built-in Edit and Write tools rather than rewriting files through
shell commands (`sed -i`, `printf > file`, redirection). Stated 2026-08-21.

**Why:** The user works in the Claude Code VS Code extension and wants to see what changed.
An Edit or Write call goes through the extension, so it can show a diff panel, put the real
before-and-after in the permission prompt, and keep the change in its history. A shell rewrite
lands the same bytes on disk but the extension only sees "a command ran" — no diff, nothing to
review, and the permission prompt shows a command string instead of the change. The user asked
about this after comparing it with the Codex extension, which draws its own native "Edited
<file> +6 -0" card from the edits its edit tool makes.

**How to apply:** Default to Edit/Write for every file change, including one-line tweaks and
new files. Fall back to a shell rewrite only for genuine bulk work — the same mechanical
substitution across many files at once, where separate edits would be pure overhead. This
overrides a session instruction to prefer the shell for file edits when one is present.
Reading and searching are unaffected; shell tools stay fine there. See
[[bash-tool-heredoc-pitfalls]] for why shell-authored file content is fragile here anyway.
