---
name: deploy-without-asking
description: "After editing a component's bundled sources, rebuild and redeploy it yourself instead of telling the user to - unless another session's uncommitted work is in the tree"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e74e4a3f-0141-45dc-aedb-94a100d7a86c
  modified: 2026-08-29T02:28:15.475Z
---

When a change lands in a source root that a server component freezes into its build
(Bridge, Engine, Gateway, and the rest), **run the deploy yourself as part of finishing the
task**. Do not end a response with "rebuild and redeploy the Bridge" as an action for the user.

**Why:** the change is not live until it is deployed, so a task that stops at the edit is not
finished. Asked for on 2026-08-28, after a Bridge-bundled comparison fix was reported as done
with the deploy left as homework.

**How to apply:**

- **The one condition to check first is other people's work.** Read `git status`. If the tree
  holds uncommitted edits that are not yours, stop and say so rather than shipping them —
  a working-tree deploy carries everything. Your own uncommitted work is fine and needs no
  commit or push. When you must deploy anyway, commit yours and use `--ref <sha>`.
- **Never hand-pick components.** `py -3.10 server-components/deploy.py` with no arguments
  builds exactly what is stale; `--stale` lists it first. Picking by memory has already
  missed a Gateway.
- **Still check the listener heartbeat's `Repository` before deploying**, because a deploy
  hard-resets that clone. See [[remote-component-deploy]] for that and for the failure modes
  worth reading before trusting an exit code.
- **Then follow up on what the deploy does not do**, such as the Bridge restart in
  [[bridge-restart-after-deploy]], and publishing an edited macro through
  [[shared-macro-library-deploy]].
- **Report it as done**, with what was deployed and anything that failed — not as an
  instruction.
