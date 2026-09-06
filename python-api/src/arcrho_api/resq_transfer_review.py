"""The review table the Import and Export ResQ macros both open.

Both macros move a whole reserving class between ArcRho and ResQ, and both
need the same thing before they write: every dataset and method output either
system holds, the two timestamps beside each other, what the run would do to
it, and a tick box to leave it out. One window, one set of columns, one set of
rules for what may be ticked -- so the two macros cannot drift into describing
the same comparison two different ways.

The rows and every verdict on them come from the Bridge's ``transfer_preview``
phase, which reads both sides through the canonical session. Nothing is judged
again here; this module only projects those rows into the review-table
contract and reads the ticked names back out of the completion.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping


DIRECTION_IMPORT = "import"
DIRECTION_EXPORT = "export"

KIND_DATASET = "Dataset"

_PRESENCE_CELLS = {
    "both": ("Both", ""),
    "arcrho": ("ArcRho only", "muted"),
    "resq": ("ResQ only", "info"),
}

_NEWER_CELLS = {
    "arcrho": ("ArcRho", ""),
    "resq": ("ResQ", ""),
}

# What the saved baseline says was edited since the last run. "None" is the
# quiet, expected answer once a class has been transferred and left alone.
_CHANGED_CELLS = {
    "both": ("Both", "warn"),
    "resq": ("ResQ", "warn"),
    "arcrho": ("ArcRho", "warn"),
    "none": ("None", "muted"),
}


def _review_of(row: Mapping[str, Any]) -> Mapping[str, Any]:
    review = row.get("export_review")
    return review if isinstance(review, Mapping) else {}


def _edited_side(row: Mapping[str, Any], side: str) -> bool:
    """Whether one side carries an edit the run would destroy.

    The baseline verdict answers it where a pair was recorded; without one the
    plain timestamp comparison stands in, which is the same fallback the
    export's own review has always used.
    """

    changed = str(_review_of(row).get("changed") or "")
    if changed:
        return changed in (side, "both")
    return str(row.get("newer_side") or "") == side


def edits_at_risk(
    preview: list[Mapping[str, Any]],
    direction: str,
    names: list[str] | None = None,
) -> list[Mapping[str, Any]]:
    """The tickable rows whose copy on the target side the run would overwrite.

    ``names`` narrows the answer to the ticked names; ``None`` means every row
    the table offers. This is what the Import macro lists for a second look
    before it overwrites, and what the table header counts.
    """

    side = "resq" if direction == DIRECTION_EXPORT else "arcrho"
    wanted = None if names is None else {str(name).strip() for name in names}
    return [
        row
        for row in preview
        if row.get("transfer_supported")
        and (wanted is None or str(row.get("name") or "").strip() in wanted)
        and _edited_side(row, side)
    ]


# The kinds the Project Instance page opens as a method window rather than as
# the method's output dataset.
_METHOD_WINDOW_KINDS = {"DFM", "Result Selection"}


def open_item_args(row: Mapping[str, Any]) -> dict[str, Any]:
    """The ``projectInstance.openDataset`` arguments that open one row in ArcRho."""

    name = str(row.get("name") or "")
    kind = str(row.get("kind") or KIND_DATASET)
    if kind in _METHOD_WINDOW_KINDS:
        return {
            "datasetName": name,
            "openMethod": True,
            "methodType": kind,
            "methodName": str(row.get("method_name") or name),
        }
    args = {"datasetName": name, "datasetTypeName": str(row.get("dataset_type") or name)}
    if kind != KIND_DATASET:
        args["methodType"] = kind
    return args


def _export_plan_cell(row: Mapping[str, Any]) -> tuple[str, str]:
    if not row.get("transfer_supported"):
        return "Not exported", "muted"
    if _edited_side(row, "resq"):
        return "Overwrites newer ResQ copy", "warn"
    return "Overwrites ResQ copy", "info"


def _import_plan_cell(row: Mapping[str, Any], overwrite: bool) -> tuple[str, str]:
    if not row.get("transfer_supported"):
        return "Not imported", "muted"
    if str(row.get("presence") or "") == "resq":
        return "Added to ArcRho", "info"
    if _edited_side(row, "arcrho"):
        if overwrite:
            return "Overwrites newer ArcRho copy", "warn"
        return "Keeps the newer ArcRho copy", "ok"
    return "Overwrites ArcRho copy", "info"


def _plan_cell(row: Mapping[str, Any], direction: str, overwrite: bool) -> dict[str, str]:
    text, tone = (
        _export_plan_cell(row)
        if direction == DIRECTION_EXPORT
        else _import_plan_cell(row, overwrite)
    )
    return {"text": text, "tone": tone}


def transfer_review_cells(
    row: Mapping[str, Any],
    direction: str,
    overwrite: bool = False,
) -> dict[str, Any]:
    """One row's cells: where it lives, its timestamp pair, and what the run does to it."""

    arcrho_timestamp = str(row.get("arcrho_timestamp") or "")
    resq_timestamp = str(row.get("resq_timestamp") or "")
    newer = str(row.get("newer_side") or "")
    paired = bool(arcrho_timestamp and resq_timestamp)
    newer_text, newer_tone = _NEWER_CELLS.get(
        newer, ("Same", "muted") if paired else ("-", "muted")
    )
    changed = str(_review_of(row).get("changed") or "")
    changed_text, changed_tone = _CHANGED_CELLS.get(
        changed, ("No baseline yet", "muted") if paired else ("-", "muted")
    )
    return {
        "kind": str(row.get("kind") or KIND_DATASET),
        "name": str(row.get("name") or ""),
        "presence": dict(zip(("text", "tone"), _PRESENCE_CELLS.get(
            str(row.get("presence") or ""), ("Unknown", "muted")
        ))),
        "arcrho_timestamp": arcrho_timestamp or "-",
        "resq_timestamp": resq_timestamp or "-",
        "newer": {"text": newer_text, "tone": newer_tone},
        "changed": {"text": changed_text, "tone": changed_tone},
        "plan": _plan_cell(row, direction, overwrite),
        "detail": str(_review_of(row).get("detail") or row.get("detail") or ""),
    }


