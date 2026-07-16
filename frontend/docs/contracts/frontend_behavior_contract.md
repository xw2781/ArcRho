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

## Before Finishing
1. State which behavior area changed, or state "no frontend behavior impact."
2. Update relevant MANUAL sections in `docs/ui/*.md` when behavior changes.
3. Run `python tools/docs_index_builder.py --write`.
4. Run `python tools/docs_index_builder.py --check`.
