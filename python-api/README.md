# ArcRho Python API

`arcrho-api` is a first-party Python package for scripting ArcRho project and DFM workflows against an ArcRho Server root folder.

```python
from arcrho_api import ArcRhoClient

client = ArcRhoClient()
project = client.project("Current Reserve Review")
rc = project.reserving_class(r"Auto\Private Passenger")

dfm = rc.dfm("Paid Loss Ultimate")
dfm.clear()
dfm.exclude_covid_years()
dfm.set_selected_average("Simple - 3")
dfm.set_selected_average_cell_note(1, "Selected before adjustments.", clear_column=True)
dfm.save()
```

On import, the package reads the same server root used by the ArcRho host app from `%APPDATA%\ArcRho\workspace_paths.json`. You can still pass a root explicitly, or update the shared host config from Python:

```python
from arcrho_api import ArcRhoClient, get_server_root, set_server_root

set_server_root(r"E:\ArcRho Server")
print(get_server_root())
client = ArcRhoClient()
```

The package is read/write by default, but writes are explicit: mutations stay in memory until `save()` is called. Use `read_only=True` for audit/exploration workflows.

```python
client = ArcRhoClient(r"E:\ArcRho Server", read_only=True)
```

For legacy notebook migration, `ArcRhoSession` provides a context-bound style with familiar names:

```python
from arcrho_api.migration import ArcRhoSession

session = ArcRhoSession(r"E:\ArcRho Server")
session.set_project("Current Reserve Review")
session.set_reserving_class(r"Auto\Private Passenger")

dfm = session.DFM("Paid Loss Ultimate")
dfm.ex_COVID_AY()
dfm.set_selected_estimate("Simple - 3")
dfm.save()
```

## UI Automation Helpers

When the ArcRho app is running locally, Python macros, notebooks, and external scripts can send typed UI commands to the shell:

```python
from arcrho_api import ArcRhoUI

ui = ArcRhoUI()
ui.wait_for_app(timeout_sec=10)
ui.message_box("Notebook started.", title="ArcRho UI Automation")
progress = ui.progress_bar(title="Long Import", total=3, label="Importing datasets")
progress.update(completed=1, label="Imported Paid Loss")
window = ui.project_instance.open_dataset("Paid Loss")
window.maximize()
print(window.properties.as_dict())
window.restore()
ui.project_instance.reload_dataset_table()
progress.close(auto_close_ms=1000)
```

UI automation targets active app state. For example, `open_dataset_in_active_project_instance(...)` requires an active Project Instance page with a reserving-class path selected.
The object-style API mirrors familiar COM automation patterns: `ArcRhoUI().project_instance.open_dataset(...)` returns an `ArcRhoWindow` with methods such as `activate()`, `maximize()`, `restore()`, `minimize()`, and `close()`, plus current-state properties such as `title`, `is_active`, `is_hidden`, `is_maximized`, and `is_dirty`. Use `ArcRhoUI().project_instance.reload_dataset_table()` after scripts write dataset files that the active Project Instance page should show immediately.
Set `ARCRHO_APP_URL`, or instantiate `ArcRhoUI(app_url="http://127.0.0.1:28765")`, when the app is running on a non-default URL.

### Run a saved or unsaved macro source in the active ArcRho DFM

Arcode bundles `arcrho_api` and its own Python runtime, so users do not need a system Python installation. In a Python editor, use **Run** (or Ctrl+Enter). Arcode automatically executes source with an `<arcrho-macro>` metadata block or top-level `run_macro(...)` entry point against the live unsaved DFM in the open ArcRho window; other Python runs in Arcode's local session. The file can live anywhere and does not need to appear in ArcRho's Macro panel.

The same bridge is available programmatically:

```python
from arcrho_api import ArcRhoUI

ui = ArcRhoUI()
result = ui.macros.run_file(r"E:\My ArcRho Work\apply_growth_adjustments.py")
print(result["message"])
```

For an unsaved editor buffer, call `ui.macros.run_source(source, filename="draft.py", source_path=...)`. ArcRho captures the exact active DFM, runs the conventional `run_macro(active_dfm, active_context)` entry point (also accepting `main(...)`), then applies the returned/mutated payload only if the captured DFM is still open and unchanged. UI-only scripts can run with no active DFM and receive `active_dfm=None`; a returned DFM payload is rejected in that case. Source execution is limited to 120 seconds, and unchanged DFM state is not reapplied or marked dirty. A script's saved parent folder is available for sibling imports. Third-party dependencies still need to be part of the packaged app runtime.

ArcBot uses the same package through a compact command helper. For DFM inspection, prefer the bundled `inspect` command so summary, components, and optional ratio rows are returned in one call:

```powershell
python -m arcrho_api.agent --file active-method.json inspect --include summary,average-formulas,ratio-triangle --origin 2020
```

## Installing From ArcRho

This installation is only needed for external IDEs or Python environments. Arcode already includes the API and a compatible Python runtime.

ArcRho release builds ship a pip-installable wheel in the app resources folder:

```powershell
python -m pip install "<ArcRho install folder>\resources\python_packages\arcrho_api-0.2.0-py3-none-any.whl"
```

Development builds can create the same wheel without network access:

```powershell
python python-api\tools\build_wheel.py --out-dir python-api\dist
python -m pip install python-api\dist\arcrho_api-0.2.0-py3-none-any.whl
```

API-only releases can publish the wheel to the shared ArcRho Server packages folder without rebuilding the desktop app:

```powershell
python-api\tools\publish_package.bat --version 0.1.1
py -3.10 -m pip install --upgrade "E:\ArcRho Server\packages\arcrho_api-latest.whl"
```

Set `PYTHON_API_PACKAGE_DIR` or pass `--package-dir` to publish somewhere other than `E:\ArcRho Server\packages`.
