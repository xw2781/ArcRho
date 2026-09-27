---
name: arcbot-server-prompt-swap-at-release
description: "The server's config\\arcbot\\arcbot_prompt.md must be replaced at the moment of the post-1.7.5 app release, not before; it is uncustomized, so a straight copy of the bundled prompt is the whole job"
metadata:
  node_type: memory
  type: project
  originSessionId: 347eb081-7042-43d6-a11f-62511db10a0b
  modified: 2026-09-27T22:07:10.622Z
---

Checked 2026-09-27: `E:\ArcRho Server\config\arcbot\arcbot_prompt.md` is still the untouched 2026-05-20 seed
(identical to the 1.7.5 bundled prompt), and the six files under `config\arcbot\instructions` are placeholder
headings that name no share path. The SMB-retirement app release needs the new wording, which is exactly
`frontend/electron/prompts/arcbot_prompt.md`, so the swap is: back up the server copy, then copy the bundled
prompt over it.

**Why:** Arco 1.7.5 reads the same server file over the share. The new wording drops the project-folder line and
tells ArcBot to read through `arcrho_api.gateway`, which 1.7.5 does not ship, so swapping early breaks ArcBot for
every 1.7.5 user; swapping late leaves the new app's ArcBot with "Current project folder: ." and no Gateway
instructions. The user asked for it on 2026-09-27 and I held it for that reason.

**How to apply:** do the copy right when the release is published (same sitting). If an administrator has edited
the server copy since, merge instead of overwriting. Related: [[credential-helper-deploy-waits-for-release]].
