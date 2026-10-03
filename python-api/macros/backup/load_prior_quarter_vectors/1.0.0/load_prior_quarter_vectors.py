# <arcrho-macro>
# Title: Load Prior Quarter Vectors
# Version: 1.0.0
# Release Note: Initial release.
# Description: Run once a quarter. Pick the prior quarter's project from a list, then copy every
#   Current Qtr Indicated and Selected vector (C 91/92, D 91/92, E 91/92, F 91/92, G 91/92 ...)
#   of every reserving class in that project into the matching Prior Qtr vector
#   (C 81/82, D 81/82 ...) of the same reserving class in the active project. Each
#   Prior Qtr vector is replaced in full and takes the stored length of the vector it was
#   copied from. A vector that is missing or empty in the prior project, or has no Prior Qtr
#   vector in the active class, is left untouched and listed in the summary. Every copy is
#   read back and checked against its source.
# Scope: Project
# Icon: sync
# </arcrho-macro>

from __future__ import annotations

import re
import time
from typing import Any

TITLE = "Load Prior Quarter Vectors"
BUSY_POLL_SECONDS = 2.0
BUSY_TIMEOUT_SECONDS = 15 * 60
MAX_REPORTED_LINES = 40

# A Current Qtr vector is "<category> 91" (Indicated) or "<category> 92"
# (Selected), the category being a letter with an optional digit (C, E1, E2 ...).
# Its Prior Qtr counterpart is the same category at 81 or 82. ResQ names carry
# stray double spaces, so every name is compared with its whitespace collapsed.
_VECTOR_KEY = re.compile(r"^([a-z]\d?) (8[12]|9[12])\b")
PRIOR_FOR_CURRENT = {"91": "81", "92": "82"}


def _clean(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split())


def _key_parts(name: Any) -> tuple[str, str] | None:
    match = _VECTOR_KEY.match(_clean(name).casefold())
    return (match.group(1), match.group(2)) if match else None


def _is_vector(entry: dict[str, Any]) -> bool:
    return _clean(entry.get("data_format")).casefold() == "vector"


def index_entries(index: Any) -> list[dict[str, Any]]:
    files = index.get("files") if isinstance(index, dict) else None
    return [entry for entry in files or [] if isinstance(entry, dict)]


def plan_class(source_index: Any, target_index: Any) -> dict[str, Any]:
    """Pair each Current Qtr vector of the source class with its Prior Qtr vector.

    Returns {"pairs": [(source entry, target entry)], "no_target": [source name]}.
    """
    targets: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in index_entries(target_index):
        parts = _key_parts(entry.get("name") or entry.get("dataset_type"))
        if parts and parts[1] in PRIOR_FOR_CURRENT.values() and _is_vector(entry):
            targets[parts] = entry
    pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    no_target: list[str] = []
    for entry in index_entries(source_index):
        parts = _key_parts(entry.get("name") or entry.get("dataset_type"))
        if not parts or parts[1] not in PRIOR_FOR_CURRENT or not _is_vector(entry):
            continue
        target = targets.get((parts[0], PRIOR_FOR_CURRENT[parts[1]]))
        if target is None:
            no_target.append(_clean(entry.get("name")))
        else:
            pairs.append((entry, target))
    return {"pairs": pairs, "no_target": no_target}


def stored_length(payload: dict[str, Any]) -> int:
    for key in ("stored_origin_length", "stored_period_length", "origin_length"):
        try:
            number = int(payload.get(key) or 0)
        except (TypeError, ValueError):
            number = 0
        if number > 0:
            return number
    return 0


def has_values(values: Any) -> bool:
    return any(
        isinstance(row, list) and row and row[0] is not None for row in values or []
    )


def same_values(left: Any, right: Any) -> bool:
    def column(values: Any) -> list[float | None]:
        out: list[float | None] = []
        for row in values or []:
            cell = row[0] if isinstance(row, list) and row else None
            out.append(None if cell is None or cell == "" else round(float(cell), 6))
        return out

    return column(left) == column(right)


def _error_text(exc: Exception) -> str:
    return _clean(getattr(exc, "detail", None)) or _clean(exc) or exc.__class__.__name__


def _wait_until_idle(gateway, project: str, rc: str, report) -> None:
    """Hold while a dependent walk still owns the class; a save during it is refused."""
    deadline = time.monotonic() + BUSY_TIMEOUT_SECONDS
    while True:
        report()
        busy = gateway.read("propagation_busy", project_name=project, reserving_class=rc)
        if not busy.get("busy"):
            return
        if time.monotonic() > deadline:
            raise RuntimeError(f"{rc} stayed busy for {BUSY_TIMEOUT_SECONDS // 60} minutes.")
        time.sleep(BUSY_POLL_SECONDS)


