---
name: bash-tool-heredoc-pitfalls
description: "In this Windows Git-Bash tool, heredoc bodies are not literal — backticks abort the command and `\\\\` collapses to `\\`; write scripts with the Write tool and run them by path"
metadata: 
  node_type: memory
  type: project
  originSessionId: be39cc59-f1e3-4e66-8f1b-060ea472932d
  modified: 2026-08-18T02:07:04.976Z
---

On this Client PC the Bash tool's `<<'EOF'` heredocs are **not** treated as literal text even with a quoted delimiter (observed 2026-08-17):

- Any backtick in the body (JS template literals, Markdown code spans in a doc-editing script) makes bash fail with ``unexpected EOF while looking for matching `''`` — the whole command runs nothing.
- Doubled backslashes are collapsed: a Python line `"Z:\\A\\New.xlsx"` inside the heredoc reaches Python as `"Z:\A\New.xlsx"` and raises `unicodeescape` errors, or silently writes single-backslash text into files.

**Why:** the command string is pre-processed before Git Bash sees it, so heredocs only work for bodies free of backticks and escaped backslashes.

**How to apply:** for anything longer than a few plain lines — especially JS/CSS/Markdown edits or scripts with Windows paths — write the script or content with the Write tool into the scratchpad and run it by path (`py -3.10 <scratchpad>/script.py`), or use the Edit tool directly. Related: [[python-test-runner]], [[frontend-node-test-suite]].
