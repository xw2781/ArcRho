"""The Gateway's one receipt store, shared by hosted saves and workspace mutations.

A receipt binds one request id to one canonical request and records its
outcome on the server's local disk, so a repeat of the same request answers
from the receipt instead of running twice. Hosted-save receipts sit directly
under ``runtime\\arcrho_gateway\\receipts``; workspace-mutation receipts sit
under ``mutations\\<user>`` there (``mutation_receipt_path``). Both expire
together when the Gateway starts.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from arcrho_api.io import persisted_json_text
from arcrho_hosted_save_http_contract import receipts_root


_RECEIPT_LOCKS_GUARD = threading.Lock()
_RECEIPT_LOCKS: dict[str, threading.RLock] = {}
TERMINAL_STATES = frozenset({"success", "error"})


class ReceiptReadError(Exception):
    """A receipt exists but cannot be read as a JSON object."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temporary.write_text(persisted_json_text(dict(payload)), encoding="utf-8")
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise ReceiptReadError("A Gateway receipt could not be read.") from exc
    if not isinstance(payload, dict):
        raise ReceiptReadError("A Gateway receipt is invalid.")
    return payload


def receipt_lock(key: str) -> threading.RLock:
    """One lock per receipt, held for the whole run so a repeat waits for it."""

    with _RECEIPT_LOCKS_GUARD:
        return _RECEIPT_LOCKS.setdefault(key, threading.RLock())


def prune_terminal_receipts(root: Path, retention_hours: int) -> int:
    """Remove only terminal receipts older than the configured window."""

    folder = receipts_root(root)
    if not folder.is_dir():
        return 0
    cutoff = time.time() - timedelta(hours=retention_hours).total_seconds()
    removed = 0
    for path in folder.rglob("*.json"):
        try:
            if path.stat().st_mtime >= cutoff:
                continue
            receipt = read_json(path)
            if receipt is not None and receipt.get("state") in TERMINAL_STATES:
                path.unlink()
                removed += 1
        except (OSError, ReceiptReadError):
            continue
    return removed
