# Frontend Behavior Contract

## Purpose
Set lightweight frontend behavior guardrails for the current pre-production app.

Prefer clean coordinated refactors over compatibility shims unless the user explicitly asks for migration support.

## Scope
This contract applies when changing shell/tab orchestration, iframe pages, keyboard/menu actions, or cross-frame `arcrho:*` messages.

## Core Rules
1. Preserve shell and iframe state semantics unless intentionally changing them. Keep tab state, iframe lifecycle, and dirty-state prompts coherent.
2. Change `arcrho:*` message contracts only as coordinated refactors. Update all known producers, consumers, and docs in the same change.
3. Keep user-facing save, close, restart, import/export, and error flows explicit. Do not silently swallow failures for actions users can observe or depend on.
4. Avoid lifecycle and performance regressions such as duplicate listeners, accidental full reloads, infinite refresh loops, lost tab state, or iframe recreation unless the task intentionally changes that behavior.
5. Keep Project Instance disk-backed dataset inventory refreshes tied to durable saves or explicit user refreshes. Unsaved Dataset grid edits, including pasted Excel references, may publish in-memory dependency previews but must not trigger an inventory refresh.
6. Keep one owner for the Details tab. `ui/shared/tabs/details/details_form_layout.css` owns label and field typography, colour, size, and focus for every `.arDetailsRoot` page; a page stylesheet may add layout a field genuinely needs, such as a picker inset, but must not restate the shared look. `ui/shared/tabs/details/details_host_fields.js` owns which rows a host suppresses: a row whose value the host fixes is tagged `data-details-field` on both of its grid cells and is hidden everywhere except a Workflow step, the one host that still lets the user choose the project inside the embedded page. Hide such a row rather than removing its control, because page controllers read and write those inputs whether or not the host shows them. Every Details tab is one evenly spaced list of fields with no visual grouping: `Name` is the first row and the output identity row is the second - `Dataset Type` in the Dataset Viewer and `Output Type` on every method page, including DFM, which no longer labels it `Output Vector`. The reserving-class row is labelled `Segment` on every Details tab. A page may still wrap a set of rows in an `.arDetailsGroup` when it shows or hides them together, but the wrapper adds no padding and `--ar-details-group-separation` equals `--ar-details-row-gap`, so no wrapper reads as a group.

## Before Finishing
1. State which behavior area changed, or state "no frontend behavior impact."
2. Update relevant MANUAL sections in `docs/ui/*.md` when behavior changes.
3. Run `python tools/docs_index_builder.py --write`.
4. Run `python tools/docs_index_builder.py --check`.
