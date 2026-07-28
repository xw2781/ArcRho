from __future__ import annotations

from dataclasses import dataclass

from .lexing import Token, lex_sql, protected_signature, token_signature


_CLAUSE_BOUNDARIES = {
    "EXCEPT",
    "GROUP",
    "HAVING",
    "INTERSECT",
    "JOIN",
    "OPTION",
    "ORDER",
    "OUTPUT",
    "UNION",
    "WHEN",
    "WHERE",
}


@dataclass(frozen=True, slots=True)
class _RequestedEdit:
    replacement: str
    priority: int


class _WhitespaceEdits:
    """Collect non-overlapping edits that can only replace whitespace gaps."""

    def __init__(self, source: str) -> None:
        self.source = source
        self._edits: dict[tuple[int, int], _RequestedEdit] = {}

    def newline_between(
        self,
        left: Token,
        right: Token,
        *,
        indent: int,
        priority: int = 0,
        normalize_existing: bool = True,
    ) -> None:
        if left.kind.endswith("comment") or right.kind.endswith("comment"):
            return
        start, end = left.end, right.start
        gap = self.source[start:end]
        if gap and not gap.isspace():
            return
        newline_count = gap.count("\n") + gap.count("\r")
        if newline_count > 1 or (
            newline_count == 1 and not normalize_existing
        ):
            return
        key = (start, end)
        proposed = _RequestedEdit("\n" + (" " * max(0, indent)), priority)
        current = self._edits.get(key)
        if current is None or proposed.priority > current.priority:
            self._edits[key] = proposed

    def touch_between(
        self,
        left: Token,
        right: Token,
        *,
        priority: int = 0,
    ) -> None:
        if left.kind.endswith("comment") or right.kind.endswith("comment"):
            return
        start, end = left.end, right.start
        gap = self.source[start:end]
        if gap and not gap.isspace():
            return
        key = (start, end)
        proposed = _RequestedEdit("", priority)
        current = self._edits.get(key)
        if current is None or proposed.priority > current.priority:
            self._edits[key] = proposed

    def apply(self) -> str:
        output = self.source
        for (start, end), edit in sorted(self._edits.items(), reverse=True):
            output = output[:start] + edit.replacement + output[end:]
        return output


def layout_tsql_whitespace(source: str) -> str:
    """Apply conservative T-SQL layout which SQLFluff cannot express."""

    tokens = [token for token in lex_sql(source) if token.kind != "whitespace"]
    if len(tokens) < 2:
        return source

    depths = _parenthesis_depths(tokens)
    edits = _WhitespaceEdits(source)
    _layout_statement_boundaries(source, tokens, depths, edits)
    _layout_block_boundaries(source, tokens, edits)
    _layout_function_spacing(tokens, edits)
    _layout_join_predicates(source, tokens, depths, edits)
    _layout_merge(source, tokens, depths, edits)

    result = edits.apply()
    if token_signature(source) != token_signature(result):
        raise AssertionError("T-SQL layout changed a non-whitespace token")
    if protected_signature(source) != protected_signature(result):
        raise AssertionError("T-SQL layout changed a protected token")
    return result


def _layout_function_spacing(tokens: list[Token], edits: _WhitespaceEdits) -> None:
    for index, token in enumerate(tokens[:-1]):
        if _word(token, "OPENQUERY") and tokens[index + 1].text == "(":
            edits.touch_between(token, tokens[index + 1], priority=30)


def _layout_block_boundaries(
    source: str,
    tokens: list[Token],
    edits: _WhitespaceEdits,
) -> None:
    non_block_begin = {
        "ATOMIC",
        "CATCH",
        "DIALOG",
        "DISTRIBUTED",
        "TRAN",
        "TRANSACTION",
        "TRY",
    }
    for index, token in enumerate(tokens[:-1]):
        next_token = tokens[index + 1]
        if _word(token, "BEGIN") and _upper_word(next_token) not in non_block_begin:
            edits.newline_between(
                token,
                next_token,
                indent=_line_indent(source, token.start) + 4,
                priority=15,
                normalize_existing=True,
            )
        if _word(token, "END") and _word(next_token, "ELSE"):
            edits.newline_between(
                token,
                next_token,
                indent=max(0, _line_indent(source, token.start) - 4),
                priority=15,
                normalize_existing=True,
            )


