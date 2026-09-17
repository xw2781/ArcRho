"""Excel add-in dataset-call syntax used by both ArcRho formula editors.

Signatures/defaults are generated from ArcRhoFunctions.bas. Empty project/path
arguments are contextual in ArcRho. Data reads belong to the hosted resolver.
"""
from __future__ import annotations

import re

from .arcrho_formula_catalog import ARCRHO_FORMULA_FUNCTIONS


def scan_arcrho_call(text, start=0):
    match = re.match(r"([A-Za-z_][A-Za-z_0-9]*)\s*\(", text[start:])
    if not match or match[1].upper() not in ARCRHO_FORMULA_FUNCTIONS:
        return None
    cursor, quote = start + match.end(), False
    parts, current = [], ""
    while cursor < len(text):
        char = text[cursor]
        if char == '"':
            current += char
            if quote and cursor + 1 < len(text) and text[cursor + 1] == '"':
                current += '"'
                cursor += 2
                continue
            quote = not quote
        elif not quote and char in ",)":
            parts.append(current.strip())
            current = ""
            if char == ")":
                return {"name": match[1].upper(), "parts": parts, "start": start, "end": cursor + 1}
        else:
            current += char
        cursor += 1
    raise ValueError("ArcRho dataset function is missing its closing quote or parenthesis.")


def parse_arcrho_call(text):
    source = str(text).strip().lstrip("=").lstrip()
    call = scan_arcrho_call(source)
    if not call or call["end"] != len(source):
        raise ValueError("Expected an ArcRho dataset function.")
    spec = ARCRHO_FORMULA_FUNCTIONS[call["name"]]
    if not spec["minimum"] <= len(call["parts"]) <= len(spec["arguments"]):
        raise ValueError(f"Wrong number of arguments for {spec['name']}.")
    values = {}
    for i, arg in enumerate(spec["arguments"]):
        raw = call["parts"][i] if i < len(call["parts"]) else ""
        if not raw:
            if not arg["optional"] and arg["name"] != "Path":
                raise ValueError(f"{arg['name']} is required.")
            value = arg["default"]
        elif re.fullmatch(r'"(?:[^"]|"")*"', raw):
            value = raw[1:-1].replace('""', '"')
        elif raw.upper() in ("TRUE", "FALSE"):
            value = raw.upper() == "TRUE"
        elif re.fullmatch(r"[+-]?(?:\d+\.?\d*|\.\d+)", raw):
            value = float(raw)
        else:
            raise ValueError(f"{arg['name']} needs quoted text, a number, TRUE or FALSE.")
        values[arg["name"]] = value
    dataset_name = " ".join(str(values.get("TriangleName", values.get("VectorName", ""))).split())
    if not dataset_name: raise ValueError("Dataset name is required.")
    return {**call, "arguments": values, "dataset_name": dataset_name, "canonical": f"{spec['name']}({', '.join(call['parts'])})"}


def arcrho_formula_references(text):
    """Find calls outside strings/Excel references, retaining source spans."""
    source, cursor, quote = str(text or ""), 0, ""
    result = []
    while cursor < len(source):
        char = source[cursor]
        if quote:
            if char == quote:
                if cursor + 1 < len(source) and source[cursor + 1] == quote:
                    cursor += 2
                    continue
                quote = ""
        elif char in ('"', "'"):
            quote = char
        elif char == "[":
            end = source.find("]", cursor)
            if end < 0: break
            cursor = end
        elif char.isalpha() and (cursor == 0 or not re.match(r"[\w]", source[cursor - 1])):
            call = scan_arcrho_call(source, cursor)
            if call:
                parsed = parse_arcrho_call(source[cursor:call["end"]])
                result.append({**parsed, "start": cursor, "end": call["end"], "match": source[cursor:call["end"]]})
                cursor = call["end"]
                continue
        cursor += 1
    return result


def reference_is_local(reference, project_name="", reserving_class=""):
    args = reference["arguments"]
    project, rc = str(args.get("ProjectName") or ""), str(args.get("Path") or "")
    return (not project or project.casefold() == "default" or project.casefold() == str(project_name).casefold()) and (
        not rc or rc.replace("/", "\\").strip("\\").casefold() == str(reserving_class).replace("/", "\\").strip("\\").casefold()
    )
