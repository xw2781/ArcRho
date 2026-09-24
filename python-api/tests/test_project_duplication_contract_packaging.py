from __future__ import annotations

import importlib.util
import re
import tempfile
import unittest
import zipfile
from pathlib import Path


PYTHON_API_ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = Path(__file__).resolve().parent / "logs" / "tmp"
BUILD_WHEEL_PATH = PYTHON_API_ROOT / "tools" / "build_wheel.py"


def _load_wheel_builder():
    spec = importlib.util.spec_from_file_location(
        "arcrho_test_wheel_builder",
        BUILD_WHEEL_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the ArcRho wheel builder.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProjectDuplicationContractPackagingTests(unittest.TestCase):
    def test_custom_wheel_contains_the_standalone_canonical_contract(self) -> None:
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        builder = _load_wheel_builder()
        with tempfile.TemporaryDirectory(dir=str(TEST_TMP_ROOT)) as temp_dir:
            wheel_path = builder.build_wheel(Path(temp_dir))
            with zipfile.ZipFile(wheel_path) as wheel:
                names = set(wheel.namelist())

        for path in builder.STANDALONE_MODULES:
            self.assertIn(path.name, names)

    def test_hatch_wheel_force_includes_the_canonical_contract(self) -> None:
        pyproject_text = (PYTHON_API_ROOT / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        for path in _load_wheel_builder().STANDALONE_MODULES:
            self.assertIn(
                f'"src/{path.name}" = "{path.name}"',
                pyproject_text,
            )

    def test_wheel_carries_every_contract_the_gateway_client_imports(self) -> None:
        source = (PYTHON_API_ROOT / "src" / "arcrho_api" / "gateway.py").read_text(
            encoding="utf-8"
        )
        imported = set(re.findall(r"^from (arcrho_\w+_contract) import", source, re.M))
        shipped = {path.stem for path in _load_wheel_builder().STANDALONE_MODULES}
        self.assertTrue(imported)
        self.assertLessEqual(imported, shipped)


if __name__ == "__main__":
    unittest.main()
