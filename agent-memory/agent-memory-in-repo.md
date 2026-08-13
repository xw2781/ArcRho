---
name: agent-memory-in-repo
description: Project memories are stored in the tracked repo folder agent-memory/ and reach the harness path through a directory junction
metadata: 
  node_type: memory
  type: project
  originSessionId: 05c09575-2234-4404-bf4e-fcede99def6e
  modified: 2026-08-13T18:09:46.018Z
---

Claude Code memories for ArcRho are **tracked in the repository**, not left under the user
profile. The files live in `agent-memory/` at the repo root and are committed to `main` like
any other doc.

The harness memory path is not configurable, so `%USERPROFILE%\.claude\projects\<slug>\memory`
is a Windows **directory junction** pointing at `<repo>\agent-memory`. Writes through the
harness path land in the working tree and show up in `git status`. The `<slug>` is the repo's
absolute path with the drive letter lowercased and `:\` / `\` collapsed to `-` — for
`c:\Users\xwei\Repos\ArcRho` that is `c--Users-xwei-Repos-ArcRho`.

Recreate the junction on a new machine or a fresh clone with
`pwsh tools/link_agent_memory.ps1` (see `AGENTS.md` -> Agent Memory). It is idempotent, needs
no elevation, and refuses to clobber a non-empty real memory directory.

Because memories are now shared across machines, a note that depends on one workstation's
layout (installed interpreters, drive letters, `node-portable` presence, pre-existing test
failure counts) must say so in its own text rather than being written as a universal fact.
