# ArcRho Retired Macros

This directory holds macros that were withdrawn from service. They are kept only
as a reference copy of how the macro worked when it was retired.

Retired macros are **not maintained**:

- Do not update them for new contracts, APIs, or data formats.
- Do not bump `Version` or add `Release Note` entries.
- Do not deploy them to the user macro directory.
- `publish_macro_library.py` only reads active `*.py` files directly in
  `python-api/macros`, so nothing here reaches the shared macro library.

Retire a macro by moving its file here unchanged, removing the published copy
from the shared library (the library keeps its own copy under
`<library>/archive/<macro-file-stem>/<version>/`), and leaving any prior
versions where they are in `backup/`.

| Macro | Retired | File |
| :--- | :--- | :--- |
| Apply Growth Adjustments | 2026-08-29 | `apply_growth_adjustments.py` |
| Import Active Dataset from ResQ | 2026-08-29 | `import_resq_dataset.py` |
