from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from threading import Condition
from typing import Any, Dict, List, Optional, Set

from fastapi import HTTPException


@dataclass
class _PendingCommand:
    id: str
    command: str
    target: Dict[str, Any]
    args: Dict[str, Any]
    # The submitter's own deadline, carried to the shell so an in-page handler can
    # size its wait to the caller's budget instead of guessing at a fixed one.
    timeout_sec: float = 30.0
    # The shell window that should run the command. Empty means any window may.
    owner: str = ""
    created_at: float = field(default_factory=time.time)
    created_monotonic: float = field(default_factory=time.monotonic)
    result: Optional[Dict[str, Any]] = None
    # Windows that handed the command back because they do not hold what it names.
    declined_by: Set[str] = field(default_factory=set)
    # The window that took the command and has not answered it yet.
    taken_by: str = ""


_LOCK = Condition()
_QUEUE: List[str] = []
_PENDING: Dict[str, _PendingCommand] = {}
# Window id -> when it last began or ended a poll, to know who else could answer.
_CLIENT_SEEN: Dict[str, float] = {}
# Windows whose page has gone; a poll they left running takes nothing more.
_LEFT: Set[str] = set()
_MAX_TIMEOUT_SEC = 120.0
# How long a command addressed to one window waits for that window before any
# window may take it. A window that has gone (its app closed mid-macro) must not
# stall the macro until the caller's own deadline.
OWNER_GRACE_SEC = 3.0
# A window counts as live this long after its last poll began or ended; the
# shell's own poll waits 20 seconds.
CLIENT_LIVE_SEC = 25.0


