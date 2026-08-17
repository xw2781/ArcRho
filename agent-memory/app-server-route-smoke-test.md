---
name: app-server-route-smoke-test
description: Smoke-test new app-server routes with an in-process uvicorn thread on a spare port; starlette's TestClient is unusable here
metadata:
  node_type: memory
  type: feedback
---

`fastapi.testclient.TestClient` cannot be used on this machine: starlette raises `RuntimeError: The starlette.testclient module requires the httpx2 package`, and installing it would write outside the repo. To exercise a new route end to end, run the app in a daemon thread and call it with `urllib`:

```python
import uvicorn, threading, urllib.request
from app_server.arcode_main import app          # or app_server.main for ArcRho
cfg = uvicorn.Config(app, host="127.0.0.1", port=28799, log_level="error")
server = uvicorn.Server(cfg)
threading.Thread(target=server.run, daemon=True).start()
# poll one GET until it answers, then issue the real calls
server.should_exit = True
```

Set `ARCRHO_APP_MODE=arcode` and point `APPDATA` at a temp folder so per-user JSON (connection profiles, preferences) is written to a throwaway location instead of the real one. The same server also serves `/ui/...`, so fetching a page and its modules proves the static assets are mounted.

**Why:** it uses the real router/middleware stack, needs no extra packages, and reaches the routes the way the UI does. `py -3.10` is the interpreter that has fastapi and uvicorn — see [[python-test-runner]].

**How to apply:** give the client a generous timeout. A SQL Server call against an unreachable host blocks for the full ODBC connect timeout (~15 s) before returning its error, so a 10 s client timeout looks like a hang that is really the driver behaving correctly.
