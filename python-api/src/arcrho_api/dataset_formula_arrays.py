"""Array selection operations shared by Dataset Viewer and DFM formulas."""
from __future__ import annotations

import math

from .dataset_link_contract import DatasetLinkError, _numeric


def evaluate_array_function(name, matrices, omitted):
    source = matrices[0]
    values, rows, cols = source["values"], source["rows"], source["cols"]
    if name == "TRANSPOSE":
        result = [[values[r][c] for r in range(rows)] for c in range(cols)]
    else:
        def index(i, default):
            if i >= len(matrices) or omitted[i]: return default
            matrix = matrices[i]
            if matrix["rows"] != 1 or matrix["cols"] != 1:
                raise DatasetLinkError(f"{name} indices must be scalar numbers.")
            return math.trunc(_numeric(matrix["values"][0][0]))

        if name == "TAKE":
            row_count, col_count = index(1, rows), index(2, cols)
            if row_count == 0 or col_count == 0:
                raise DatasetLinkError("TAKE cannot return an empty array (zero rows or columns).")
            row_start = max(0, rows + row_count) if row_count < 0 else 0
            col_start = max(0, cols + col_count) if col_count < 0 else 0
            result = [row[col_start:col_start + abs(col_count)] for row in values[row_start:row_start + abs(row_count)]]
        else:
            row, col = index(1, 0), index(2, 0 if cols > 1 and rows > 1 else 1)
            if len(matrices) == 2 and rows == 1:
                col, row = row, 1
            if row < 0 or col < 0 or row > rows or col > cols:
                raise DatasetLinkError("INDEX is outside the array.")
            selected = values if row == 0 else [values[row - 1]]
            result = [list(line) if col == 0 else [line[col - 1]] for line in selected]
    return {"rows": len(result), "cols": len(result[0]), "values": result}