def copy_vector(gateway, source_project, project, rc, source, target, report) -> str:
    """Copy one vector. Returns "" on success or "skipped: ..." / "failed: ..." text."""
    source_name = _clean(source.get("name"))
    try:
        data = gateway.read(
            "dataset_cache_load",
            project_name=source_project,
            reserving_class=rc,
            dataset_name=source.get("name"),
        )
    except Exception as exc:
        return f"skipped: {source_name} could not be read in {source_project} ({_error_text(exc)})"
    values = data.get("values")
    if not has_values(values):
        return f"skipped: {source_name} is empty in {source_project}"
    length = stored_length(data)
    if not length:
        return f"failed: {source_name} reports no stored length"
    target_name = target.get("name")
    try:
        _wait_until_idle(gateway, project, rc, report)
        gateway.save(
            "dataset_sidecar",
            project,
            rc,
            target_name,
            data_format="Vector",
            source_kind="input",
            dataset_type=target.get("dataset_type") or target_name,
            origin_length=length,
            development_length=length,
            values=values,
            origin_labels=data.get("origin_labels"),
            stored_values_cleared=True,
        )
        written = gateway.read(
            "dataset_cache_load",
            project_name=project,
            reserving_class=rc,
            dataset_name=target_name,
        )
    except Exception as exc:
        return f"failed: {_clean(target_name)} ({_error_text(exc)})"
    if stored_length(written) != length or not same_values(values, written.get("values")):
        return f"failed: {_clean(target_name)} does not match {source_name} after saving"
    return ""


def review_source_project(ui, projects: list[str], active: str, report) -> str | None:
    payload = {
        "title": TITLE,
        "host": "projectInstance",
        "summary": (
            f"Active project: {active}\n"
            "Select the prior quarter's project. Its Current Qtr Indicated and Selected vectors "
            f"(91/92) replace the Prior Qtr vectors (81/82) of every reserving class in {active}."
        ),
        "columns": [{"key": "name", "label": "Project", "width": 420}],
        "rows": [
            {"id": name, "selected": False, "disabled": False, "cells": {"name": name}}
            for name in projects
        ],
        "acceptLabel": "Load Vectors",
        "cancelLabel": "Cancel",
        "searchPlaceholder": "Filter projects",
        "emptyMessage": "There is no other project to copy from.",
    }
    completion = ui.review_table(payload, on_poll=report)
    if not completion.get("accepted"):
        return None
    chosen = completion.get("selectedRowIds") or completion.get("selected_row_ids") or []
    return str(chosen[0]) if len(chosen) == 1 else ""


def _summary(active: str, source_project: str, copied: int, lines: list[str]) -> str:
    head = f"Copied {copied} vector(s) from {source_project} into {active}."
    if not lines:
        return head
    shown = lines[:MAX_REPORTED_LINES]
    more = len(lines) - len(shown)
    return "\n".join(
        [head, "", f"{len(lines)} not copied:", *shown, *([f"... and {more} more"] if more else [])]
    )


def run_macro(active_dfm=None, active_context=None):
    from arcrho_api import ArcRhoUI
    from arcrho_api.gateway import GatewayClient

    ui = ArcRhoUI()

    def report() -> None:
        cancel = globals().get("check_macro_cancelled")
        if callable(cancel):
            cancel()
        activity = globals().get("report_macro_activity")
        if callable(activity):
            activity()

    def say(text, kind="info", auto_close_ms=None):
        ui.message_box(text, title=TITLE, kind=kind, auto_close_ms=auto_close_ms, timeout_sec=120)

    try:
        context = (
            active_context
            if isinstance(active_context, dict) and _clean(active_context.get("projectName"))
            else ui.project_instance.context(timeout_sec=10)
        )
        active = _clean(context.get("projectName"))
        gateway = GatewayClient()
        projects = [
            name for name in gateway.read("project_names").get("projects", []) if _clean(name) != active
        ]
        source_project = review_source_project(ui, sorted(projects, reverse=True), active, report)
    except Exception as exc:
        message = f"Could not start.\n\n{_error_text(exc)}"
        say(message, "error")
        return {"success": False, "message": message}
    if not source_project:
        message = "Cancelled; nothing was changed." if source_project is None else "Select exactly one project."
        say(message, auto_close_ms=3000)
        return {"success": False, "message": message}

    try:
        classes = gateway.read("reserving_classes_with_data", project_name=active)["reserving_classes"]
    except Exception as exc:
        message = f"Could not list the reserving classes of {active}.\n\n{_error_text(exc)}"
        say(message, "error")
        return {"success": False, "message": message}

    progress = ui.progress_bar(
        progress_id="load-prior-quarter-vectors", title=TITLE,
        label=f"Loading vectors from {source_project}", total=len(classes),
    )
    copied = 0
    lines: list[str] = []
    for number, rc in enumerate(classes, start=1):
        report()
        progress.update(label=rc, completed=number - 1)
        try:
            source_index = gateway.read("dataset_index", project_name=source_project, reserving_class=rc)
        except Exception:
            lines.append(f"{rc}: not in {source_project}")
            continue
        try:
            plan = plan_class(
                source_index, gateway.read("dataset_index", project_name=active, reserving_class=rc)
            )
        except Exception as exc:
            lines.append(f"{rc}: could not read the class index ({_error_text(exc)})")
            continue
        lines.extend(f"{rc}: no Prior Qtr vector for {name}" for name in plan["no_target"])
        for source, target in plan["pairs"]:
            problem = copy_vector(gateway, source_project, active, rc, source, target, report)
            if problem:
                lines.append(f"{rc}: {problem}")
            else:
                copied += 1

    progress.update(label="Done", completed=len(classes), tone="warning" if lines else "success")
    try:
        ui.project_instance.reload_dataset_table(timeout_sec=30)
    except Exception:
        pass
    message = _summary(active, source_project, copied, lines)
    say(message, "warning" if lines else "info")
    return {"success": not lines, "message": message, "copied": copied}


if __name__ == "__main__":
    print(run_macro())
