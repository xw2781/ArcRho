from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import helpers


class NetworkPathDetectionTests(unittest.TestCase):
    def test_unc_path_is_network_path(self) -> None:
        self.assertTrue(helpers._is_network_path(r"\\server\ArcRho Server\requests\request.json"))

    def test_mapped_remote_drive_is_network_path(self) -> None:
        with (
            patch.object(helpers.os, "name", "nt"),
            patch.object(helpers.os.path, "splitdrive", return_value=("E:", r"\ArcRho Server\requests\request.json")),
            patch.object(helpers, "_windows_drive_type", return_value=helpers._WINDOWS_DRIVE_REMOTE),
        ):
            self.assertTrue(helpers._is_network_path(r"E:\ArcRho Server\requests\request.json"))

    def test_local_windows_drive_is_not_network_path(self) -> None:
        with (
            patch.object(helpers.os, "name", "nt"),
            patch.object(helpers.os.path, "splitdrive", return_value=("C:", r"\ArcRho\request.json")),
            patch.object(helpers, "_windows_drive_type", return_value=3),
        ):
            self.assertFalse(helpers._is_network_path(r"C:\ArcRho\request.json"))


class NetworkWaitTests(unittest.TestCase):
    def test_network_path_polls_without_starting_watchdog(self) -> None:
        with (
            patch.object(helpers, "_is_network_path", return_value=True),
            patch.object(helpers.os.path, "exists", side_effect=(False, True)),
            patch.object(helpers, "Observer") as observer,
            patch.object(helpers.time, "sleep") as sleep,
        ):
            result = helpers.wait_for_file(r"E:\ArcRho Server\projects\example.csv", timeout_sec=1.0, settle_ms=0)

        self.assertTrue(result)
        observer.assert_not_called()
        sleep.assert_not_called()

    def test_network_path_stops_at_the_requested_timeout(self) -> None:
        with (
            patch.object(helpers, "_is_network_path", return_value=True),
            patch.object(helpers.os.path, "exists", return_value=False),
            patch.object(helpers, "Observer") as observer,
            patch.object(helpers.time, "monotonic", side_effect=(0.0, 0.0, 1.01)),
            patch.object(helpers.time, "sleep") as sleep,
        ):
            result = helpers.wait_for_file(r"E:\ArcRho Server\projects\example.csv", timeout_sec=1.0, settle_ms=0)

        self.assertFalse(result)
        observer.assert_not_called()
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
