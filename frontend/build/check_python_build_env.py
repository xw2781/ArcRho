from __future__ import annotations

import importlib
import sys
import warnings
from pathlib import Path


BUILD_DIR = Path(__file__).resolve().parent
FRONTEND_ROOT = BUILD_DIR.parent
MONOREPO_ROOT = FRONTEND_ROOT.parent
PYTHON_API_SRC = MONOREPO_ROOT / "python-api" / "src"

for path in (FRONTEND_ROOT, PYTHON_API_SRC):
    text = str(path)
    if text not in sys.path:
        sys.path.insert(0, text)

REQUIRED_MODULES = {
    "PyInstaller": "pyinstaller",
    "uvicorn": "uvicorn",
    "fastapi": "fastapi",
    "starlette": "starlette",
    "pydantic": "pydantic",
    "pydantic_core": "pydantic-core",
    "pandas": "pandas",
    "numpy": "numpy",
    "openpyxl": "openpyxl",
    "snowflake.connector": "snowflake-connector-python",
    "watchdog": "watchdog",
    "pythoncom": "pywin32",
    "pywintypes": "pywin32",
    "win32com": "pywin32",
    "arcrho_api": None,
}


def main() -> int:
    missing: list[tuple[str, str | None]] = []
    for module_name, package_name in REQUIRED_MODULES.items():
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                importlib.import_module(module_name)
        except Exception:
            missing.append((module_name, package_name))

    if not missing:
        print("Python build dependencies validated.")
        return 0

    print("ERROR: Missing Python build dependencies for the packaged app server.")
    print()
    for module_name, package_name in missing:
        if package_name:
            print(f"- {module_name} (install package: {package_name})")
        else:
            print(f"- {module_name}")

    packages = sorted({package for _, package in missing if package})
    if packages:
        print()
        print("Install missing packages for the selected Python 3.10 interpreter:")
        print(f"  {sys.executable} -m pip install {' '.join(packages)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