def _summary(
    preview: list[Mapping[str, Any]],
    direction: str,
    project_name: str,
    rc_path: str,
    connection_name: str,
    class_direction: Mapping[str, Any],
    selection: Mapping[str, Any],
) -> str:
    actionable = [row for row in preview if row.get("transfer_supported")]
    selected = [row for row in actionable if row.get("selected")]
    at_risk = len(edits_at_risk(selected, direction))
    target, article = ("ResQ", "a") if direction == DIRECTION_EXPORT else ("ArcRho", "an")
    saved_by = str(selection.get("updated_by") or "").strip()
    saved_at = str(selection.get("updated_at") or "").strip()
    if selection.get("names"):
        remembered = "Ticked from the last selection saved for this reserving class"
        remembered += f" by {saved_by}" if saved_by else ""
        remembered += f" on {saved_at}." if saved_at else "."
    else:
        remembered = "No selection has been saved for this reserving class yet, so everything is ticked."
    return (
        f"Project: {project_name} | Reserving class: {rc_path} | ResQ: {connection_name}\n"
        f"Latest ArcRho change: {class_direction.get('arcrho_timestamp') or 'Unknown'} | "
        f"Latest ResQ change: {class_direction.get('resq_timestamp') or 'Unknown'}\n"
        f"Compared {len(preview)} item(s); {len(actionable)} can be written to {target} and "
        f"{len(selected)} are selected, of which {at_risk} carry {article} {target} change this "
        f"run would overwrite.\n{remembered}"
    )


def transfer_review_payload(
    preview: list[Mapping[str, Any]],
    *,
    direction: str,
    title: str,
    accept_label: str,
    project_name: str,
    rc_path: str,
    connection_name: str,
    class_direction: Mapping[str, Any],
    selection: Mapping[str, Any],
    overwrite: bool = False,
) -> dict[str, Any]:
    """Project the Bridge's transfer rows into the shared, tickable review table.

    The table is hosted inside the active Project Instance page as a nested
    window, so an item can be opened and checked in ArcRho while the review
    stays open.
    """

    rows = [
        {
            "id": str(row.get("id") or ""),
            "selected": bool(row.get("selected")),
            "disabled": not bool(row.get("transfer_supported")),
            "cells": transfer_review_cells(row, direction, overwrite),
        }
        for row in preview
    ]
    return {
        "title": title,
        "host": "projectInstance",
        "summary": _summary(
            preview, direction, project_name, rc_path, connection_name, class_direction, selection
        ),
        "columns": [
            {"key": "kind", "label": "Type", "width": 150},
            {"key": "name", "label": "Dataset / Method Output", "width": 250},
            {"key": "presence", "label": "Held By", "width": 110},
            {"key": "arcrho_timestamp", "label": "ArcRho Timestamp", "width": 200},
            {"key": "resq_timestamp", "label": "ResQ Timestamp", "width": 200},
            {"key": "newer", "label": "Newer", "width": 90},
            {"key": "changed", "label": "Changed Since Last Run", "width": 170},
            {"key": "plan", "label": "This Run", "width": 210},
            {"key": "detail", "label": "Details", "width": 320},
        ],
        "rows": rows,
        "acceptLabel": accept_label,
        "cancelLabel": "Cancel",
        "searchPlaceholder": "Filter datasets and methods",
        "emptyMessage": (
            "Neither ArcRho nor ResQ holds a dataset or method for this reserving class, "
            "so there is nothing to transfer."
        ),
    }


def accepted_names(preview: list[Mapping[str, Any]], completion: Mapping[str, Any]) -> list[str]:
    """The names of the ticked rows, in the table's own order.

    Names are what the request and the saved selection are written with, so a
    row id that no longer matches a preview row is simply dropped rather than
    being sent on as an identifier the session cannot resolve.
    """

    selected = completion.get("selectedRowIds") or completion.get("selected_row_ids") or []
    wanted = {str(value).strip() for value in selected if str(value).strip()}
    return [
        str(row.get("name") or "")
        for row in preview
        if str(row.get("id") or "") in wanted and str(row.get("name") or "").strip()
    ]


def review_transfer(
    ui,
    preview: list[Mapping[str, Any]],
    *,
    direction: str,
    title: str,
    accept_label: str,
    project_name: str,
    rc_path: str,
    connection_name: str,
    class_direction: Mapping[str, Any],
    selection: Mapping[str, Any],
    overwrite: bool = False,
    on_poll: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Open the shared review table and return ``{accepted, names}``."""

    from .ui import await_review_table

    completion = await_review_table(
        ui,
        transfer_review_payload(
            preview,
            direction=direction,
            title=title,
            accept_label=accept_label,
            project_name=project_name,
            rc_path=rc_path,
            connection_name=connection_name,
            class_direction=class_direction,
            selection=selection,
            overwrite=overwrite,
        ),
        on_poll=on_poll,
    )
    return {
        "accepted": bool(completion.get("accepted")),
        "names": accepted_names(preview, completion),
    }
