# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
import sys
import warnings
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None
build_dir = Path(SPECPATH)
repo_root = build_dir.parent
monorepo_root = repo_root.parent
python_api_src = monorepo_root / "python-api" / "src"
if str(python_api_src) not in sys.path:
    sys.path.insert(0, str(python_api_src))


def include_snowflake_submodule(name):
    return not (
        name.startswith("snowflake.connector.aio")
        or name.startswith("snowflake.connector.vendored.urllib3.contrib.emscripten")
    )


with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    snowflake_hiddenimports = collect_submodules(
        "snowflake.connector",
        filter=include_snowflake_submodule,
    )

static_files = []
asset_roots = [
    repo_root / "ui" / "arcode",
    repo_root / "ui" / "ai-assistant",
    repo_root / "ui" / "libs",
    repo_root / "icons",
]
for asset_dir in asset_roots:
    if asset_dir.exists():
        for f in asset_dir.rglob("*"):
            if f.is_file():
                static_files.append((str(f), str(f.relative_to(repo_root).parent)))

a = Analysis(
    [str(build_dir / "arcode_server_entry.py")],
    pathex=[str(repo_root), str(python_api_src)],
    binaries=[],
    datas=static_files,
    hiddenimports=[
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "fastapi",
        "starlette",
        "starlette.routing",
        "starlette.staticfiles",
        "starlette.responses",
        "pydantic",
        "pydantic_core",
        "pandas",
        "numpy",
        "openpyxl",
        "matplotlib",
        "app_server",
        "app_server.arcode_main",
        "app_server.api.arcode_scripting_router",
    ] + snowflake_hiddenimports + collect_submodules("arcrho_api"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["sqlalchemy"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="arcode_server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="arcode_server",
)
