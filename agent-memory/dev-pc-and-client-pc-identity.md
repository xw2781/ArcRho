---
name: dev-pc-and-client-pc-identity
description: L-H2MQ6280FVP is the current local repo host and is a Client PC; NE7SASWPN02 is the Dev PC that hosts E:\ArcRho Server and the old source repo
metadata:
  node_type: memory
  type: project
  originSessionId: 05c09575-2234-4404-bf4e-fcede99def6e
  modified: 2026-08-13T18:22:10.822Z
---

Two machines matter for ArcRho work, and which one the repo is on changes what is reachable.

**Current machine — `L-H2MQ6280FVP`** (HP EliteBook, `PRCINS.NET`, user `xwei`). Since 2026-08-13
this holds the main local repo at `c:\Users\xwei\Repos\ArcRho`. It is a **Client PC** as
`AGENTS.md` defines the term: it reaches the ArcRho Server workspace over the network rather
than locally. It was chosen deliberately to reproduce network-latency issues that do not appear
on the Dev PC. `gh` is installed and authenticated here as `xw2781`, so releases can be
published from this machine.

**Dev PC — `NE7SASWPN02`.** Hosts `E:\ArcRho Server`, `E:\XWSpace`, and the older source repo at
`E:\XWSpace\Repos\ArcRho`. ResQ is installed there, so ResQ/COM work (see [[resq-com-probe]] and
[[resq-percentage-developed-enum]]) still means going back to that machine.

On the Client PC, `E:` and `F:` are **mapped network drives onto the Dev PC** (`\\NE7SASWPN02\E`,
`\\NE7SASWPN02\F`). So every `E:\...` path in the repo instructions and in older memories —
`E:\ArcRho Server\shared\macros`, `E:\ArcRho Server\config\config.json`,
`E:\XWSpace\Build ArcRho App` — resolves here over SMB and depends on the Dev PC being up. That
network hop is the point when reproducing latency bugs, and it is also why a memory written on
the Dev PC that says "local disk" may mean "network drive" here.

The local macro deploy target in `AGENTS.md` (`C:\Users\xwei.PRCINS\Documents\ArcRho\macros`) is a
Dev PC profile path and does not exist on this machine.

Building and releasing without the Dev PC is covered by [[arcrho-local-release-build]].