def _clean_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalize_timeout(value: Any, *, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(0.1, min(_MAX_TIMEOUT_SEC, number))


def _command_payload(item: _PendingCommand, *, may_decline: bool) -> Dict[str, Any]:
    return {
        "id": item.id,
        "command": item.command,
        "target": item.target,
        "args": item.args,
        "timeout_sec": item.timeout_sec,
        "owner": item.owner,
        "created_at": item.created_at,
        # False when no other live window is left to try, so this one answers as it can.
        "may_decline": may_decline,
    }


def _owner_wait_remaining(item: _PendingCommand, client_id: str, now: float) -> float:
    """Seconds before `client_id` may take `item`; zero when it may take it now."""
    if not item.owner or item.owner == client_id or item.owner in item.declined_by:
        return 0.0
    return max(0.0, item.created_monotonic + OWNER_GRACE_SEC - now)


def _has_other_candidate(item: _PendingCommand, client_id: str, now: float) -> bool:
    """Whether a live window other than `client_id` has not yet declined `item`."""
    for other, seen in list(_CLIENT_SEEN.items()):
        if now - seen > CLIENT_LIVE_SEC:
            _CLIENT_SEEN.pop(other, None)
        elif other != client_id and other not in item.declined_by:
            return True
    return False


def submit_command(
    command: str,
    target: Dict[str, Any],
    args: Dict[str, Any],
    timeout_sec: float,
    *,
    owner: str = "",
) -> Dict[str, Any]:
    name = str(command or "").strip()
    if not name:
        raise HTTPException(400, "Command is required.")

    timeout = _normalize_timeout(timeout_sec, default=30.0)
    item = _PendingCommand(
        id=uuid.uuid4().hex,
        command=name,
        target=_clean_dict(target),
        args=_clean_dict(args),
        timeout_sec=timeout,
        owner=str(owner or "").strip(),
    )
    deadline = time.monotonic() + timeout
    with _LOCK:
        _PENDING[item.id] = item
        _QUEUE.append(item.id)
        _LOCK.notify_all()

        while item.result is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _PENDING.pop(item.id, None)
                try:
                    _QUEUE.remove(item.id)
                except ValueError:
                    pass
                return {"ok": False, "error": f"Timed out waiting for UI command: {name}", "command_id": item.id}
            _LOCK.wait(timeout=remaining)

        return item.result


def poll_command(timeout_sec: float = 20.0, *, client_id: Optional[str] = None) -> Dict[str, Any]:
    """Hand the oldest command this window may run to it.

    A command addressed to another window is left queued for its owner until the
    grace period passes; after that any window may take it. A command this window
    has already declined is never offered to it again.
    """
    timeout = _normalize_timeout(timeout_sec, default=20.0)
    client = str(client_id or "").strip()
    deadline = time.monotonic() + timeout
    with _LOCK:
        if client and client not in _LEFT:
            # Seen at the start of a poll that lasts `timeout`, so it stays live until then.
            _CLIENT_SEEN[client] = time.monotonic() + timeout
        while True:
            if client in _LEFT:
                return {"ok": True, "command": None}
            now = time.monotonic()
            next_claimable: Optional[float] = None
            for command_id in list(_QUEUE):
                item = _PENDING.get(command_id)
                if item is None or item.result is not None:
                    _QUEUE.remove(command_id)
                    continue
                if client and client in item.declined_by:
                    continue
                wait = _owner_wait_remaining(item, client, now)
                if wait <= 0:
                    _QUEUE.remove(command_id)
                    item.taken_by = client
                    may_decline = bool(client) and _has_other_candidate(item, client, now)
                    if client:
                        _CLIENT_SEEN[client] = now
                    return {"ok": True, "command": _command_payload(item, may_decline=may_decline)}
                next_claimable = wait if next_claimable is None else min(next_claimable, wait)

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if client:
                    _CLIENT_SEEN[client] = time.monotonic()
                return {"ok": True, "command": None}
            # Wake when an addressed command this window is waiting on becomes free.
            _LOCK.wait(timeout=remaining if next_claimable is None else min(remaining, next_claimable))


def cancel_command(command_id: str) -> Dict[str, Any]:
    """Drop a queued or in-flight command.

    A harness that abandons a command client-side would otherwise leave it queued, and the next
    poll would execute it against the *following* scenario's UI state.
    """
    normalized_id = str(command_id or "").strip()
    if not normalized_id:
        raise HTTPException(400, "Command id is required.")

    with _LOCK:
        item = _PENDING.pop(normalized_id, None)
        try:
            _QUEUE.remove(normalized_id)
        except ValueError:
            pass
        if item is None:
            return {"ok": False, "cancelled": False, "error": "Command is no longer pending."}
        # Release the blocked submitter with an explicit outcome rather than letting it sit until
        # its own deadline.
        item.result = {
            "ok": False,
            "result": {},
            "error": "Command was cancelled.",
            "command_id": normalized_id,
            "cancelled": True,
        }
        _LOCK.notify_all()
    return {"ok": True, "cancelled": True, "command_id": normalized_id}


def decline_command(
    command_id: str, client_id: str, ok: bool, result: Dict[str, Any], error: str
) -> Dict[str, Any]:
    """Hand a command back from a window that does not hold what it names.

    It goes back to the front of the queue for another window, never this one. When
    no other live window is left to try, the decliner's own answer settles it, so a
    command cannot bounce forever.
    """
    normalized_id = str(command_id or "").strip()
    client = str(client_id or "").strip()
    if not normalized_id or not client:
        raise HTTPException(400, "Command id and client id are required.")

    with _LOCK:
        item = _PENDING.get(normalized_id)
        if item is None or item.result is not None:
            return {"ok": False, "error": "Command is no longer pending."}
        item.declined_by.add(client)
        now = time.monotonic()
        _CLIENT_SEEN[client] = now
        if _has_other_candidate(item, client, now):
            _QUEUE.insert(0, normalized_id)
            _LOCK.notify_all()
            return {"ok": True, "declined": True, "settled": False}
        _PENDING.pop(normalized_id, None)
        item.result = {
            "ok": bool(ok),
            "result": _clean_dict(result),
            "error": str(error or ""),
            "command_id": normalized_id,
        }
        _LOCK.notify_all()
    return {"ok": True, "declined": True, "settled": True}


def leave_client(client_id: str) -> Dict[str, Any]:
    """Forget a window whose page is closing.

    It stops counting as live at once, and every command addressed to it, or
    taken by it and not yet answered, goes to the windows still open without
    waiting for the grace period.
    """
    client = str(client_id or "").strip()
    if not client:
        raise HTTPException(400, "Client id is required.")

    with _LOCK:
        _LEFT.add(client)
        _CLIENT_SEEN.pop(client, None)
        for item in _PENDING.values():
            if client in (item.owner, item.taken_by):
                item.declined_by.add(client)
            if item.taken_by == client and item.result is None and item.id not in _QUEUE:
                _QUEUE.insert(0, item.id)
        _LOCK.notify_all()
    return {"ok": True}


def drain_pending() -> Dict[str, Any]:
    """Cancel everything outstanding. Used at suite teardown so one run cannot bleed into the next."""
    with _LOCK:
        ids = list(_PENDING.keys())
        for command_id in ids:
            item = _PENDING.pop(command_id, None)
            if item is None:
                continue
            item.result = {
                "ok": False,
                "result": {},
                "error": "Command was cancelled.",
                "command_id": command_id,
                "cancelled": True,
            }
        _QUEUE.clear()
        if ids:
            _LOCK.notify_all()
    return {"ok": True, "cancelled": len(ids)}


def queue_status() -> Dict[str, Any]:
    """Diagnostic view of the queue. Read-only."""
    with _LOCK:
        return {
            "ok": True,
            "queued": len(_QUEUE),
            "pending": len(_PENDING),
            "commands": [
                {"id": item.id, "command": item.command, "owner": item.owner, "created_at": item.created_at}
                for item in _PENDING.values()
            ],
        }


def complete_command(command_id: str, ok: bool, result: Dict[str, Any], error: str) -> Dict[str, Any]:
    normalized_id = str(command_id or "").strip()
    if not normalized_id:
        raise HTTPException(400, "Command id is required.")

    payload = {
        "ok": bool(ok),
        "result": _clean_dict(result),
        "error": str(error or ""),
        "command_id": normalized_id,
    }
    with _LOCK:
        item = _PENDING.pop(normalized_id, None)
        if item is None:
            return {"ok": False, "error": "Command is no longer pending."}
        item.result = payload
        _LOCK.notify_all()
    return {"ok": True}
