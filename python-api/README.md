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

ArcBot uses the same package through a compact command helper. For DFM inspection, prefer the bundled `inspect` command so summary, components, and optional ratio rows are returned in one call:

```powershell
python -m arcrho_api.agent --file active-method.json inspect --include summary,average-formulas,ratio-triangle --origin 2020
```

## Installing From ArcRho

ArcRho release builds ship a pip-installable wheel in the app resources folder:

```powershell
python -m pip install "<ArcRho install folder>\resources\python_packages\arcrho_api-0.1.0-py3-none-any.whl"
```

Development builds can create the same wheel without network access:

```powershell
python python-api\tools\build_wheel.py --out-dir python-api\dist
python -m pip install python-api\dist\arcrho_api-0.1.0-py3-none-any.whl
```

API-only releases can publish the wheel to the shared ArcRho Server packages folder without rebuilding the desktop app:

```powershell
python-api\tools\publish_package.bat --version 0.1.1
py -3.10 -m pip install --upgrade "E:\ArcRho Server\packages\arcrho_api-latest.whl"
```

Set `PYTHON_API_PACKAGE_DIR` or pass `--package-dir` to publish somewhere other than `E:\ArcRho Server\packages`.
