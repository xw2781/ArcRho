"""PyInstaller entry point for the standalone Arcode server."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys._MEIPASS)
    EXE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
    EXE_DIR = BASE_DIR

os.environ.setdefault("TRI_DATA_DIR", str(EXE_DIR))
os.environ.setdefault("ARCRHO_APP_MODE", "arcode")
os.environ.setdefault("ARCODE_DATA_DIR", str(Path.home() / "Documents" / "Arcode" / "scripts"))


def main():
    parser = argparse.ArgumentParser(description="Arcode App Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    import uvicorn

    os.chdir(str(EXE_DIR))
    uvicorn.run(
        "app_server.arcode_main:app",
        host=args.host,
        port=args.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
