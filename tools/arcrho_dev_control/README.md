# ArcRho Dev Control Center

Run `launch_arcrho_dev_control.bat` from the repository root. It starts a
loopback-only page at `http://127.0.0.1:28768` and opens it in the default
browser.

The port deliberately sits above the deployed ArcRho services, which own 28765
(app server), 28766 (Admin Control), and 28767 (Gateway). Pass `--port` to
override it.

The page can:

- launch ArcRho through the canonical `frontend/launch_arcrho_dev_mode.bat`;
- relaunch after terminating the repository-owned Electron supervisor,
  Electron process tree, and Python app server;
- clear Electron cache and renderer storage, then relaunch;
- move one selected project/user `preferences.json` to a timestamped `.bak`
  file, then relaunch; and
- show and open ArcRho's local preference, cache, log, runtime, and user-file
  folders.

Launch actions complete as soon as the batch launcher hands off the detached
ArcRho supervisor. The control page therefore clears its busy overlay without
waiting for ArcRho to close.

The page follows the system light/dark theme by default. The switch in the
title bar picks Auto, Light, or Dark and stores that choice in the browser's
`localStorage`; no theme state is kept on the server. The folder filter box
narrows the folder table by name, path, or purpose and is client-side only.

Mutating requests require a random token embedded in the served page. The
server refuses non-loopback binds, accepts only allow-listed actions and
folders, and never accepts a filesystem path from the browser.

Close the console window or use **Stop Control Center** to stop the localhost
server. Stopping the control center does not stop ArcRho.
