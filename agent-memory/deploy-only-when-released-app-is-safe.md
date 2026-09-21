---
name: deploy-only-when-released-app-is-safe
description: "2026-09-20 user rule — rebuild/redeploy a server component without asking only when users on the latest released app cannot be affected; otherwise stop and tell the user explicitly. Plans must open with a ship-impact statement (frontend release, server redeploy, both, risk)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 901862e0-9f67-48a1-9359-827224fc4df0
  modified: 2026-09-21T01:00:12.568Z
---

On 2026-09-20 the user set two rules, recorded in agent-instructions/component-deployment-authorization.md:

1. The standing rebuild/redeploy authorization applies only when the change cannot break a user running the latest released desktop app. If the server would start requiring something the released app does not send, or change a response or persisted JSON the released app reads, stop before building and say so explicitly; do not deploy until the user answers.
2. Before writing code for a feature or fix, state how it ships: frontend release only, server component redeploy only, both (and in which order), plus the concrete risk to the released app or "none". Repeat it in the final response if implementation changed the answer.

**Why:** server components are sometimes shipped with a frontend release and sometimes alone; the user wants to know the shipping outcome before agreeing to the work, and never wants a deploy that strands the released app.

**How to apply:** treat `frontend/app_server` as server-bundled (Engine and Gateway carry it, see [[hosted-save-fix-needs-engine-deploy]]); assume every user is on the latest release ([[all-users-run-latest-app-version]]); [[deploy-without-asking]] still holds for the safe case.
