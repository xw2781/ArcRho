"""Resolve formula dataset calls through the same dataset reader as Excel.

Called only on the server by the hosted reference route or dependent refresh.
Request-local caching groups identical project/segment/dataset/shape reads.
"""
from __future__ import annotations

import csv
import io
import math

from fastapi import HTTPException
from arcrho_api.arcrho_formula_reference import parse_arcrho_call


def resolve_arcrho_reference(reference, project_name, reserving_class, cache=None):
    from app_server.services.arcrho_runtime_service import run_arcrho_dataset_csv

    try:
        parsed = parse_arcrho_call(reference)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    args, name = parsed["arguments"], parsed["name"]
    project = str(args.get("ProjectName") or "").strip()
    if not project or project.casefold() == "default": project = project_name
    rc = str(args.get("Path") or reserving_class).strip()
    vector = name.startswith("ARCOVEC")

    def boolean(key, default=False):
        value = args.get(key, default)
        if isinstance(value, str):
            if value.upper() not in ("TRUE", "FALSE"):
                raise HTTPException(422, f"{key} must be TRUE or FALSE.")
            return value.upper() == "TRUE"
        return bool(value)

    def positive(key, default):
        value = args.get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 or value != int(value):
            raise HTTPException(422, f"{key} must be a positive integer.")
        return int(value)

    period = positive("PeriodLength", 12) if vector else positive("OriginLength", 12)
    development = period if vector else positive("DevelopmentLength", 12)
    pairs = [
        ("Function", "ArcRhoVec" if vector else "ArcRhoTri"),
        ("Path", rc), ("DatasetName", parsed["dataset_name"]),
        ("ProjectName", project), ("OriginLength", str(period)),
        ("DevelopmentLength", str(development)),
        ("Cumulative", str(boolean("Cumulative", True))),
        ("Transposed", "False"), ("Calendar", str(boolean("Calendar"))),
    ]
    key = tuple(pairs)
    cache = {} if cache is None else cache
    if key not in cache:
        response = run_arcrho_dataset_csv(pairs, timeout_sec=30)
        if not response.get("ok"):
            raise HTTPException(422, str(response.get("error") or response.get("message") or "Dataset could not be read."))
        values = []
        for row in csv.reader(io.StringIO(response.get("csv_text", ""))):
            if not row: continue
            line = []
            for cell in row:
                try: number = float(cell) if cell.strip() else None
                except ValueError: raise HTTPException(422, "Dataset contains a non-numeric value.")
                if number is not None and not math.isfinite(number): raise HTTPException(422, "Dataset contains a non-finite value.")
                line.append(number)
            values.append(line)
        if not values: raise HTTPException(422, "Dataset has no values.")
        width = max(map(len, values))
        cache[key] = [row + [None] * (width - len(row)) for row in values]
    values = cache[key]
    rows, cols = len(values), len(values[0])
    if name == "ARCOTRICELL":
        r, c = positive("OriginPeriod", 1) - 1, positive("DevelopmentPeriod", 1) - 1
        if r >= rows or c >= cols: raise HTTPException(422, "Triangle cell is outside the dataset.")
        values = [[values[r][c]]]
    elif name == "ARCOVECCELL":
        index = positive("Index", 1) - 1
        flat = [cell for row in values for cell in row]
        if index >= len(flat): raise HTTPException(422, "Vector index is outside the dataset.")
        values = [[flat[index]]]
    elif name == "ARCOTRIORIGIN":
        index = positive("OriginPeriod", 1) - 1
        if index >= rows: raise HTTPException(422, "Origin period is outside the dataset.")
        values = [values[index]]
    elif name == "ARCOTRIDIAG":
        diagonal = args["DiagonalIndex"]
        if not isinstance(diagonal, (int, float)) or not math.isfinite(diagonal) or diagonal != int(diagonal):
            raise HTTPException(422, "DiagonalIndex must be an integer.")
        index = max(0, -int(diagonal))
        lines = [[cell for cell in reversed(row) if cell is not None] for row in values]
        values = [[line[index] if index < len(line) else 0] for line in lines]
    if boolean("Transposed"):
        values = [list(row) for row in zip(*values)]
    return {
        "reference": reference, "dataset_name": parsed["dataset_name"],
        "project_name": project, "reserving_class": rc,
        "data_format": "Vector" if vector else "Triangle",
        "row_start": 0, "column_start": 0,
        "row_count": len(values), "column_count": len(values[0]),
        "cells": [{"row": r, "column": c, "value": value} for r, row in enumerate(values) for c, value in enumerate(row)],
    }
