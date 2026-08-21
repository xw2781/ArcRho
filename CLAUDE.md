# CLAUDE.md

Read [AGENT_GUIDELINES.md](AGENT_GUIDELINES.md) before starting any task in this repository. It holds the instructions shared by every agent working here. The section below applies to Claude only.

## Final Response

Write the final response for a reader who wants the outcome, not the implementation.

- Use plain English. Prefer short sentences and everyday words. Say "the app now remembers the last folder you opened" rather than a precise technical restatement of the same thing.
- Do not name variables, functions, classes, or settings keys in the prose. Describe what a part of the app does in ordinary terms instead, such as "the part that saves a method" or "the piece that checks whether a table is out of date". Linking to a file is fine when it helps the user find something; naming the code inside it is not.
- Keep the whole response short whenever the task allows it. A small task deserves a few sentences, not a report.

When the response has to be long, open it with a short summary the user can read in one or two minutes and still understand the whole picture. The summary answers three things, in this order:

1. **What changed** — what is different now, one or two sentences each.
2. **What you need to do** — anything required from the user, such as restarting the app, rebuilding a component, or making a decision. Write "nothing" when nothing is needed.
3. **How it should work now** — the expected workflow from the user's point of view, start to finish.

Everything else goes below the summary as optional supporting detail, under its own heading. The user must be able to stop reading after the summary and still act correctly, so never leave a required action, a failure, a skipped step, or an assumption you made only in the detail section.

### Changed files table

End every response that changed files with a `Changed files` table. One row per file, in this shape:

| File | ⠀⠀⠀LOC⠀⠀⠀ | ⠀⠀⠀Changed⠀⠀⠀ | Notes |
| --- | --- | --- | --- |
| [dfm_service.py](frontend/app_server/dfm_service.py) | ⠀⠀⠀1,204 | ⠀⠀⠀+18 / -4 | Saves a method in one pass instead of two |
| [example.js](frontend/ui/example.js) | ⠀⠀⠀312 | ⠀⠀⠀+6 / -0 | Remembers the folder you opened last time |
| [formula_renderer.mjs](frontend/ui/shared/formula_renderer.mjs) | ⠀⠀⠀208 | ⠀⠀⠀New | Draws formulas the same way on every page |
| **All files (3)** | ⠀⠀⠀**1,724** | ⠀⠀⠀**+232 / -4** | |

- **File** is a clickable Markdown link using the path from the repository root, so the file opens straight from the response. Add a line number when it points at the part that matters, for example `[example.js:42](frontend/ui/example.js#L42)`.
- **LOC** is the file's current total line count, after the change.
- **Changed** is the lines added and removed **in this turn alone**, not the total since the last commit. Count it from the exact text each edit replaced. For a brand-new file write just `New`, since its whole length is new.
- **Notes** is one short plain-English phrase about the effect of the change, not the code, and it goes last. "Stops the save prompt appearing twice" beats a description of the logic.

The two number columns hold short values, so the reader squeezes them until they are hard to read. Widen them with the padding shown above: three braille blank characters (U+2800) on both sides of each of the two headers, and three in front of every value in those two columns. Ordinary spaces and no-break spaces do not survive — the reader trims them — but a braille blank is a normal printable character that happens to draw nothing, so it always holds its width. Copy the padding from the example above rather than retyping it.

Close the table with an **All files** row that carries the number of files touched, the total LOC of those files, and the added and removed lines summed across them. A new file contributes its whole length to the added total even though its own row says only `New`.

Read the LOC figure from the file itself rather than estimating it. Do not take the Changed figure from a diff against the last commit, which accumulates across turns and would overstate what this turn did.

Group the rows by file type, with Python first, then JavaScript, then other code such as HTML, CSS, PowerShell, and batch files, then configuration, then documentation. Within each group put the largest file first, ordered by the LOC column. Do not add a header row per group; simply keep the rows of one type together.

Include every file: code, documentation, tests, configuration, release notes, and generated output. If the task changed nothing, write `Changed files: none` instead of an empty table.
