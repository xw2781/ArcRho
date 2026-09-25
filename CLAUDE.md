# CLAUDE.md

Read [AGENT_GUIDELINES.md](AGENT_GUIDELINES.md) before starting any task in this repository. It holds the instructions shared by every agent working here. The sections below apply to Claude only.

## Subagent Model (MUST)

Every subagent launched from this repository — through the Agent tool, a workflow, or a skill that spawns one — runs on Opus or Sonnet, chosen by how hard the work is. Pass the choice explicitly with the `model` parameter rather than letting a default decide.

- **Opus** for hard work: designing or changing behaviour across components, diagnosing a failure whose cause is unknown, reasoning about the persisted JSON contracts or the dependent walk, reviewing a change for correctness, or any step of a plan that writes real code.
- **Sonnet** for straightforward work: finding where something lives, reading files and reporting what they say, gathering log lines or test output, renaming or repeating a mechanical edit across many files, and other tasks with a clear procedure and little judgement.
- **Never Fable** unless the user has asked for it in this conversation. It is not the fallback for a small task; a small task gets Sonnet. If a skill, a workflow script, or an agent definition names Fable, stop and ask the user before running it.

When a task sits between the two, take Opus and say so in one short line.

## Final Response

Write for a reader who wants the outcome, not the implementation.

- **Plain English.** Short sentences, everyday words. Describe parts of the app by what they do ("the part that saves a method"), never by variable, function, class, or setting names. Linking to a file is fine.
- **Short.** A small task gets a few sentences, not a report.
- **Paragraphs** hold three sentences at most, with a blank line between every block.
- **Lists over prose.** Two or more like items (findings, steps, files, options) get one bullet each, led by two or three bold words. A bold lead-in introduces one line or a list, never a paragraph.
- **Numbers** go on their own line or in a small table, never mid-sentence.

### Changed files table

End every response that changed files with one table, copied in this exact shape, including the left-aligned separator and the padding:

## Changed files

| Python | Location⠀⠀⠀ | LOC⠀⠀⠀ | Added⠀⠀⠀ | Deleted⠀⠀⠀ |
| :--- | :--- | :--- | :--- | :--- |
| [dfm_service](frontend/app_server/dfm_service.py) | [640-657](frontend/app_server/dfm_service.py#L640-L657)⠀⠀⠀ | 1,204⠀⠀⠀ | +18⠀⠀⠀ | -4⠀⠀⠀ |
| **JavaScript** | ⠀⠀⠀ | ⠀⠀⠀ | ⠀⠀⠀ | ⠀⠀⠀ |
| [example](frontend/ui/example.js) | [42-47](frontend/ui/example.js#L42-L47), [180](frontend/ui/example.js#L180)⠀⠀⠀ | 312⠀⠀⠀ | +6⠀⠀⠀ | ⠀⠀⠀ |
| [formula_renderer](frontend/ui/shared/formula_renderer.mjs) | [1-208](frontend/ui/shared/formula_renderer.mjs#L1-L208)⠀⠀⠀ | 208⠀⠀⠀ | New⠀⠀⠀ | ⠀⠀⠀ |
| **Grand total (3)** | ⠀⠀⠀ | ⠀⠀⠀ | **+232**⠀⠀⠀ | **-4**⠀⠀⠀ |

- **Types** in order: Python, JavaScript, **Other code** (HTML, CSS, PowerShell, batch), **Configuration**, **Documentation**. The first type's name replaces `File` in the header; each later type gets one bold-name row with padded empty cells. No repeated headers, per-type totals, or blank rows. Within a type, largest LOC first.
- **File** links the whole file by its repo-root path; the link text drops the suffix. No line number.
- **Location** lists each changed range after the edit as its own link, comma-separated; one number for a single line; a new file shows its full span.
- **LOC** is the line count after the change, read from the file.
- **Added / Deleted** count this turn's edits only, never a diff against the last commit. A new file shows `New` under Added and counts its full length in the grand total.
- **Zeros are blank**: leave the cell as padding only, including in the grand total.
- **Grand total (N)** closes the table with the file count and summed Added and Deleted; its Location and LOC cells stay blank.
- **Padding** is three U+2800 braille blanks at the right end of every header and value in the four middle columns (the reader trims ordinary spaces). The File column takes none.
- **No description column**; explain changes in the prose above.
- **Every changed file** counts — code, tests, docs, config, release notes, generated output — except macro backups under `python-api/macros/backup/`. If nothing changed, write `Changed files: none` on its own line after a blank line.
