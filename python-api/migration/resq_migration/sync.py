"""Timestamp planning and durable baselines for ArcRho/ResQ synchronization.

This module owns the location-independent comparison contract used by the
``Sync Reserving Class with ResQ`` macro.  It deliberately does not know how
either side is inventoried or written; callers provide normalized inventory
items with parsed timestamps and use the resulting action plan to delegate to
the existing canonical import/export writers.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from arcrho_api.io import persisted_json_text


SYNC_STATE_VERSION = 1
SYNC_RUNTIME_API_VERSION = 1
SYNC_STATE_DIR = Path("sync") / "resq"
TIMESTAMP_TOLERANCE_SECONDS = 0.000001

ACTION_ARCRHO_TO_RESQ = "arcrho_to_resq"
ACTION_RESQ_TO_ARCRHO = "resq_to_arcrho"

_SPACE_RE = re.compile(r"\s+")


def clean_name(value: Any) -> str:
    """Return the whitespace-normalized display form used on both sides."""

    return _SPACE_RE.sub(" ", str(value or "").strip())


def logical_key(value: Any) -> str:
    """Return the case-insensitive logical identity used to pair artifacts."""

    return clean_name(value).casefold()


def parse_timestamp(value: Any) -> float | None:
    """Parse ArcRho absolute times and ResQ local wall-clock times canonically."""

    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return _timestamp(value)
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return _timestamp(float(raw))
    except ValueError:
        pass
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        return _timestamp(datetime.fromisoformat(normalized).timestamp())
    except ValueError:
        return None


def _timestamp(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _timestamps_equal(left: Any, right: Any) -> bool:
    left_value = _timestamp(left)
    right_value = _timestamp(right)
    if left_value is None or right_value is None:
        return False
    return abs(left_value - right_value) <= TIMESTAMP_TOLERANCE_SECONDS


def _changed_from_baseline(item: Mapping[str, Any] | None, baseline: Mapping[str, Any], prefix: str) -> bool | None:
    present = item is not None
    if present != bool(baseline.get(f"{prefix}_present")):
        return True
    if not present:
        return False
    current = _timestamp(item.get("modified_timestamp"))
    previous = _timestamp(baseline.get(f"{prefix}_timestamp"))
    if current is None or previous is None:
        return None
    return not _timestamps_equal(current, previous)


def _row_id(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]


def _state_signature(value: Mapping[str, Any] | None) -> dict[str, Any]:
    source = value if isinstance(value, Mapping) else {}
    return {
        "present": bool(source),
        "arcrho_present": bool(source.get("arcrho_present")),
        "resq_present": bool(source.get("resq_present")),
        "arcrho_timestamp": _timestamp(source.get("arcrho_timestamp")),
        "resq_timestamp": _timestamp(source.get("resq_timestamp")),
        "synced_at": str(source.get("synced_at") or ""),
    }


def _group_inventory(items: Iterable[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for raw in items:
        item = dict(raw)
        key = logical_key(item.get("name"))
        if key:
            grouped.setdefault(key, []).append(item)
    return grouped


def _support_for_action(
    action: str,
    arcrho: Mapping[str, Any] | None,
    resq: Mapping[str, Any] | None,
) -> tuple[bool, str]:
    if action == ACTION_ARCRHO_TO_RESQ:
        source = arcrho or {}
        target = resq or {}
        if not bool(source.get("can_export_to_resq", False)):
            return False, str(source.get("export_block_reason") or "ArcRho cannot export this item to ResQ.")
        if target and not bool(target.get("can_receive_from_arcrho", True)):
            return False, str(target.get("receive_block_reason") or "The ResQ item cannot be overwritten.")
        return True, ""
    if action == ACTION_RESQ_TO_ARCRHO:
        source = resq or {}
        if not bool(source.get("can_import_to_arcrho", False)):
            return False, str(source.get("import_block_reason") or "ArcRho cannot import this ResQ item.")
        return True, ""
    return False, "No synchronization action is available."


def _comparison_action(
    arcrho: Mapping[str, Any],
    resq: Mapping[str, Any],
    baseline: Mapping[str, Any] | None,
) -> tuple[str, str, str, bool]:
    """Return action, status, detail, and whether the row is a two-sided conflict."""

    local_time = _timestamp(arcrho.get("modified_timestamp"))
    remote_time = _timestamp(resq.get("modified_timestamp"))
    if local_time is None or remote_time is None:
        missing = []
        if local_time is None:
            missing.append("ArcRho")
        if remote_time is None:
            missing.append("ResQ")
        return "", "Unknown timestamp", f"{', '.join(missing)} timestamp is unavailable; no direction was inferred.", False

    if baseline:
        local_changed = _changed_from_baseline(arcrho, baseline, "arcrho")
        remote_changed = _changed_from_baseline(resq, baseline, "resq")
        if local_changed is False and remote_changed is False:
            return "", "Synchronized", "Neither side changed since the last accepted synchronization.", False
        if local_changed is True and remote_changed is False:
            return ACTION_ARCRHO_TO_RESQ, "ArcRho changed", "ArcRho changed since the last synchronization.", False
        if remote_changed is True and local_changed is False:
            return ACTION_RESQ_TO_ARCRHO, "ResQ changed", "ResQ changed since the last synchronization.", False
        if local_changed is True and remote_changed is True:
            if _timestamps_equal(local_time, remote_time):
                return "", "Both changed", "Both sides changed and have the same timestamp; choose neither and review manually.", True
            if local_time > remote_time:
                return ACTION_ARCRHO_TO_RESQ, "Both changed; ArcRho newer", "Both sides changed; the newer ArcRho timestamp is proposed.", True
            return ACTION_RESQ_TO_ARCRHO, "Both changed; ResQ newer", "Both sides changed; the newer ResQ timestamp is proposed.", True
        # An incomplete legacy/invalid baseline must never silently decide.
        return "", "Unknown baseline", "The saved synchronization baseline is incomplete; no direction was inferred.", False

    if _timestamps_equal(local_time, remote_time):
        return "", "Same timestamp", "The timestamps match; content equality was not assumed.", False
    if local_time > remote_time:
        return ACTION_ARCRHO_TO_RESQ, "ArcRho newer", "ArcRho has the newer timestamp.", False
    return ACTION_RESQ_TO_ARCRHO, "ResQ newer", "ResQ has the newer timestamp.", False


def build_sync_plan(
    arcrho_items: Iterable[Mapping[str, Any]],
    resq_items: Iterable[Mapping[str, Any]],
    state: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build a deterministic, reviewable plan over the items both inventories hold.

    An item on one side only is not a synchronization candidate: a new dataset
    or method reaches the other side through an import, not through this
    review, so such items never become rows.
    """

    local_groups = _group_inventory(arcrho_items)
    remote_groups = _group_inventory(resq_items)
    state_items = state.get("items") if isinstance(state, Mapping) and isinstance(state.get("items"), Mapping) else {}
    rows: list[dict[str, Any]] = []
    for key in sorted(set(local_groups) & set(remote_groups)):
        local_candidates = local_groups[key]
        remote_candidates = remote_groups[key]
        display_name = clean_name(local_candidates[0].get("name"))
        baseline = state_items.get(key) if isinstance(state_items, Mapping) and isinstance(state_items.get(key), Mapping) else None
        row: dict[str, Any] = {
            "id": _row_id(key),
            "key": key,
            "name": display_name,
            "arcrho": local_candidates[0] if len(local_candidates) == 1 else None,
            "resq": remote_candidates[0] if len(remote_candidates) == 1 else None,
            "action": "",
            "status": "",
            "detail": "",
            "selected": False,
            "disabled": True,
            "conflict": False,
            "state_signature": _state_signature(baseline),
        }
        if len(local_candidates) > 1 or len(remote_candidates) > 1:
            row.update(
                status="Ambiguous name",
                detail=(
                    f"Found {len(local_candidates)} ArcRho and {len(remote_candidates)} ResQ items "
                    "with the same normalized name."
                ),
            )
            rows.append(row)
            continue

        arcrho = row["arcrho"]
        resq = row["resq"]
        local_kind = clean_name((arcrho or {}).get("kind"))
        remote_kind = clean_name((resq or {}).get("kind"))
        row["kind"] = local_kind or remote_kind or "Dataset"
        if logical_key(local_kind) != logical_key(remote_kind):
            row.update(
                status="Type mismatch",
                detail=f"ArcRho identifies this as {local_kind}; ResQ identifies it as {remote_kind}.",
            )
            rows.append(row)
            continue

        local_format = clean_name(arcrho.get("data_format"))
        remote_format = clean_name(resq.get("data_format"))
        if local_format and remote_format and logical_key(local_format) != logical_key(remote_format):
            row.update(
                status="Format mismatch",
                detail=f"ArcRho is {local_format}; ResQ is {remote_format}.",
            )
            rows.append(row)
            continue
        local_type = clean_name(arcrho.get("dataset_type"))
        remote_type = clean_name(resq.get("dataset_type"))
        if local_type and remote_type and logical_key(local_type) != logical_key(remote_type):
            row.update(
                status="Dataset Type mismatch",
                detail=f"ArcRho uses {local_type}; ResQ uses {remote_type}.",
            )
            rows.append(row)
            continue
        local_method_name = clean_name(arcrho.get("method_name"))
        remote_method_name = clean_name(resq.get("method_name"))
        if (
            logical_key(local_kind) != logical_key("Dataset")
            and local_method_name
            and remote_method_name
            and logical_key(local_method_name) != logical_key(remote_method_name)
        ):
            row.update(
                status="Method mismatch",
                detail=(
                    f"ArcRho method {local_method_name} and ResQ method "
                    f"{remote_method_name} produce the same output name."
                ),
            )
            rows.append(row)
            continue

        action, status, detail, conflict = _comparison_action(arcrho, resq, baseline)
        row.update(action=action, status=status, detail=detail, conflict=conflict)
        if action:
            supported, reason = _support_for_action(action, arcrho, resq)
            if supported:
                row["disabled"] = False
                # Straightforward one-sided/newer changes are selected by default;
                # a two-sided conflict requires an explicit user opt-in.
                row["selected"] = not conflict
                if action == ACTION_ARCRHO_TO_RESQ:
                    scope_note = clean_name((arcrho or {}).get("export_scope_note"))
                    if scope_note:
                        row["status"] = f"{status}; supported fields only"
                        row["detail"] = f"{detail} {scope_note}".strip()
            else:
                row["status"] = f"{status}; unsupported"
                row["detail"] = f"{detail} {reason}".strip()
        rows.append(row)
    return rows


