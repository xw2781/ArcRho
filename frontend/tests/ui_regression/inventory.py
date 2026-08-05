"""Curated test inventory for the ArcRho UI regression workflow.

The fixture project holds 31 reserving classes, 2,089 dataset sidecars and 569 methods, and most
of those objects are near-duplicates. Testing all of them is neither affordable nor informative.
Instead the workflow keeps a checked-in list of *representatives*: one object standing in for a
group of similar ones.

The list is jointly owned. An agent seeds it by clustering objects it finds; a human edits it by
hand. The merge rules below exist so neither side clobbers the other - in particular so that a
human deleting an entry makes it stay deleted, which naive "regenerate the list" tooling always
gets wrong.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Iterator

INVENTORY_VERSION = 1
DEFAULT_INVENTORY_PATH = Path(__file__).resolve().parent / "test_inventory.json"

# Ordering used when writing entries back, so hand edits produce clean diffs.
_ENTRY_KEY_ORDER = (
    "kind",
    "type",
    "name",
    "group",
    "represents",
    "reason",
    "source",
    "enabled",
    "pinned",
)


@dataclass(frozen=True)
class EntryKey:
    """Identity of an inventory entry. Case-insensitive: ArcRho paths and names are not case-typed."""

    path: str
    kind: str
    name: str
    type: str = ""

    @classmethod
    def of(cls, reserving_class_path: str, entry: dict[str, Any]) -> "EntryKey":
        return cls(
            path=str(reserving_class_path or "").strip().lower(),
            kind=str(entry.get("kind") or "").strip().lower(),
            name=str(entry.get("name") or "").strip().lower(),
            type=str(entry.get("type") or "").strip().lower(),
        )


@dataclass
class InventoryEntry:
    kind: str  # "dataset" | "method"
    name: str
    group: str
    type: str = ""  # method type: DFM | BF | CC | RS | BSSR | BSCRA
    represents: int = 1
    reason: str = ""
    source: str = "agent"  # "agent" | "human"
    enabled: bool = True
    pinned: bool = False

    def to_json(self) -> dict[str, Any]:
        raw = asdict(self)
        return {key: raw[key] for key in _ENTRY_KEY_ORDER if key in raw and raw[key] != ""}


@dataclass
class ReservingClassEntries:
    path: str
    entries: list[dict[str, Any]] = field(default_factory=list)


class TestInventory:
    """Load, query, and safely extend the inventory file."""

    def __init__(self, payload: dict[str, Any] | None = None, *, source_path: Path | None = None):
        data = payload if isinstance(payload, dict) else {}
        self.version = int(data.get("version") or INVENTORY_VERSION)
        self.project = str(data.get("project") or "")
        self.source_path = source_path
        self._classes: list[dict[str, Any]] = []
        for item in data.get("reserving_classes") or []:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "").strip()
            if not path:
                continue
            entries = [e for e in (item.get("entries") or []) if isinstance(e, dict)]
            self._classes.append({"path": path, "entries": entries})
        self._excluded: list[dict[str, Any]] = [
            e for e in (data.get("excluded") or []) if isinstance(e, dict)
        ]

    # -- loading / saving --------------------------------------------------------

    @classmethod
    def load(cls, path: str | Path | None = None) -> "TestInventory":
        target = Path(path) if path else DEFAULT_INVENTORY_PATH
        if not target.exists():
            return cls({"version": INVENTORY_VERSION}, source_path=target)
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise ValueError(f"{target} is not valid JSON: {exc}") from exc
        return cls(payload, source_path=target)

    def to_json(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "project": self.project,
            "reserving_classes": [
                {
                    "path": item["path"],
                    "entries": sorted(
                        item["entries"],
                        key=lambda e: (
                            str(e.get("kind") or ""),
                            str(e.get("type") or ""),
                            str(e.get("name") or ""),
                        ),
                    ),
                }
                for item in sorted(self._classes, key=lambda c: c["path"].lower())
            ],
            "excluded": sorted(
                self._excluded,
                key=lambda e: (
                    str(e.get("path") or ""),
                    str(e.get("kind") or ""),
                    str(e.get("name") or ""),
                ),
            ),
        }

    def save(self, path: str | Path | None = None) -> Path:
        target = Path(path) if path else (self.source_path or DEFAULT_INVENTORY_PATH)
        target.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(self.to_json(), indent=2, ensure_ascii=False) + "\n"
        temp = target.with_suffix(target.suffix + ".tmp")
        temp.write_text(text, encoding="utf-8")
        temp.replace(target)
        return target

    # -- querying ----------------------------------------------------------------

    def reserving_class_paths(self) -> list[str]:
        return [item["path"] for item in self._classes]

    def entries_for(self, reserving_class_path: str, *, include_disabled: bool = False) -> list[dict[str, Any]]:
        wanted = str(reserving_class_path or "").strip().lower()
        for item in self._classes:
            if item["path"].strip().lower() != wanted:
                continue
            if include_disabled:
                return list(item["entries"])
            return [e for e in item["entries"] if e.get("enabled", True)]
        return []

    def iter_enabled(self) -> Iterator[tuple[str, dict[str, Any]]]:
        for item in self._classes:
            for entry in item["entries"]:
                if entry.get("enabled", True):
                    yield item["path"], entry

    def covered_groups(self, reserving_class_path: str) -> set[str]:
        """Groups already decided for this class.

        Disabled entries count as covered. That is the point: switching an entry off must not make
        the builder re-propose the same group on the next run.
        """
        groups: set[str] = set()
        for entry in self.entries_for(reserving_class_path, include_disabled=True):
            group = str(entry.get("group") or "").strip().lower()
            if group:
                groups.add(group)
        for item in self._excluded:
            if str(item.get("path") or "").strip().lower() != str(reserving_class_path).strip().lower():
                continue
            group = str(item.get("group") or "").strip().lower()
            if group:
                groups.add(group)
        return groups

    def is_excluded(self, reserving_class_path: str, entry: dict[str, Any]) -> bool:
        key = EntryKey.of(reserving_class_path, entry)
        for item in self._excluded:
            if EntryKey.of(item.get("path", ""), item) == key:
                return True
        return False

    def method_types_covered(self) -> set[str]:
        return {
            str(entry.get("type") or "").strip().upper()
            for _, entry in self.iter_enabled()
            if str(entry.get("kind") or "") == "method" and entry.get("type")
        }

    # -- mutation ----------------------------------------------------------------

    def add_entries(
        self,
        reserving_class_path: str,
        entries: Iterable[InventoryEntry | dict[str, Any]],
    ) -> dict[str, int]:
        """Append agent-proposed entries.

        Append-only by design. An existing entry is never edited or removed, so a human's edits
        survive any number of builder runs. Proposals are dropped when the identity already
        exists, the group is already covered, or the object is tombstoned.
        """
        path = str(reserving_class_path or "").strip()
        if not path:
            raise ValueError("A reserving class path is required.")

        bucket = next((c for c in self._classes if c["path"].strip().lower() == path.lower()), None)
        if bucket is None:
            bucket = {"path": path, "entries": []}
            self._classes.append(bucket)

        existing_keys = {EntryKey.of(path, e) for e in bucket["entries"]}
        covered = self.covered_groups(path)
        stats = {"added": 0, "skipped_duplicate": 0, "skipped_group": 0, "skipped_excluded": 0}

        for candidate in entries:
            payload = candidate.to_json() if isinstance(candidate, InventoryEntry) else dict(candidate)
            payload.setdefault("source", "agent")
            payload.setdefault("enabled", True)

            if EntryKey.of(path, payload) in existing_keys:
                stats["skipped_duplicate"] += 1
                continue
            if self.is_excluded(path, payload):
                stats["skipped_excluded"] += 1
                continue
            group = str(payload.get("group") or "").strip().lower()
            if group and group in covered:
                stats["skipped_group"] += 1
                continue

            bucket["entries"].append(payload)
            existing_keys.add(EntryKey.of(path, payload))
            if group:
                covered.add(group)
            stats["added"] += 1

        return stats

    def exclude(self, reserving_class_path: str, entry: dict[str, Any], note: str = "") -> None:
        """Tombstone an object so the builder never re-proposes it."""
        path = str(reserving_class_path or "").strip()
        record = {
            "path": path,
            "kind": str(entry.get("kind") or ""),
            "name": str(entry.get("name") or ""),
        }
        if entry.get("type"):
            record["type"] = str(entry["type"])
        if entry.get("group"):
            record["group"] = str(entry["group"])
        if note:
            record["note"] = note
        if not any(EntryKey.of(i.get("path", ""), i) == EntryKey.of(path, record) for i in self._excluded):
            self._excluded.append(record)

        bucket = next((c for c in self._classes if c["path"].strip().lower() == path.lower()), None)
        if bucket:
            key = EntryKey.of(path, record)
            bucket["entries"] = [e for e in bucket["entries"] if EntryKey.of(path, e) != key]

    def set_enabled(self, reserving_class_path: str, name: str, enabled: bool, *, kind: str = "") -> bool:
        wanted_name = str(name or "").strip().lower()
        wanted_kind = str(kind or "").strip().lower()
        for item in self._classes:
            if item["path"].strip().lower() != str(reserving_class_path).strip().lower():
                continue
            for entry in item["entries"]:
                if str(entry.get("name") or "").strip().lower() != wanted_name:
                    continue
                if wanted_kind and str(entry.get("kind") or "").strip().lower() != wanted_kind:
                    continue
                entry["enabled"] = bool(enabled)
                return True
        return False

    # -- diagnostics -------------------------------------------------------------

    def summary(self) -> dict[str, Any]:
        datasets = 0
        methods = 0
        disabled = 0
        for item in self._classes:
            for entry in item["entries"]:
                if not entry.get("enabled", True):
                    disabled += 1
                    continue
                if str(entry.get("kind") or "") == "method":
                    methods += 1
                else:
                    datasets += 1
        return {
            "reserving_classes": len(self._classes),
            "datasets": datasets,
            "methods": methods,
            "disabled": disabled,
            "excluded": len(self._excluded),
            "method_types": sorted(self.method_types_covered()),
        }
