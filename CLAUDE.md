# CLAUDE.md

Read [AGENT_GUIDELINES.md](AGENT_GUIDELINES.md) before starting any task in this repository. It holds the instructions shared by every agent working here. The section below applies to Claude only.

## Final Response

Write the final response for a reader who wants the outcome, not the implementation.

- Use plain English. Prefer short sentences and everyday words. Say "the app now remembers the last folder you opened" rather than a precise technical restatement of the same thing.
- Do not name variables, functions, classes, or settings keys in the prose. Describe what a part of the app does in ordinary terms instead, such as "the part that saves a method" or "the piece that checks whether a table is out of date". Linking to a file is fine when it helps the user find something; naming the code inside it is not.
- Keep the whole response short whenever the task allows it. A small task deserves a few sentences, not a report.

### Lay it out so it can be skimmed

The response is read on a wide screen, where five sentences in a row become an unbroken slab the eye slides off. Break the text up on the page, not just in your head.

- **Three sentences at most** in any paragraph. Start a new paragraph rather than adding a fourth.
- **Prefer a list to a paragraph.** Whenever two or more things of the same kind appear — findings, causes, steps, numbers, files, options — give each one its own bullet.
- **Lead each bullet with two or three bold words** naming what it covers, so the reader can scan the left edge and stop only where it matters.
- **Never run a paragraph off a bold label.** A bold lead-in introduces one short line or a list beneath it; it is not the opening of a slab of prose.
- **Give numbers their own line.** Counts and results go in bullets or a small table where they can be compared, never buried mid-sentence.
- **Leave a blank line** between every heading, paragraph, list, and table.

### Summary

When the response has to be long, open it with a short summary the user can read in one or two minutes and still understand the whole picture. Answer three things, in this order, each introduced by its own bold lead-in on its own line with bullets or numbered steps beneath it:

- **What changed** — what is different now. On a task that only investigated something, this becomes **What I found**.
- **What you need to do** — anything required from the user, such as restarting the app, rebuilding a component, or making a decision. Write "Nothing" when nothing is needed.
- **How it works now** — the expected workflow from the user's point of view, start to finish. Write it as numbered steps whenever there is more than one.

Everything else goes below the summary as optional supporting detail, under its own heading, and split into short bold-labelled blocks rather than one long run of prose. The user must be able to stop reading after the summary and still act correctly, so never leave a required action, a failure, a skipped step, or an assumption you made only in the detail section.

### Changed files table

End every response that changed files with one `Changed files` table, whatever the mix of file types. One row per file, the files of one type kept together, and each type opening with its own row of column labels whose first cell carries the type name in place of `File`. In this shape:

## Changed files

| Python | Location⠀⠀⠀ | LOC⠀⠀⠀ | Added⠀⠀⠀ | Deleted⠀⠀⠀ |
| :--- | :--- | :--- | :--- | :--- |
| [dfm_service](frontend/app_server/dfm_service.py) | [640-657](frontend/app_server/dfm_service.py#L640-L657)⠀⠀⠀ | 1,204⠀⠀⠀ | +18⠀⠀⠀ | -4⠀⠀⠀ |
| **JavaScript** | ⠀⠀⠀ | ⠀⠀⠀ | ⠀⠀⠀ | ⠀⠀⠀ |
| [example](frontend/ui/example.js) | [42-47](frontend/ui/example.js#L42-L47), [180](frontend/ui/example.js#L180)⠀⠀⠀ | 312⠀⠀⠀ | +6⠀⠀⠀ | ⠀⠀⠀ |
| [formula_renderer](frontend/ui/shared/formula_renderer.mjs) | [1-208](frontend/ui/shared/formula_renderer.mjs#L1-L208)⠀⠀⠀ | 208⠀⠀⠀ | New⠀⠀⠀ | ⠀⠀⠀ |
| **Grand total (3)** | ⠀⠀⠀ | ⠀⠀⠀ | **+232**⠀⠀⠀ | **-4**⠀⠀⠀ |

Write the separator row as `| :--- | :--- | :--- | :--- | :--- |`. The colons hold every column against the left margin, so each label begins where its column begins instead of floating in the middle of the cell.

The column labels are written once, in the table's real header row, where the first cell carries the first type's name in place of `File`. Every later type is announced by nothing more than its bold name in the first cell, with the rest of that row empty apart from its padding, and the labels are never repeated.

There are no per-type totals. Each type is its own label row followed by its file rows, and the only figures summed anywhere are in the closing **Grand total** row.

- **File** — the column headed by the type name — is a clickable Markdown link to the whole file, using the path from the repository root. The link text is the file's name **with its suffix dropped**, so `frontend/ui/example.js` reads as `[example](frontend/ui/example.js)`. No line number goes on this link; reaching a particular change is what the next column is for.
- **Location** is the line range the change occupies after the edit, written as plain numbers such as `640-657`, or a single number when one line changed. Every range is its own link into that part of the file, as in `[640-657](frontend/app_server/dfm_service.py#L640-L657)`. List several ranges separated by commas when the edits are far apart, each carrying its own link. A brand-new file gets its whole span written out the same way, `1-208` for a file 208 lines long, so every row reads as a range. In the **Grand total** row the cell holds nothing but its padding.
- **LOC** is the file's current total line count, after the change. In the **Grand total** row the cell stays empty apart from its padding — the total does not mean anything and is not worth the width.
- **Added** and **Deleted** are the lines added and the lines removed **in this turn alone**, not the total since the last commit. Count them from the exact text each edit replaced, and keep them in two separate columns — `+18` in one and `-4` in the other — rather than one combined cell. A figure of zero is never written out: leave the cell empty apart from its padding, in the file rows and the **Grand total** row alike, so only real numbers catch the eye. For a brand-new file write `New` under **Added**, since its whole length is new, and leave **Deleted** empty.

The table carries no column for describing the change. Anything worth saying about what a file now does belongs in the prose above the table, not beside it.

The four middle columns hold short values, so the reader squeezes them until they are hard to read. Widen them with the padding shown above: three braille blank characters (U+2800) at the **right-hand end** of each of those four headers and of every value beneath them, and nothing on the left. Ordinary spaces and no-break spaces do not survive — the reader trims them — but a braille blank is a normal printable character that happens to draw nothing, so it always holds its width. Copy the padding from the example above rather than retyping it. The **File** column is wide already and takes no padding.

Nothing separates one type from the next: the bold name in the first cell does that on its own, so no blank rows go anywhere in the table. Close the whole table with a **Grand total (x)** row carrying the number of files touched and the added and the removed lines summed across every type. When only one type was touched the **Grand total** row still closes the table.

A new file contributes its whole length to the added total even though its own row says only `New`.

Read the LOC figure from the file itself rather than estimating it. Do not take the Added and Deleted figures from a diff against the last commit, which accumulates across turns and would overstate what this turn did.

Keep the files of one type together, ordered Python first, then JavaScript, then other code such as HTML, CSS, PowerShell, and batch files, then configuration, then documentation. Gather the last three kinds under one **Other code**, **Configuration**, and **Documentation** label rather than splitting them further. Within each type put the largest file first, ordered by the LOC column.

Include every file: code, documentation, tests, configuration, release notes, and generated output. The one exception is a macro backup copy under `python-api/macros/backup/`: archiving the previous version is a mechanical step of every macro edit, not a change of its own, so leave those copies out of the table and out of the **Grand total** count. If the task changed nothing, write `Changed files: none` on a line of its own, with a blank line above it, instead of an empty table.
