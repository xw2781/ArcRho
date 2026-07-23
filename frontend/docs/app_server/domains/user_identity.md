# App Server Domain: User Identity

## Purpose
<!-- MANUAL:BEGIN -->
Resolve the current Windows login to the display name used by the ArcRho Home brand and other user-facing metadata.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/app/user-identity` | Return the current `login_name` and resolved `display_name`. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/user_identity_router.py` - Thin identity API route.
- `app_server/services/user_identity_service.py` - Windows-login and username-index resolution.
- `app_server/config.py` - Canonical workspace-root and username-index path resolution.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- The mapping is read from `<workspace_root>/config/username_index.json`.
- `login_name` matching is case-insensitive.
- A matching row uses its non-empty `full_name`; a missing, invalid, or unmapped entry falls back to the unchanged Windows login name.
- The file is read on each identity resolution so server-side mapping edits do not require an app restart.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- The login comes from the backend process account. If the app server runs under a service account, that account is resolved instead of the interactive desktop user.
<!-- MANUAL:END -->
