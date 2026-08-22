"""The one producer of every persisted ArcRho fingerprint.

A fingerprint is a short content hash stored beside the content it describes:
the ``owned`` / ``derived`` / ``publication`` revisions of a method, the
``source_revision`` a method keeps for each precedent snapshot, the
``publication_revision`` copied into an output sidecar, and the processing
``config_hash`` an engine sidecar carries. Every one of them is compared against
a value recomputed later, so both sides must be produced by the same function,
which is why this module exists and why nothing else may call ``hashlib`` for a
persisted revision.

Two rules follow from that:

* The hashed vocabulary is fixed by the projection the caller builds, never by
  the spelling of the persisted keys. A contract that renames its on-disk fields
  must keep emitting the same projection, so a rename is fingerprint-neutral.
* The stored form is ``sha256:`` plus the first sixteen hex characters of the
  digest. Sixteen hex characters (64 bits) are far beyond what a same-file
  integrity check or a "did this precedent move" comparison needs, and the
  shortening lives here so every comparison shortens both of its sides at once.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


FINGERPRINT_PREFIX = "sha256:"
FINGERPRINT_HEX_LENGTH = 16
_FINGERPRINT_RE = re.compile(rf"^{FINGERPRINT_PREFIX}[0-9a-f]{{{FINGERPRINT_HEX_LENGTH}}}$")


def canonical_projection_text(projection: Any) -> str:
    """The exact text a fingerprint digests.

    Keys are sorted and separators are compact, so the on-disk layout a
    producer chooses can never move a fingerprint. ``allow_nan`` is off because
    a NaN would serialize differently across producers.
    """

    return json.dumps(
        projection,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def fingerprint(projection: Any) -> str:
    """Return the stored fingerprint of a canonical projection."""

    digest = hashlib.sha256(canonical_projection_text(projection).encode("utf-8")).hexdigest()
    return f"{FINGERPRINT_PREFIX}{digest[:FINGERPRINT_HEX_LENGTH]}"


def is_fingerprint(value: Any) -> bool:
    """Say whether *value* has the stored fingerprint form."""

    return isinstance(value, str) and bool(_FINGERPRINT_RE.match(value))


__all__ = [
    "FINGERPRINT_HEX_LENGTH",
    "FINGERPRINT_PREFIX",
    "canonical_projection_text",
    "fingerprint",
    "is_fingerprint",
]
