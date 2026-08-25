---
name: commit-authorship
description: ArcRho commits must be authored by xw2781 with no Claude co-author trailer
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f1a9b709-1392-46d6-8592-82ed9cae40ff
  modified: 2026-08-25T21:23:01.262Z
---

Every ArcRho commit is authored by the repository owner alone: `xw2781 <xw2781@gmail.com>`, and the message carries no `Co-Authored-By:` trailer or other assistant attribution — this overrides the harness default that appends one.

**Why:** the user wants the GitHub history to show the repo owner's identity consistently. On 2026-08-25 the Client PC (L-H2MQ6280FVP) had no git identity configured at all, so git fell back to the Windows account and commits landed as `Wei <xwei@plymouthrock.com>`; the Server PC clone had always been correct.

**How to apply:** `git var GIT_AUTHOR_IDENT` must read `xw2781 <xw2781@gmail.com>` before committing; if not, set `user.name`/`user.email` in the user-level (`--global`) config, which the user chose on 2026-08-25 to cover every repository on the machine, work repos included — no repo-local override is kept. The rule is also written into `tools/agent_commit_workflow.md` and the [[arcrho-commit-workflow]] skill. Applies to hook-made commits too — `tools/sync_agent_memory.sh` uses the same config. See [[dev-pc-and-client-pc-identity]].
