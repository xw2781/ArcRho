"""Give this PC its own ArcRho Gateway credential.

The Excel add-in starts this helper the first time it finds no credential on
the machine, so an Excel-only user is never set up by hand. The work itself is
``arcrho_api.hosted_save_enrollment.enroll_once``: this file only says which
workspace to read, who is asking, and where the credential goes, then prints
one line about what happened.

The workspace share is the authentication. The user's secret is added to the
shared registry under that user's own Windows account, which is how the server
knows who asked; the Gateway itself grows no enrollment route, because plain
HTTP on the port could not tell one caller from another.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = BASE_DIR.parents[2]
API_SOURCE = REPOSITORY_ROOT / "python-api" / "src"
if not getattr(sys, "frozen", False) and str(API_SOURCE) not in sys.path:
    sys.path.insert(0, str(API_SOURCE))

from arcrho_api.config import config_dir  # noqa: E402
from arcrho_api.hosted_save_enrollment import enroll_once  # noqa: E402
from arcrho_hosted_save_http_contract import CLIENT_CONFIG_FILE_NAME  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Install this Windows user's ArcRho Gateway credential."
    )
    parser.add_argument(
        "workspace_root",
        help="The ArcRho Server workspace folder, reached over the share.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    result = enroll_once(
        server_root=Path(args.workspace_root).expanduser(),
        client_output=config_dir() / CLIENT_CONFIG_FILE_NAME,
        user=os.environ.get("USERNAME", ""),
    )
    status = result["status"]
    if status == "enrolled":
        print(f"ArcRho credential installed: {result['path']}")
        return 0
    if status == "existing":
        print(f"ArcRho credential already present: {result['path']}")
        return 0
    if status == "not_configured":
        print("ArcRho Server has no Gateway address for clients to use.")
        return 1
    print(f"ArcRho credential not installed: {result['reason']}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
