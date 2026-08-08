"""Shared config reads must survive concurrent writers.

config.json is rewritten by other ArcRho apps while supervisor loops re-read
it every couple of seconds. On Windows the reader can hit a transient
PermissionError during the writer's atomic replace, or a torn read that fails
JSON parsing. load_config must retry, then fall back to the last successfully
loaded config instead of crashing the supervisor.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ENGINE_SRC = Path(__file__).resolve().parents[1] / "src"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

import utils  # noqa: E402


class _FlakyConfigPath:
    """Stand-in for CONFIG_PATH whose open() fails a set number of times."""

    def __init__(self, payload, failures=0, error=PermissionError(13, "Permission denied")):
        self.payload = payload
        self.failures = failures
        self.error = error
        self.open_calls = 0

    def exists(self):
        return True

    def open(self, *args, **kwargs):
        self.open_calls += 1
        if self.open_calls <= self.failures:
            raise self.error
        import io

        return io.StringIO(json.dumps(self.payload))


class LoadConfigResilienceTests(unittest.TestCase):
    def setUp(self):
        utils._last_good_config = None
        self.sleep_patch = patch.object(utils.time, "sleep", lambda *_: None)
        self.sleep_patch.start()

    def tearDown(self):
        self.sleep_patch.stop()
        utils._last_good_config = None

    def test_transient_permission_error_is_retried(self):
        fake = _FlakyConfigPath({"apps": {"bridge": {"max_workers": 2}}}, failures=2)
        with patch.object(utils, "CONFIG_PATH", fake):
            self.assertEqual(utils.load_config(), {"apps": {"bridge": {"max_workers": 2}}})
        self.assertEqual(fake.open_calls, 3)

    def test_torn_read_is_retried(self):
        fake = _FlakyConfigPath(
            {"shared": {"data_dir": "x"}},
            failures=1,
            error=json.JSONDecodeError("Expecting value", "", 0),
        )
        with patch.object(utils, "CONFIG_PATH", fake):
            self.assertEqual(utils.load_config(), {"shared": {"data_dir": "x"}})

    def test_persistent_failure_falls_back_to_last_good_config(self):
        good = _FlakyConfigPath({"apps": {"bridge": {"max_workers": 3}}})
        with patch.object(utils, "CONFIG_PATH", good):
            utils.load_config()

        broken = _FlakyConfigPath({}, failures=99)
        with patch.object(utils, "CONFIG_PATH", broken):
            self.assertEqual(utils.load_config(), {"apps": {"bridge": {"max_workers": 3}}})
        self.assertEqual(broken.open_calls, 5)

    def test_persistent_failure_without_cache_raises(self):
        broken = _FlakyConfigPath({}, failures=99)
        with patch.object(utils, "CONFIG_PATH", broken):
            with self.assertRaises(PermissionError):
                utils.load_config()

    def test_get_config_value_uses_resilient_loader(self):
        fake = _FlakyConfigPath({"apps": {"bridge": {"max_workers": 4}}}, failures=2)
        with patch.object(utils, "CONFIG_PATH", fake):
            self.assertEqual(utils.get_config_value("apps.bridge.max_workers", 1), 4)


if __name__ == "__main__":
    unittest.main()
