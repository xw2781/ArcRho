# Release Fragments

Add one JSON fragment in `changes/unreleased/` for each meaningful user-facing or internal change.

Required fields:
- `type`: `feature`, `improvement`, `fix`, or `breaking`
- `scope`: short area name such as `workflow`, `dataset`, `dfm`, `project settings`, or `build`
- `audience`: `user` or `internal`
- `summary`: one user-facing sentence

Optional fields:
- `details`: array of short supporting bullets

Example:

```json
{
  "type": "feature",
  "scope": "workflow",
  "audience": "user",
  "summary": "Added a faster workflow import flow with clearer error feedback.",
  "details": [
    "Imports now validate files before opening them.",
    "Failures show the specific reason instead of a generic error."
  ]
}
```

Release flow:
1. Fragments are validated with `python build/release/release_notes.py check`.
2. Before packaging, the build runs `python build/release/release_notes.py stage-notes <version>`, which writes `docs/releases/<version>.md` and leaves the fragments unreleased. The app reads its Release History from the notes packaged inside it, so a version's notes have to exist before its installer is built.
3. A successful packaged release runs `python build/release/release_notes.py release <version>`, which keeps the notes the build packaged.
4. Consumed fragments are moved into `changes/archive/<version>/`.