def _layout_statement_boundaries(
    source: str,
    tokens: list[Token],
    depths: list[int],
    edits: _WhitespaceEdits,
) -> None:
    for index, token in enumerate(tokens[:-1]):
        next_token = tokens[index + 1]
        if token.text == ";" and depths[index] == 0:
            indent = _line_indent(source, token.start)
            if _word(next_token, "ELSE") or _follows_single_statement_if(
                tokens,
                depths,
                index,
            ):
                indent = max(0, indent - 4)
            edits.newline_between(
                token,
                next_token,
                indent=indent,
                priority=10,
                normalize_existing=False,
            )

    for index in range(len(tokens) - 3):
        if (
            _word(tokens[index], "END")
            and _word(tokens[index + 1], "TRY")
            and _word(tokens[index + 2], "BEGIN")
            and _word(tokens[index + 3], "CATCH")
        ):
            edits.newline_between(
                tokens[index + 1],
                tokens[index + 2],
                indent=_line_indent(source, tokens[index].start),
                priority=20,
                normalize_existing=True,
            )


def _follows_single_statement_if(
    tokens: list[Token],
    depths: list[int],
    semicolon_index: int,
) -> bool:
    depth = depths[semicolon_index]
    for index in range(semicolon_index - 1, -1, -1):
        token = tokens[index]
        if depths[index] != depth:
            continue
        if token.text == ";" or _word(token, "BEGIN") or _word(token, "END"):
            return False
        if _word(token, "IF"):
            return True
    return False


def _layout_join_predicates(
    source: str,
    tokens: list[Token],
    depths: list[int],
    edits: _WhitespaceEdits,
) -> None:
    pending_join_depth: int | None = None
    active_on_depth: int | None = None
    active_on_indent = 0
    in_merge = False
    merge_depth = 0
    merge_has_branch = False
    case_depth = 0

    for index, token in enumerate(tokens):
        depth = depths[index]
        upper = _upper_word(token)

        if upper == "CASE":
            case_depth += 1
        elif upper == "END" and case_depth:
            case_depth -= 1

        if upper == "MERGE" and case_depth == 0:
            in_merge = True
            merge_depth = depth
            merge_has_branch = False
        elif token.text == ";" and in_merge and depth == merge_depth:
            in_merge = False
            merge_has_branch = False

        if upper == "JOIN":
            pending_join_depth = depth

        if (
            active_on_depth is not None
            and depth == active_on_depth
            and upper in _CLAUSE_BOUNDARIES
        ):
            active_on_depth = None

        if upper == "WHEN" and in_merge and depth == merge_depth and case_depth == 0:
            merge_has_branch = True

        is_join_on = upper == "ON" and pending_join_depth == depth
        is_merge_on = (
            upper == "ON"
            and in_merge
            and not merge_has_branch
            and depth == merge_depth
        )
        if is_join_on or is_merge_on:
            active_on_depth = depth
            active_on_indent = _line_indent(source, token.start)
            pending_join_depth = None
            continue

        if (
            active_on_depth is not None
            and depth == active_on_depth
            and case_depth == 0
            and upper in {"AND", "OR"}
            and index > 0
        ):
            edits.newline_between(
                tokens[index - 1],
                token,
                indent=active_on_indent + 4,
                priority=5,
                normalize_existing=True,
            )


