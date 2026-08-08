"""Open-window change-watch fingerprints.

A dataset window or method page remembers the fingerprint of the object it
opened and polls it on an interval. When another user or an automation
process (including the dependent-propagation job) rewrites the object, the
fingerprint moves and the window shows a one-time advisory alert. The
fingerprint is stat-only — size plus ``mtime_ns`` of the object's files —
so one poll costs at most two filesystem stats and never reads a payload.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

from fastapi import HTTPException

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


def object_change_fingerprint(
    project_name: str,
    reserving_class: str,
    kind: str,
    name: str,
    method_type: str = "",
    output_dataset: str = "",
) -> Dict[str, Any]:
    project = str(project_name or "").strip()
    rc = str(reserving_class or "").strip()
    object_name = str(name or "").strip()
    if not project or not rc or not object_name:
        raise HTTPException(400, "project_name, reserving_class, and name are required.")

    files: List[Dict[str, Any]] = []
    if kind == "dataset":
        # Every durable dataset mutation (grid save, sidecar save, propagation
        # refresh) rewrites the sidecar, so its stat covers the instance.
        sidecar = dataset_sidecar_status_service.sidecar_path(project, rc, object_name)
        files.append(_stat_fingerprint("sidecar", sidecar))
    elif kind == "method":
        try:
            method_json = dataset_sidecar_status_service.method_json_path(
                project, rc, method_type, object_name
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        files.append(_stat_fingerprint("method", method_json))
        output_name = str(output_dataset or "").strip()
        if output_name:
            sidecar = dataset_sidecar_status_service.sidecar_path(project, rc, output_name)
            files.append(_stat_fingerprint("sidecar", sidecar))
    else:
        raise HTTPException(400, f"Unknown object kind: {kind}")

    token = json.dumps(
        [[item["role"], item["exists"], item["size"], item["mtime_ns"]] for item in files],
        separators=(",", ":"),
    )
    return {"ok": True, "files": files, "token": token}