def plan_signature(row: Mapping[str, Any]) -> dict[str, Any]:
    """Return the immutable observations rechecked after the review window."""

    def side(item: Any) -> dict[str, Any]:
        source = item if isinstance(item, Mapping) else {}
        return {
            "present": bool(item),
            "kind": clean_name(source.get("kind")),
            "data_format": clean_name(source.get("data_format")),
            "method_name": clean_name(source.get("method_name")),
            "dataset_type": clean_name(source.get("dataset_type")),
            "modified_timestamp": _timestamp(source.get("modified_timestamp")),
        }

    return {
        "key": str(row.get("key") or ""),
        "action": str(row.get("action") or ""),
        "disabled": bool(row.get("disabled")),
        "conflict": bool(row.get("conflict")),
        "state_signature": dict(row.get("state_signature") or {}),
        "arcrho": side(row.get("arcrho")),
        "resq": side(row.get("resq")),
    }


def _signature_sides(
    left: Mapping[str, Any], right: Mapping[str, Any], side_name: str
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    a = left.get(side_name) if isinstance(left.get(side_name), Mapping) else {}
    b = right.get(side_name) if isinstance(right.get(side_name), Mapping) else {}
    return a, b


def _side_identity_equal(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    if bool(a.get("present")) != bool(b.get("present")):
        return False
    for field in ("kind", "data_format", "method_name", "dataset_type"):
        if clean_name(a.get(field)) != clean_name(b.get(field)):
            return False
    return True


def _side_timestamp_equal(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    a_time = _timestamp(a.get("modified_timestamp"))
    b_time = _timestamp(b.get("modified_timestamp"))
    if a_time is None or b_time is None:
        return a_time == b_time
    return _timestamps_equal(a_time, b_time)


def signatures_equal(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    if str(left.get("key") or "") != str(right.get("key") or ""):
        return False
    if str(left.get("action") or "") != str(right.get("action") or ""):
        return False
    if bool(left.get("disabled")) != bool(right.get("disabled")):
        return False
    if bool(left.get("conflict")) != bool(right.get("conflict")):
        return False
    if dict(left.get("state_signature") or {}) != dict(right.get("state_signature") or {}):
        return False
    for side_name in ("arcrho", "resq"):
        a, b = _signature_sides(left, right, side_name)
        if not _side_identity_equal(a, b) or not _side_timestamp_equal(a, b):
            return False
    return True


def write_signatures_equal(
    left: Mapping[str, Any], right: Mapping[str, Any], *, source_side: str
) -> bool:
    """Tell whether a row may still be written from ``source_side``.

    ``signatures_equal`` holds a whole row still, which is right while the
    review is open. Inside one write batch it is too strict: saving a DFM into
    ResQ makes ResQ recalculate every Result Selection downstream of it, and an
    import into ArcRho refreshes its dependents, so the batch itself re-stamps
    the target side of a later row and shifts its proposed action against the
    unchanged baseline. Here only the identity of both sides and the timestamp
    of the side being written from decide.
    """

    if source_side not in ("arcrho", "resq"):
        raise ValueError(f"Unknown source side: {source_side!r}")
    if str(left.get("key") or "") != str(right.get("key") or ""):
        return False
    for side_name in ("arcrho", "resq"):
        a, b = _signature_sides(left, right, side_name)
        if not _side_identity_equal(a, b):
            return False
        if side_name == source_side and not _side_timestamp_equal(a, b):
            return False
    return True


def sync_state_path(server_root: str | os.PathLike[str], project_name: Any, rc_path: Any, connection_name: Any) -> Path:
    """Return the project-owned state path without embedding machine-local paths."""

    project = clean_name(project_name)
    if not project or project in {".", ".."} or any(separator in project for separator in ("/", "\\")):
        raise ValueError("project_name must be one project folder name.")
    identity = "\0".join((project.casefold(), clean_name(rc_path).casefold(), clean_name(connection_name).casefold()))
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return Path(server_root) / "projects" / project / SYNC_STATE_DIR / f"{digest}.json"


def empty_sync_state(project_name: Any, rc_path: Any, connection_name: Any) -> dict[str, Any]:
    return {
        "version": SYNC_STATE_VERSION,
        "project_name": clean_name(project_name),
        "reserving_class": clean_name(rc_path),
        "connection_name": clean_name(connection_name),
        "updated_at": "",
        "items": {},
    }


def read_sync_state(path: str | os.PathLike[str], project_name: Any, rc_path: Any, connection_name: Any) -> dict[str, Any]:
    expected = empty_sync_state(project_name, rc_path, connection_name)
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return expected
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read synchronization state {source}: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"Synchronization state is invalid or belongs to another scope: {source}")
    if (
        payload.get("version") != SYNC_STATE_VERSION
        or clean_name(payload.get("project_name")) != expected["project_name"]
        or clean_name(payload.get("reserving_class")) != expected["reserving_class"]
        or clean_name(payload.get("connection_name")) != expected["connection_name"]
        or not isinstance(payload.get("items"), dict)
    ):
        raise RuntimeError(f"Synchronization state is invalid or belongs to another scope: {source}")
    return payload


def record_synced_items(
    state: Mapping[str, Any],
    keys: Iterable[str],
    arcrho_items: Iterable[Mapping[str, Any]],
    resq_items: Iterable[Mapping[str, Any]],
    *,
    synced_at: str | None = None,
) -> dict[str, Any]:
    """Return state updated only for keys that exist on both sides post-sync."""

    local = _group_inventory(arcrho_items)
    remote = _group_inventory(resq_items)
    updated = dict(state)
    entries = dict(state.get("items") or {}) if isinstance(state.get("items"), Mapping) else {}
    timestamp = str(synced_at or datetime.now(timezone.utc).isoformat()).strip()
    recorded: list[str] = []
    for raw_key in keys:
        key = logical_key(raw_key)
        local_items = local.get(key, [])
        remote_items = remote.get(key, [])
        if len(local_items) != 1 or len(remote_items) != 1:
            continue
        local_timestamp = _timestamp(local_items[0].get("modified_timestamp"))
        remote_timestamp = _timestamp(remote_items[0].get("modified_timestamp"))
        if local_timestamp is None or remote_timestamp is None:
            continue
        entries[key] = {
            "name": clean_name(local_items[0].get("name") or remote_items[0].get("name")),
            "kind": clean_name(local_items[0].get("kind") or remote_items[0].get("kind")),
            "arcrho_present": True,
            "resq_present": True,
            "arcrho_timestamp": local_timestamp,
            "resq_timestamp": remote_timestamp,
            "synced_at": timestamp,
        }
        recorded.append(key)
    updated["items"] = entries
    updated["updated_at"] = timestamp
    updated["_recorded_keys"] = recorded
    return updated


def write_sync_state(path: str | os.PathLike[str], state: Mapping[str, Any]) -> Path:
    """Atomically persist the one canonical synchronization-baseline document."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        payload = {key: value for key, value in state.items() if not str(key).startswith("_")}
        temporary.write_text(persisted_json_text(payload), encoding="utf-8", newline="\n")
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return target
