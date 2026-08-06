from __future__ import annotations

import importlib.util
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

        self.assertIn("arcrho_project_duplication_contract.py", names)
        self.assertIn("arcrho_engine_job_lease.py", names)
        self.assertIn("arcrho_dependent_propagation_contract.py", names)

    def test_hatch_wheel_force_includes_the_canonical_contract(self) -> None:
        pyproject_text = (PYTHON_API_ROOT / "pyproject.toml").read_text(
            encoding="utf-8"
        )
        for module_name in (
            "arcrho_project_duplication_contract",
            "arcrho_engine_job_lease",
            "arcrho_dependent_propagation_contract",
        ):
            self.assertIn(
                f'"src/{module_name}.py" = "{module_name}.py"',
                pyproject_text,
            )


if __name__ == "__main__":
    unittest.main()
