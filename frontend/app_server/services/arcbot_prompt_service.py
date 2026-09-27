"""ArcBot's shared prompt files, read where the server keeps them.

The team edits ArcBot's entry prompt and its instruction files under
``<server root>\\config\\arcbot`` on the server. A Client PC reads them through
the Gateway (``arcbot_prompt_files``) and never opens or seeds that folder over
the share: a missing entry prompt means ArcBot uses the default bundled with
the app, and a missing instruction file simply contributes nothing. Nothing in
the app creates these files; an administrator adds or edits them on the
server.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

from app_server import config


PROMPT_RELATIVE_PATH = os.path.join("config", "arcbot", "arcbot_prompt.md")
INSTRUCTIONS_RELATIVE_DIR = os.path.join("config", "arcbot", "instructions")
# ArcBot keeps at most 30,000 characters of one instruction file and 80,000 in
# all; these bounds only stop an oversized file from travelling whole.
MAX_PROMPT_CHARS = 200_000
MAX_INSTRUCTION_FILE_CHARS = 60_000
MAX_INSTRUCTION_FILES = 50


def _read_text(path: str, limit: int) -> str | None:
    try:
        with open(path, "r", encoding="utf-8-sig") as stream:
            return stream.read(limit)
    except FileNotFoundError:
        return None


def read_arcbot_prompt_files() -> Dict[str, Any]:
    """The entry prompt (``None`` when the server has none) and every instruction file."""

    root = config.get_root_path()
    prompt_path = os.path.join(root, PROMPT_RELATIVE_PATH)
    instructions_dir = os.path.join(root, INSTRUCTIONS_RELATIVE_DIR)
    instructions: List[Dict[str, str]] = []
    try:
        names = sorted(
            entry.name
            for entry in os.scandir(instructions_dir)
            if entry.is_file()
            and entry.name.lower().endswith(".md")
            and not entry.name.startswith((".", "_"))
        )
    except FileNotFoundError:
        names = []
    for name in names[:MAX_INSTRUCTION_FILES]:
        text = _read_text(os.path.join(instructions_dir, name), MAX_INSTRUCTION_FILE_CHARS)
        if text is not None:
            instructions.append({"name": name, "text": text})
    return {
        "prompt": _read_text(prompt_path, MAX_PROMPT_CHARS),
        "prompt_path": prompt_path,
        "instructions_dir": instructions_dir,
        "instructions": instructions,
    }

