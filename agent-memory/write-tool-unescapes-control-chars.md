---
name: write-tool-unescapes-control-chars
description: "Writing \"\x1f\" (or \"\\x1f\") through the Write/Edit tools lands the literal control character in the file, not the escape; fix with a Python chr(92) rewrite"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4599da27-7ddb-489f-9302-174baa3258cd
  modified: 2026-09-18T22:13:51.434Z
---

On 2026-09-18 a `const KEY_SEPARATOR = "\u001f";` written with the Write tool arrived on disk as the literal U+001F byte, and the same happened for template strings with `\u001f` in them. `file` then reports the JS as `data`, and an Edit whose old_string spells the escape cannot find it. A Bash heredoc cannot repair it either, because the tool mangles doubled backslashes ([[bash-tool-heredoc-pitfalls]]).

**Why:** the harness decodes JSON-style escapes in tool arguments before writing, so `\u001f` is already a control character when the file is written.

**How to apply:** after writing a file that should contain a backslash escape for a control character, grep it (`grep -n 'u001f'`); if the escape is missing, rewrite the line with Python built as `'"' + chr(92) + 'u001f"'` via a heredoc, or avoid the escape altogether by importing the separator from a module that already defines it.
