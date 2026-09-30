from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from threading import Condition
from typing import Any, Dict, List, Optional

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


_LOCK = Condition()
_QUEUE: List[str] = []
_PENDING: Dict[str, _PendingCommand] = {}
_MAX_TIMEOUT_SEC = 120.0
# How long a command addressed to one window waits for that window before any
# window may take it. A window that has gone (its app closed mid-macro) must not
# stall the macro until the caller's own deadline.
OWNER_GRACE_SEC = 3.0


def _clean_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalize_timeout(value: Any, *, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(0.1, min(_MAX_TIMEOUT_SEC, number))


def _command_payload(item: _PendingCommand) -> Dict[str, Any]:
    return {
        "id": item.id,
        "command": item.command,
        "target": item.target,
        "args": item.args,
        "timeout_sec": item.timeout_sec,
        "owner": item.owner,
        "created_at": item.created_at,
    }


def _owner_wait_remaining(item: _PendingCommand, client_id: str, now: float) -> float:
    """Seconds before `client_id` may take `item`; zero when it may take it now."""
    if not item.owner or item.owner == client_id:
        return 0.0
    return max(0.0, item.created_monotonic + OWNER_GRACE_SEC - now)


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
    grace period passes; after that any window may take it.
    """
    timeout = _normalize_timeout(timeout_sec, default=20.0)
    client = str(client_id or "").strip()
    deadline = time.monotonic() + timeout
    with _LOCK:
        while True:
            now = time.monotonic()
            next_claimable: Optional[float] = None
            for command_id in list(_QUEUE):
                item = _PENDING.get(command_id)
                if item is None or item.result is not None:
                    _QUEUE.remove(command_id)
                    continue
                wait = _owner_wait_remaining(item, client, now)
                if wait <= 0:
                    _QUEUE.remove(command_id)
                    return {"ok": True, "command": _command_payload(item)}
                next_claimable = wait if next_claimable is None else min(next_claimable, wait)

            remaining = deadline - time.monotonic()
            if remaining <= 0:
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
