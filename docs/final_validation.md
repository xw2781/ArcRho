# Final ResQ/Data-Engine Parity Validation

The validator lives at:

```powershell
py -3.10 python-api/migration/validation/validate_engine_resq_parity.py
```

It reads live ResQ datasets and compares them with fresh, isolated data-engine
output. It does not overwrite ArcRho dataset caches or sidecars. By default it
opens a PowerShell window that follows the detailed temporary progress log; use
`--no-progress-window` for unattended runs.

Each project stores its validation artifacts under:

```text
python-api/migration/validation/result/<project_name>/
```

The folder contains `final_validation.md` and the ignored local-review workbook
`final_validation_issues_<project_name>.xlsx`. The current completed Fake-project result is in
`python-api/migration/validation/result/NJ_Annual_Prod_202605_Fake/`.
