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
    created_at: float = field(default_factory=time.time)
    result: Optional[Dict[str, Any]] = None


_LOCK = Condition()
_QUEUE: List[str] = []
_PENDING: Dict[str, _PendingCommand] = {}
_MAX_TIMEOUT_SEC = 120.0


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
        "created_at": item.created_at,
    }


def submit_command(command: str, target: Dict[str, Any], args: Dict[str, Any], timeout_sec: float) -> Dict[str, Any]:
    name = str(command or "").strip()
    if not name:
        raise HTTPException(400, "Command is required.")

    timeout = _normalize_timeout(timeout_sec, default=30.0)
    item = _PendingCommand(
        id=uuid.uuid4().hex,
        command=name,
        target=_clean_dict(target),
        args=_clean_dict(args),
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


def poll_command(timeout_sec: float = 20.0) -> Dict[str, Any]:
    timeout = _normalize_timeout(timeout_sec, default=20.0)
    deadline = time.monotonic() + timeout
    with _LOCK:
        while True:
            while _QUEUE:
                command_id = _QUEUE.pop(0)
                item = _PENDING.get(command_id)
                if item is not None and item.result is None:
                    return {"ok": True, "command": _command_payload(item)}

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"ok": True, "command": None}
            _LOCK.wait(timeout=remaining)


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
                {"id": item.id, "command": item.command, "created_at": item.created_at}
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
