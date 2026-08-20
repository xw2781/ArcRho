"""Open-window change-watch fingerprints.

A dataset window or method page remembers the fingerprint of the object it
opened and polls it on an interval. When another user or an automation
process (including the dependent-propagation job) rewrites the object, the
fingerprint moves and the window shows a one-time advisory alert. The
fingerprint is stat-only — size plus ``mtime_ns`` of the object's files —
so one poll costs at most two filesystem stats and never reads a payload.

Naming who moved it needs the payload, so that read is a separate endpoint
the window calls once, only after a fingerprint actually moved: the poll's
per-interval cost stays two stats, and a window on a mapped drive pays for
one sidecar read per alert rather than per poll.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Tuple

from fastapi import HTTPException

from arcrho_api.sidecar_audit_contract import sidecar_attribution

from app_server.services import dataset_sidecar_status_service


def _stat_fingerprint(role: str, path: str) -> Dict[str, Any]:
    try:
        stat_result = os.stat(path)
    except FileNotFoundError:
        return {"role": role, "exists": False, "size": None, "mtime_ns": None}
    except OSError as exc:
        raise HTTPException(
            503,
            f"Unable to check the opened {role} file for changes.",
        ) from exc
    return {
        "role": role,
        "exists": True,
        "size": int(stat_result.st_size),
        "mtime_ns": int(stat_result.st_mtime_ns),
    }


def _watched_paths(
    project_name: str,
    reserving_class: str,
    kind: str,
    name: str,
    method_type: str = "",
    output_dataset: str = "",
) -> List[Tuple[str, str]]:
    """Resolve the files one watched object is made of, in report order."""

    project = str(project_name or "").strip()
    rc = str(reserving_class or "").strip()
    object_name = str(name or "").strip()
    if not project or not rc or not object_name:
        raise HTTPException(400, "project_name, reserving_class, and name are required.")

    if kind == "dataset":
        # Every durable dataset mutation (grid save, sidecar save, propagation
        # refresh) rewrites the sidecar, so its stat covers the instance.
        return [("sidecar", dataset_sidecar_status_service.sidecar_path(project, rc, object_name))]
    if kind == "method":
        try:
            method_json = dataset_sidecar_status_service.method_json_path(
                project, rc, method_type, object_name
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        paths = [("method", method_json)]
        output_name = str(output_dataset or "").strip()
        if output_name:
            paths.append(
                ("sidecar", dataset_sidecar_status_service.sidecar_path(project, rc, output_name))
            )
        return paths
    raise HTTPException(400, f"Unknown object kind: {kind}")


def object_change_fingerprint(
    project_name: str,
    reserving_class: str,
    kind: str,
    name: str,
    method_type: str = "",
    output_dataset: str = "",
) -> Dict[str, Any]:
    files = [
        _stat_fingerprint(role, path)
        for role, path in _watched_paths(
            project_name, reserving_class, kind, name, method_type, output_dataset
        )
    ]
    token = json.dumps(
        [[item["role"], item["exists"], item["size"], item["mtime_ns"]] for item in files],
        separators=(",", ":"),
    )
    return {"ok": True, "files": files, "token": token}


def _method_attribution(path: str) -> Dict[str, Any]:
    """Fall back to the method payload when no sidecar names the writer.

    A method JSON has no user of its own — the write that produced it is
    recorded in its output sidecar's audit log — so this only recovers the
    time, for the case where the method file moved on its own (an RPC sync
    stamping ``last modified``, or a method whose output sidecar is gone).
    """

    payload = dataset_sidecar_status_service.read_sidecar(path)
    metadata = payload.get("method metadata")
    at = ""
    if isinstance(metadata, dict):
        at = str(metadata.get("last modified") or "").strip()
    return {"user": "", "action": "", "at": at, "automatic": False}


def object_change_attribution(
    project_name: str,
    reserving_class: str,
    kind: str,
    name: str,
    method_type: str = "",
    output_dataset: str = "",
) -> Dict[str, Any]:
    """Name the write that last moved a watched object.

    Called once, after the poll saw the fingerprint move, so the advisory
    alert can say who or what rewrote the object instead of only that
    something did. The attribution lives in the sidecar's audit log, which
    the object's own Audit Log tab already shows; automation records its own
    action there (``Auto Refresh`` for a dependent refresh) while a person's
    save records ``Insert``/``Update``.

    Advisory like the alert it serves: an unreadable or absent payload comes
    back as an empty attribution, never as an error, so the window still
    shows its generic message.
    """

    paths = _watched_paths(
        project_name, reserving_class, kind, name, method_type, output_dataset
    )
    attribution = {"user": "", "action": "", "at": "", "automatic": False}
    subject = "dataset"
    for role, path in paths:
        if role != "sidecar":
            continue
        payload = dataset_sidecar_status_service.read_sidecar(path)
        if payload:
            attribution = sidecar_attribution(payload)
        break
    if kind == "method":
        subject = "method"
        if not attribution["user"] and not attribution["at"]:
            attribution = _method_attribution(paths[0][1])

    return {"ok": True, "attribution": {**attribution, "subject": subject}}
