"""Replay a recording of ResQ COM reads, so import code runs on ResQ's real answers.

``tools/resq_dfm_recording.py`` records every read the ResQ import makes of one
live COM object (a property's value, a parameterised getter's answer for its
exact arguments, a nested object, or the error ResQ raised). ``ReplayObject``
answers the same reads from that recording. A read the recording does not hold
raises, and is also listed in ``misses``, because import code swallows most
COM errors; a test asserts that list is empty so it cannot pass on a default.
"""
from __future__ import annotations

import datetime
import json


def _plain(value):
    if isinstance(value, datetime.datetime):
        return {"datetime": value.isoformat()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def call_key(path: str, args: tuple, kwargs: dict) -> str:
    """The recording key of one getter call: its path and its exact arguments."""
    return f"{path}{json.dumps([_plain(list(args)), _plain(dict(sorted(kwargs.items())))], default=repr)}"


def encode_value(value) -> dict:
    """One plain COM answer as JSON."""
    if isinstance(value, datetime.datetime):
        return {"dt": value.isoformat()}
    if isinstance(value, tuple):
        return {"v": _plain(value), "tuple": 1}
    return {"v": _plain(value)}


def _decode_value(entry: dict):
    if "dt" in entry:
        return datetime.datetime.fromisoformat(entry["dt"])
    if entry.get("tuple"):
        return tuple(entry["v"])
    return entry["v"]


class ReplayMiss(AttributeError):
    """The code under test made a read the recording does not hold."""


class ReplayObject:
    """Answers a recorded COM object's reads from the recording."""

    def __init__(self, reads: dict, path: str = "dfm", misses: list | None = None) -> None:
        object.__setattr__(self, "_reads", reads)
        object.__setattr__(self, "_path", path)
        object.__setattr__(self, "misses", [] if misses is None else misses)

    def __setattr__(self, name, value):
        raise AssertionError(f"import code wrote {self._path}.{name}; a ResQ read must not write")

    def _answer(self, key: str):
        entry = self._reads.get(key)
        if entry is None:
            self.misses.append(key)
            raise ReplayMiss(f"no recorded answer for {key}")
        if "err" in entry:
            if entry["err"] == "AttributeError":
                raise AttributeError(entry.get("msg") or key)
            raise RuntimeError(f"ResQ raised {entry['err']}: {entry.get('msg', '')}")
        if entry.get("obj"):
            return ReplayObject(self._reads, key, self.misses)
        if entry.get("fn"):
            return lambda *args, **kwargs: self._answer(call_key(key, args, kwargs))
        return _decode_value(entry)

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return self._answer(f"{self._path}.{name}")
