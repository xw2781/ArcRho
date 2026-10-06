"""ArcBot's shared skills, read where the server keeps them.

Each skill is a folder under ``<server root>\\shared\\agent-skills`` holding a
``SKILL.md`` (a small front-matter block, then the instructions) and an optional
``references`` folder of Markdown and JSON files the instructions and macros
point to. A Client PC reads
them through the Gateway (``agent_skills``) and never opens the folder over the
share. Nothing in the app creates a skill; an administrator adds or edits it on
the server.

Front matter keys: ``title``, ``description``, ``scope`` (the page type the
skill needs open, such as ``dfm``; empty means any), ``macros`` (comma-separated
library macros the skill may run) and ``version``.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

from app_server import config


SKILLS_RELATIVE_DIR = os.path.join("shared", "agent-skills")
SKILL_FILE = "SKILL.md"
REFERENCES_DIR = "references"
REFERENCE_SUFFIXES = (".md", ".json")
MAX_SKILL_FILE_CHARS = 60_000
MAX_REFERENCE_FILES = 20


def _read_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8-sig") as stream:
            return stream.read(MAX_SKILL_FILE_CHARS)
    except FileNotFoundError:
        return None


def _parse_skill(skill_id: str, text: str) -> Dict[str, Any]:
    meta: Dict[str, str] = {}
    body = text.replace("\r\n", "\n")
    if body.startswith("---\n"):
        header, _, rest = body[4:].partition("\n---")
        for line in header.splitlines():
            key, separator, value = line.partition(":")
            if separator:
                meta[key.strip().lower()] = value.strip()
        body = rest.lstrip("\n")
    macros = [name.strip() for name in meta.get("macros", "").split(",") if name.strip()]
    return {
        "id": skill_id,
        "title": meta.get("title") or skill_id,
        "description": meta.get("description", ""),
        "scope": meta.get("scope", "").lower(),
        "macros": macros,
        "version": meta.get("version", ""),
        "instructions": body.strip(),
    }


def _skill_folders(skills_dir: str) -> List[str]:
    try:
        return sorted(
            entry.name
            for entry in os.scandir(skills_dir)
            if entry.is_dir() and not entry.name.startswith((".", "_"))
        )
    except FileNotFoundError:
        return []


def read_agent_skills(skill_id: str = "") -> Dict[str, Any]:
    """Every skill's menu entry, plus the instructions and references of ``skill_id`` when given."""

    skills_dir = os.path.join(config.get_root_path(), SKILLS_RELATIVE_DIR)
    skills: List[Dict[str, Any]] = []
    for name in _skill_folders(skills_dir):
        text = _read_text(os.path.join(skills_dir, name, SKILL_FILE))
        if text is None:
            continue
        skill = _parse_skill(name, text)
        if name != skill_id:
            del skill["instructions"]
            skills.append(skill)
            continue
        references_dir = os.path.join(skills_dir, name, REFERENCES_DIR)
        try:
            reference_names = sorted(
                entry.name
                for entry in os.scandir(references_dir)
                if entry.is_file() and entry.name.lower().endswith(REFERENCE_SUFFIXES)
            )
        except FileNotFoundError:
            reference_names = []
        skill["references"] = [
            {"name": reference, "text": _read_text(os.path.join(references_dir, reference)) or ""}
            for reference in reference_names[:MAX_REFERENCE_FILES]
        ]
        skills.append(skill)
    return {"skills": skills}
