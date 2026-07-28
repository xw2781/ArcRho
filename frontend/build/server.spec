# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

block_cipher = None
build_dir = Path(SPECPATH)
repo_root = build_dir.parent
monorepo_root = repo_root.parent
python_api_src = monorepo_root / 'python-api' / 'src'
if str(python_api_src) not in sys.path:
    sys.path.insert(0, str(python_api_src))

# Collect served frontend assets and app-server data files.
static_files = []
for asset_dir_name in ('ui', 'icons', 'app_server/default_preferences'):
    asset_dir = repo_root / asset_dir_name
    if asset_dir.exists():
        for f in asset_dir.rglob('*'):
            if f.is_file():
                static_files.append((str(f), str(f.relative_to(repo_root).parent)))

sql_formatting_profile = repo_root / 'app_server' / 'services' / 'sql_formatting' / 'default.sqlfluff'
if sql_formatting_profile.is_file():
    static_files.append((str(sql_formatting_profile), str(sql_formatting_profile.relative_to(repo_root).parent)))
sqlfluff_data = collect_data_files('sqlfluff') + copy_metadata('sqlfluff')

a = Analysis(
    [str(build_dir / 'server_entry.py')],
    pathex=[str(repo_root), str(python_api_src)],
    binaries=[],
    datas=static_files + sqlfluff_data,
    hiddenimports=[
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'fastapi',
        'starlette',
        'starlette.routing',
        'starlette.middleware',
        'starlette.middleware.cors',
        'starlette.staticfiles',
        'starlette.responses',
        'pydantic',
        'pydantic_core',
        'pandas',
        'numpy',
        'openpyxl',
        'watchdog',
        'watchdog.observers',
        'watchdog.events',
        'app_server',
        'app_server.main',
        'app',
    ] + collect_submodules('arcrho_api') + collect_submodules('sqlfluff'),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['sqlalchemy'],
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
    name='arcrho_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # Set to False to hide console window
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
    name='arcrho_server',
)
