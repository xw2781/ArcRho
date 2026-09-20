---
name: update-asset-name-strands-old-clients
description: "Auto-update matches the release asset file name, so renaming the installer strands installed clients; publish a copy under the old name"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5b08eeaa-1c7d-45d6-9211-6fb739f49858
  modified: 2026-09-20T04:18:49.304Z
---

2026-09-20: the Arco rename changed the published installer from `ArcRho-Setup-<version>.exe` to `Arco-Setup-<version>.exe`, and every installed 1.7.1 client reported "up to date" because the old name is compiled into it (`UPDATE_INSTALLER_NAME_RE` in frontend/electron/update_checker.js). Fixed by uploading byte-identical copies named `ArcRho-Setup-1.7.2.exe` and `ArcRho-Setup-1.7.2.exe.sha256` to the Arco-v1.7.2 release. The client also demands a `<installer name>.sha256` sibling in the same release, so the old-name copy needs its own checksum file; release tag and title do not matter, only the asset name.

**Why:** the updater scans the repo's releases and accepts only assets matching its own compiled-in name pattern, so the asset file name is a compatibility contract with every copy already installed.

**How to apply:** keep publishing an old-name copy of the installer and its checksum with each release until no machine is left on a pre-rename version, and never rename the installer file without that bridge. Relates to [[all-users-run-latest-app-version]] and [[arcrho-local-release-build]].
