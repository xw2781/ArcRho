---
name: deploy-staleness-is-mtime-based
description: "server-components/deploy.py --stale compares the deployed EXE's mtime against the newest bundled source file, so committing does not make a component stale and an already-deployed change reports \"Updated\""
metadata: 
  node_type: memory
  type: project
  originSessionId: ae395d21-5bd5-46cd-8b9a-5f7e37a80634
  modified: 2026-08-31T01:25:18.384Z
---

`arcrho_build_components.build_freshness` decides staleness by comparing the deployed
executable's mtime against `latest_source_timestamp(component)` — the newest mtime among that
component's bundled source roots. Nothing about git enters into it.

**Why:** a commit or push leaves working-file mtimes untouched, so committing an
already-deployed change never makes a component stale, and `deploy.py --stale` correctly
reports "Every deployed component is up to date". Do not read a memory note saying "deploy
pending" as current state — check the actual timestamps.

**How to apply:**
- Run `python server-components/deploy.py --stale` first; it is cheap and authoritative.
- To confirm a specific fix is live rather than trusting mtimes, diff the working-tree file
  against the deployed copy under
  `E:\ArcRho Server\apps\ArcRho <Component>\_internal\arcrho_canonical\<repo-relative path>`.
  Engine and Gateway both carry `frontend/app_server/` and `python-api/src/arcrho_api/` there.
- Verify liveness from the newest heartbeat under `E:\ArcRho Server\runtime\instances\<component>\`
  ("Last seen" within a few seconds) and, for the Gateway, `GET http://NE7SASWPN02:28767/api/health`.
- See [[remote-component-deploy]] and [[hosted-save-fix-needs-engine-deploy]].
