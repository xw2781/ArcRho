---
name: macro-method-notes-persistence
description: DFM macro results apply only the owned payload; method notes live in the output sidecar and update_notes from a macro may not persist through the Macro window
metadata: 
  node_type: memory
  type: project
  originSessionId: 07908965-d021-44ec-aa35-f18324b8250a
  modified: 2026-08-12T14:31:27.106Z
---

Method Notes are persisted in the output sidecar `notes` field (written only by `DfmMethod.save()` / UI save with `notes: getDfmNotesText()`); the method JSON's canonical projection strips any extra metadata, so notes can only cross payload flows via the transient `method metadata.method notes` carrier (RPC bridge convention).

**Wired on 2026-08-12:** `run_macro_source` stamps a macro's `_pending_notes` into the returned payload's `method metadata.method notes`, and `applyDfmOwnedPatchPayload` (dfm_persistence.js) calls `setDfmNotesText` when an incoming payload carries that key — so accepting a macro's notes_diff preview updates the Notes tab and the next normal Save persists to the sidecar. This also covers ArcBot proposals and RPC apply responses that carry the key. Remember: `normalize_dfm_method` strips the carrier, so it never lands in persisted method JSON.

**Inbound direction wired 2026-08-16:** the carrier now also runs *into* a macro. `buildDfmAssistantContextPayload` stamps the live Notes tab text onto the context payload, and `_build_active_dfm` seeds it as `_pending_notes` (then pops the carrier, since `normalize_dfm_method` would strip it anyway) — without that, `DfmMethod.notes` reads the persisted sidecar and a macro's notes preview shows saved notes while the DFM window is dirty. `_macro_seeded_notes` records the seed so an untouched seed is not echoed back as a Notes-tab change.

Related: [[shared-macro-library-deploy]]