def _layout_merge(
    source: str,
    tokens: list[Token],
    depths: list[int],
    edits: _WhitespaceEdits,
) -> None:
    in_merge = False
    merge_depth = 0
    merge_indent = 0
    case_depth = 0
    in_branch_condition = False
    awaiting_action = False
    action: str | None = None
    action_indent = 0
    set_list = False
    set_indent = 0
    insert_phase: str | None = None
    list_kind: str | None = None
    list_depth: int | None = None
    output_list = False

    def reset_branch() -> None:
        nonlocal in_branch_condition, awaiting_action
        nonlocal action, set_list, insert_phase, list_kind, list_depth, output_list
        in_branch_condition = False
        awaiting_action = False
        action = None
        set_list = False
        insert_phase = None
        list_kind = None
        list_depth = None
        output_list = False

    for index, token in enumerate(tokens):
        depth = depths[index]
        upper = _upper_word(token)
        previous = tokens[index - 1] if index else None
        next_token = tokens[index + 1] if index + 1 < len(tokens) else None

        if upper == "CASE":
            case_depth += 1
        elif upper == "END" and case_depth:
            case_depth -= 1

        if upper == "MERGE" and case_depth == 0:
            in_merge = True
            merge_depth = depth
            merge_indent = _line_indent(source, token.start)
            reset_branch()
            continue

        if not in_merge:
            continue
        if token.text == ";" and depth == merge_depth:
            in_merge = False
            reset_branch()
            continue

        if upper == "WHEN" and depth == merge_depth and case_depth == 0:
            if previous is not None:
                edits.newline_between(
                    previous,
                    token,
                    indent=merge_indent,
                    priority=8,
                )
            reset_branch()
            in_branch_condition = True
            continue

        if (
            in_branch_condition
            and depth == merge_depth
            and case_depth == 0
            and upper in {"AND", "OR"}
            and previous is not None
        ):
            edits.newline_between(
                previous,
                token,
                indent=merge_indent + 4,
                priority=8,
            )
            continue

        if (
            in_branch_condition
            and upper == "THEN"
            and depth == merge_depth
            and case_depth == 0
        ):
            if previous is not None:
                edits.newline_between(
                    previous,
                    token,
                    indent=merge_indent,
                    priority=8,
                )
            in_branch_condition = False
            awaiting_action = True
            continue

        if (
            awaiting_action
            and upper in {"DELETE", "INSERT", "UPDATE"}
            and depth == merge_depth
        ):
            if previous is not None:
                edits.newline_between(
                    previous,
                    token,
                    indent=merge_indent + 4,
                    priority=8,
                )
            awaiting_action = False
            action = upper
            action_indent = merge_indent + 4
            insert_phase = "columns" if upper == "INSERT" else None
            continue

        if action == "UPDATE" and upper == "SET" and depth == merge_depth:
            set_list = True
            set_indent = action_indent + 4
            if next_token is not None:
                edits.newline_between(
                    token,
                    next_token,
                    indent=set_indent,
                    priority=8,
                )
            continue

        if set_list and token.text == "," and depth == merge_depth and next_token:
            edits.newline_between(
                token,
                next_token,
                indent=set_indent,
                priority=8,
            )
            continue

        if action == "INSERT" and upper == "VALUES" and depth == merge_depth:
            insert_phase = "values"
            if previous is not None:
                edits.newline_between(
                    previous,
                    token,
                    indent=action_indent,
                    priority=8,
                )
            continue

        if (
            action == "INSERT"
            and token.text == "("
            and depth == merge_depth
            and insert_phase in {"columns", "values"}
            and next_token is not None
        ):
            list_kind = insert_phase
            list_depth = merge_depth + 1
            insert_phase = None
            edits.newline_between(
                token,
                next_token,
                indent=action_indent + 4,
                priority=8,
            )
            continue

        if list_kind and list_depth is not None:
            if token.text == "," and depth == list_depth and next_token is not None:
                edits.newline_between(
                    token,
                    next_token,
                    indent=action_indent + 4,
                    priority=8,
                )
                continue
            if token.text == ")" and depth == list_depth:
                if previous is not None:
                    edits.newline_between(
                        previous,
                        token,
                        indent=action_indent,
                        priority=8,
                    )
                list_kind = None
                list_depth = None
                continue

        if upper == "OUTPUT" and depth == merge_depth and case_depth == 0:
            reset_branch()
            output_list = True
            if previous is not None:
                edits.newline_between(
                    previous,
                    token,
                    indent=merge_indent,
                    priority=8,
                )
            if next_token is not None:
                edits.newline_between(
                    token,
                    next_token,
                    indent=merge_indent + 4,
                    priority=8,
                )
            continue

        if output_list and token.text == "," and depth == merge_depth and next_token:
            edits.newline_between(
                token,
                next_token,
                indent=merge_indent + 4,
                priority=8,
            )


def _parenthesis_depths(tokens: list[Token]) -> list[int]:
    depth = 0
    result: list[int] = []
    for token in tokens:
        result.append(depth)
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth = max(0, depth - 1)
    return result


def _line_indent(source: str, position: int) -> int:
    line_start = source.rfind("\n", 0, position) + 1
    prefix = source[line_start:position]
    whitespace = prefix[: len(prefix) - len(prefix.lstrip(" \t"))]
    return len(whitespace.expandtabs(4))


def _upper_word(token: Token) -> str | None:
    return token.text.upper() if token.kind == "word" else None


def _word(token: Token, expected: str) -> bool:
    return token.kind == "word" and token.text.casefold() == expected.casefold()
