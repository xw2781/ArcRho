---
name: credential-helper-deploy-waits-for-release
description: 2026-09-27 — production Credential helper deliberately left stale; deploying it before the post-1.7.5 app release breaks first-time Excel sign-up
metadata:
  node_type: memory
  type: project
  originSessionId: 347eb081-7042-43d6-a11f-62511db10a0b
  modified: 2026-09-27T21:54:35.541Z
---

On 2026-09-27 every server component except `credential` was deployed from main (SMB retirement steps
included) after a check found them safe for Arco 1.7.5. The Credential helper was held back: the new helper
takes the Gateway address only from the production server profile in the user's Arco settings, which only a
post-1.7.5 app writes, so a PC with no credential yet gets "No Gateway address is known" instead of signing up.

**Why:** a deploy must never strand users on the latest released app ([[deploy-only-when-released-app-is-safe]]).

**How to apply:** `deploy.py --stale` will keep listing `credential`; do not deploy it alone. Deploy it with
or after the app release that carries the server profiles, or first add a fallback to the shared registry's
`client_url`.
