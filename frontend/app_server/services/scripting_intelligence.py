"""Python notebook help and completion from the running session namespace."""
from __future__ import annotations

import ast
import builtins
import inspect
import io
import re
import tokenize
from typing import Any

IDENTIFIER = r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*"
IDENT_RE = re.compile(IDENTIFIER)
MAX_DOC_LEN = 2000


def resolve_object(name: str, namespace: dict) -> Any:
    """Resolve names and attributes without executing a call expression."""
    if not IDENT_RE.fullmatch(name):
        raise NameError(name)
    parts = name.split(".")
    if parts[0] in namespace:
        value = namespace[parts[0]]
    elif hasattr(builtins, parts[0]):
        value = getattr(builtins, parts[0])
    else:
        raise NameError(f"Name {parts[0]!r} is not defined")
    for part in parts[1:]:
        value = getattr(value, part)
    return value


def describe_object(name: str, obj: Any) -> dict:
    result = {"signature": "", "parameters": [], "docstring": inspect.getdoc(obj) or ""}
    if callable(obj):
        try:
            signature = inspect.signature(obj)
            result["signature"] = f"{name}{signature}"
            result["parameters"] = [
                {"name": p.name, "label": str(p), "kind": p.kind.name}
                for p in signature.parameters.values()
            ]
        except (ValueError, TypeError):
            result["signature"] = f"{name}(...)"
    return result


def execute_cell(code: str, namespace: dict) -> Any:
    """Shared execution semantics for streamed and non-streamed cells."""
    help_match = re.fullmatch(rf"\s*(?:\?({IDENTIFIER})|({IDENTIFIER})\?)\s*", code)
    if help_match:
        name = help_match[1] or help_match[2]
        obj = resolve_object(name, namespace)
        info = describe_object(name, obj)
        print(info["signature"] or name)
        print(info["docstring"] or "No docstring available.")
        return None
    tree = ast.parse(code, "<cell>", "exec")
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_node = tree.body.pop()
        if tree.body:
            exec(compile(tree, "<cell>", "exec"), namespace)
        value = eval(compile(ast.Expression(body=last_node.value), "<cell>", "eval"), namespace)
        namespace["_"] = value
        return value
    exec(compile(tree, "<cell>", "exec"), namespace)
    return None


def call_context(source: str) -> dict | None:
    """Find the enclosing call, ignoring commas in strings and nested containers."""
    lines = source.splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    stack = []
    last_name = ""
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            text = token.string
            if token.type == tokenize.ERRORTOKEN and text in ("'", '"'):
                break  # The user is still typing a string argument.
            if token.type == tokenize.OP:
                if text in "([{":
                    offset = starts[token.start[0] - 1] + token.start[1]
                    name = re.search(rf"({IDENTIFIER})\s*$", source[:offset]) if text == "(" else None
                    stack.append({"name": name[1] if name else "", "argument": 0, "keyword": ""})
                elif text in ")]}":
                    if stack:
                        stack.pop()
                elif text == "," and stack:
                    stack[-1]["argument"] += 1
                    stack[-1]["keyword"] = ""
                elif text == "=" and stack:
                    stack[-1]["keyword"] = last_name
            last_name = text if token.type == tokenize.NAME else ""
    except (tokenize.TokenError, IndentationError):
        pass  # An unfinished cell is the normal completion input.
    return next((frame for frame in reversed(stack) if frame["name"]), None)


def complete(code: str, cursor_pos: int, namespace: dict) -> dict:
    source = code[:max(0, min(len(code), cursor_pos))]
    context = call_context(source)
    result = {"signature": None, "active_parameter": 0, "suggestions": []}
    if context:
        try:
            obj = resolve_object(context["name"], namespace)
            if callable(obj):
                info = describe_object(context["name"], obj)
                info["docstring"] = info["docstring"][:MAX_DOC_LEN]
                result["signature"] = info
                parameters = info["parameters"]
                active = next((i for i, p in enumerate(parameters) if p["name"] == context["keyword"]), None)
                if active is None:
                    active = next((i for i, p in enumerate(parameters)
                                   if p["kind"] == "VAR_POSITIONAL" and i <= context["argument"]), context["argument"])
                result["active_parameter"] = min(active, max(0, len(parameters) - 1))
        except (NameError, AttributeError):
            pass

    fragment = re.search(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.?$", source)
    prefix = fragment[0] if fragment else ""
    candidates = []
    if "." in prefix:
        owner, _, prefix = prefix.rpartition(".")
        try:
            candidates = dir(resolve_object(owner, namespace))
        except (NameError, AttributeError):
            pass
    else:
        owner = ""
        candidates = sorted(set(namespace) | set(vars(builtins)))
        if result["signature"]:
            for parameter in result["signature"]["parameters"]:
                if parameter["kind"] in ("POSITIONAL_OR_KEYWORD", "KEYWORD_ONLY") and parameter["name"].startswith(prefix):
                    result["suggestions"].append({
                        "label": parameter["name"] + "=", "insert_text": parameter["name"] + "=",
                        "kind": "parameter", "detail": parameter["label"],
                    })
    for name in candidates:
        if not name.startswith(prefix) or (name.startswith("_") and not prefix.startswith("_")):
            continue
        result["suggestions"].append({
            "label": name, "insert_text": name, "kind": "name",
            "expression": f"{owner}.{name}" if owner else name,
        })
        if len(result["suggestions"]) >= 200:
            break
    return result
