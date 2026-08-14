"""Windows login and workspace-global display-name resolution."""
from __future__ import annotations

import contextvars
import getpass
import json
import os
import threading
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional

from app_server import config


# The username index is workspace-global configuration that changes far less
# often than datasets are saved, and every dataset write now resolves a display
# name through it. Cache the parsed mapping for the life of the app-server
# process, keyed by index path so a relocated workspace never serves a stale
# map. Tests call clear_display_name_cache() between fixtures.
_CACHE_LOCK = threading.Lock()
_DISPLAY_NAME_CACHE: Dict[str, Dict[str, str]] = {}
_CURRENT_DISPLAY_NAME_CACHE: Dict[str, str] = {}

# A save or a dependent walk submitted from a Client PC runs on whichever
# ArcRho Engine instance claims the request, and those instances run under
# their own service profiles. The process account is therefore the wrong
# answer to "who is editing this": the request carries the submitting user, and
# the Engine executor binds it here for the duration of the job so every writer
# below keeps asking for "the current user" without knowing where it runs.
_ACTING_IDENTITY: contextvars.ContextVar[Optional[Dict[str, str]]] = contextvars.ContextVar(
    "arcrho_acting_identity", default=None
)


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _username_key(value: Any) -> str:
    return _clean_text(value).casefold()


def get_windows_login_name() -> str:
    """Login of the user this call acts for, not necessarily this process."""

    acting = _ACTING_IDENTITY.get()
    if acting is not None:
        return acting["login_name"]
    env_login = _clean_text(os.environ.get("USERNAME"))
    if env_login:
        return env_login
    try:
        return _clean_text(getpass.getuser())
    except Exception:
        return ""


def load_username_display_names() -> Dict[str, str]:
    try:
        with open(config.get_username_index_path(), "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return {}

    entries: list[Any]
    if isinstance(raw, dict):
        entries = raw.get("users") if isinstance(raw.get("users"), list) else []
        if not entries:
            return {
                login: full_name
                for key, value in raw.items()
                if key != "users"
                and (login := _username_key(key))
                and (full_name := _clean_text(value))
            }
    elif isinstance(raw, list):
        entries = raw
    else:
        entries = []

    display_names: Dict[str, str] = {}
    for item in entries:
        if isinstance(item, dict):
            login = _username_key(
                item.get("login_name")
                or item.get("Login Name")
                or item.get("username")
                or item.get("user")
            )
            full_name = _clean_text(
                item.get("full_name")
                or item.get("Full Name")
                or item.get("display_name")
                or item.get("name")
            )
        elif isinstance(item, list) and len(item) >= 2:
            login = _username_key(item[0])
            full_name = _clean_text(item[1])
        else:
            continue
        if login and full_name:
            display_names[login] = full_name
    return display_names


def clear_display_name_cache() -> None:
    """Drop the cached mapping so the next resolution re-reads the index."""
    with _CACHE_LOCK:
        _DISPLAY_NAME_CACHE.clear()
        _CURRENT_DISPLAY_NAME_CACHE.clear()


def _cached_username_display_names() -> Dict[str, str]:
    index_path = _clean_text(config.get_username_index_path())
    with _CACHE_LOCK:
        cached = _DISPLAY_NAME_CACHE.get(index_path)
        if cached is not None:
            return cached
    display_names = load_username_display_names()
    with _CACHE_LOCK:
        _DISPLAY_NAME_CACHE[index_path] = display_names
    return display_names


def resolve_display_name(login_name: Any) -> str:
    login = _clean_text(login_name)
    if not login:
        return ""
    return _cached_username_display_names().get(_username_key(login), login)


def get_current_display_name() -> str:
    """Display name of the user this call acts for, cached per session.

    Falls back to the unmapped Windows login, and to an empty string when even
    the login is unavailable, so callers keep their own last-resort labels.
    An acting identity answers directly: it already carries the resolved name
    and must not be re-resolved through this process's cache.
    """
    acting = _ACTING_IDENTITY.get()
    if acting is not None:
        return acting["display_name"]
    login_name = get_windows_login_name()
    if not login_name:
        return ""
    index_path = _clean_text(config.get_username_index_path())
    cache_key = f"{index_path}\n{_username_key(login_name)}"
    with _CACHE_LOCK:
        cached = _CURRENT_DISPLAY_NAME_CACHE.get(cache_key)
        if cached is not None:
            return cached
    display_name = resolve_display_name(login_name)
    with _CACHE_LOCK:
        _CURRENT_DISPLAY_NAME_CACHE[cache_key] = display_name
    return display_name


def get_current_identity() -> Dict[str, str]:
    return {
        "login_name": get_windows_login_name(),
        "display_name": get_current_display_name(),
    }


@contextmanager
def acting_identity(login_name: Any, display_name: Any = "") -> Iterator[Dict[str, str]]:
    """Act as the user a server-side job was submitted for.

    ``display_name`` is the name the submitting app server already resolved
    against the username index, and it wins when supplied: that process is
    started per app launch, while an Engine instance can run for days on a
    mapping it cached at startup. Without it the login resolves here against
    the same workspace-global index, so a producer that only sends a login
    still stamps a full name.

    An empty login leaves the process identity in place, which keeps a request
    written before this field existed behaving exactly as it did before.
    """

    login = _clean_text(login_name)
    if not login:
        yield get_current_identity()
        return
    identity = {
        "login_name": login,
        "display_name": _clean_text(display_name) or resolve_display_name(login),
    }
    token = _ACTING_IDENTITY.set(identity)
    try:
        yield identity
    finally:
        _ACTING_IDENTITY.reset(token)
