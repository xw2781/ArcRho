---
name: update-arcrho-ui-design
description: Update the ArcRho UI Design skill after a completed and user-tested ArcRho frontend UI fix. Use only after the user says a specific UI bug fix or visual consistency decision is finished/tested and asks to add, record, codify, document, or turn that fix into durable ArcRho UI design guidance.
---

# Update ArcRho UI Design

## Purpose

Convert a completed, user-tested ArcRho UI fix into concise, reusable guidance in `.codex/skills/arcrho-ui-design/SKILL.md` so future UI work repeats the improved pattern.

## Workflow

1. Confirm the user is asking to document a specific UI fix that is already completed and tested by the user. If the fix is still being designed, implemented, or validated, do not use this skill yet.
2. Read the current request and recent implementation context. Identify the durable design principle behind the verified fix, not just the specific bug.
3. Read `frontend/AGENTS.md` and `.codex/skills/arcrho-ui-design/SKILL.md` before editing.
4. Choose the narrowest existing section in the ArcRho UI Design skill:
   - Use **Controls And States** for buttons, inputs, dropdowns, toggles, pickers, menus, chips, focus, hover, selected, disabled, and keyboard state rules.
   - Use **Layout System** for spacing, page frame, tabbed page, panel, and responsive layout rules.
   - Use **Typography** for label weight, casing, text scale, and fit rules.
   - Use **Table Design Rules** only for table-specific behavior.
   - Use **What To Avoid** for prohibitions that apply broadly.
5. Write one compact future-facing bullet or sentence that names the reusable pattern and expected visual behavior. Keep it app-design-specific and avoid implementation details unless they are essential.
6. Do not overfit to a single page. Mention a page only when the rule is intentionally page-specific.
7. Add or update an unreleased fragment when repository rules require it.
8. Run skill validation with `py -3.10 C:\Users\xwei.PRCINS\.codex\skills\.system\skill-creator\scripts\quick_validate.py .codex\skills\arcrho-ui-design`.
9. Run the frontend docs workflow from the repo root: `py -3.10 frontend/tools/docs_index_builder.py --write`, then `py -3.10 frontend/tools/docs_index_builder.py --check`. If a release fragment changed, also run `py -3.10 frontend/build/release_notes.py check`.

## Rule Writing Style

- Prefer direct bullets that match the existing design guide tone.
- Use "should" for expectations and "must" only for hard constraints.
- Include the opened state for controls that reveal UI, such as dropdown menus and popovers.
- Name visible states: rest, hover, selected, disabled, focus, keyboard navigation, and sizing, when relevant.
- Keep examples short; the skill is the rulebook, not the implementation diary.
