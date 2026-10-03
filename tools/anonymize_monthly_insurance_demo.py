"""Replace author labels in the guide's fake project on the Server PC.

Run after GUI saves and before screenshots. This is explicit server-local demo
preparation, not a client data transport or an authentication identity override.
The default prints a preview; --apply writes through the canonical JSON formatter
and asks the running app to rebuild affected indexes through its HTTP API.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlencode

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python-api" / "src"))

from arcrho_api.io import persisted_json_text
from arcrho_api.dataset_index_contract import decode_filename_segment
from arcrho_api.ui import _request_json

PROJECT_NAME = "Monthly_Insurance_Dataset"
PROJECT_ROOT = Path(r"E:\ArcRho Server\projects") / PROJECT_NAME
DEMO_AUTHOR = "Jordan Lee"
# These existing fields own authors in sidecars, audit entries and source imports.
AUTHOR_FIELDS = frozenset({"modified_by", "user", "imported_by", "chosen_by"})


def replace_authors(value: object) -> int:
    """Change only nonempty existing author labels, without changing the schema."""
    changed = 0
    if isinstance(value, dict):
        for key, child in value.items():
            if key in AUTHOR_FIELDS and isinstance(child, str) and child and child != DEMO_AUTHOR:
                value[key] = DEMO_AUTHOR
                changed += 1
            else:
                changed += replace_authors(child)
    elif isinstance(value, list):
        for child in value:
            changed += replace_authors(child)
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if os.environ.get("COMPUTERNAME", "").casefold() != "ne7saswpn02":
        parser.error("Run on Server PC NE7SASWPN02; client SMB maintenance is forbidden.")
    if PROJECT_ROOT.resolve() != PROJECT_ROOT or not PROJECT_ROOT.is_dir():
        parser.error("The fixed Monthly_Insurance_Dataset project folder must exist locally.")
    source = _request_json("/source_table?" + urlencode({"project_name": PROJECT_NAME}))
    if Path(source["master_table_path"]).resolve().parent.parent != PROJECT_ROOT:
        parser.error("The running app must be connected to this local demo project.")
    status = _request_json("/source_table/refresh_job/status?" + urlencode({"project_name": PROJECT_NAME}))
    if status.get("busy"):
        parser.error("Wait for the demo source refresh to finish before changing author labels.")

    paths = sorted({
        *PROJECT_ROOT.glob("*.json"),
        *PROJECT_ROOT.glob("source/*.json"),
        *PROJECT_ROOT.glob("data/*/sidecars/*.json"),
        *PROJECT_ROOT.glob("data/*/methods/*.json"),
    })
    classes: set[str] = set()
    files = labels = 0
    for path in paths:
        if path.is_symlink() or PROJECT_ROOT not in path.resolve().parents:
            raise ValueError(f"Refusing a path outside the demo project: {path}")
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        count = replace_authors(payload)
        if not count:
            continue
        print(f"{path.relative_to(PROJECT_ROOT)}: {count} author labels")
        files += 1
        labels += count
        if args.apply:
            temporary = path.with_suffix(".guide-author.tmp")
            try:
                temporary.write_text(persisted_json_text(payload), encoding="utf-8", newline="")
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        if path.parent.name in {"sidecars", "methods"}:
            classes.add(decode_filename_segment(path.parent.parent.name))

    if args.apply:
        for reserving_class in sorted(classes):
            result = _request_json("/datasets/cached?" + urlencode({
                "project_name": PROJECT_NAME,
                "reserving_class": reserving_class,
                "refresh": "true",
            }), timeout_sec=60)
            if not result.get("ok"):
                raise RuntimeError(f"Index refresh failed for {reserving_class}")
    print(f"{'Updated' if args.apply else 'Would update'} {labels} labels in {files} files; "
          f"{len(classes)} class indexes. Author: {DEMO_AUTHOR}.")


if __name__ == "__main__":
    main()
