"""Canonical vocabulary and reader for persisted sidecar audit entries.

Every ArcRho output sidecar carries an ``audit_log``: one entry per durable
write, naming when it happened, which action produced it, and who ran it. The
entries are appended by the per-method output-sidecar builders in this package
(``build_dfm_output_sidecar`` and its siblings) and by the dataset writers in
the app server.

Two kinds of writer share that log. A person saving an object records
``Insert``/``Update``; an automation that rewrote the object without anyone
opening it -- the Engine dependent-propagation walk re-publishing a method
whose precedent moved -- records ``Auto Refresh``. Telling those apart is what
lets a reader name *what* changed an object rather than only *when*, so the
action names and that classification live here once instead of being repeated
as literals at every producer and consumer.
"""

from __future__ import annotations

from typing import Any, Mapping


AUDIT_ACTION_INSERT = "Insert"
AUDIT_ACTION_UPDATE = "Update"
AUDIT_ACTION_AUTO_REFRESH = "Auto Refresh"

# Actions a person performs on an object they opened.
INTERACTIVE_AUDIT_ACTIONS = frozenset({AUDIT_ACTION_INSERT, AUDIT_ACTION_UPDATE})
# Actions a background process performs on an object nobody opened.
AUTOMATIC_AUDIT_ACTIONS = frozenset({AUDIT_ACTION_AUTO_REFRESH})


def _clean(value: Any) -> str:
    return str(value or "").strip()


def normalize_audit_action(value: Any) -> str:
    """Return a stored action name in its canonical casing, or ``""``."""

    text = _clean(value)
    if not text:
        return ""
    folded = text.casefold()
    for known in (*INTERACTIVE_AUDIT_ACTIONS, *AUTOMATIC_AUDIT_ACTIONS):
        if folded == known.casefold():
            return known
    return text


def is_automatic_audit_action(value: Any) -> bool:
    """Say whether an action was produced by automation rather than a person."""

    return normalize_audit_action(value) in AUTOMATIC_AUDIT_ACTIONS


def latest_audit_entry(payload: Mapping[str, Any] | None) -> dict[str, str]:
    """Project the last usable ``audit_log`` entry of a sidecar payload.

    Entries are appended in write order, so the last one that names an action
    describes the write that produced the file as it stands.
    """

    entries = (payload or {}).get("audit_log")
    if not isinstance(entries, list):
        return {}
    for raw in reversed(entries):
        if not isinstance(raw, Mapping):
            continue
        action = normalize_audit_action(raw.get("action") or raw.get("Action"))
        if not action:
            continue
        return {
            "action": action,
            "at": _clean(raw.get("event_date") or raw.get("Event Date")),
            "user": _clean(raw.get("user") or raw.get("User")),
            "change_info": _clean(raw.get("change_info") or raw.get("Change Info")),
        }
    return {}


def sidecar_attribution(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    """Name the write that left a sidecar in its current state.

    The audit entry is the primary source because it carries the action; the
    sidecar's own ``modified_by``/``updated_at`` fill in whatever the entry
    does not have (a payload written with ``append_audit=False`` keeps both).
    """

    record = payload if isinstance(payload, Mapping) else {}
    entry = latest_audit_entry(record)
    action = entry.get("action", "")
    return {
        "user": entry.get("user") or _clean(record.get("modified_by") or record.get("user")),
        "action": action,
        "at": entry.get("at") or _clean(record.get("updated_at")),
        "automatic": is_automatic_audit_action(action),
    }
