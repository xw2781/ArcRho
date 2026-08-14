from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from app_server import config
from app_server.services import user_identity_service


class UserIdentityServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        user_identity_service.clear_display_name_cache()

    def tearDown(self) -> None:
        user_identity_service.clear_display_name_cache()

    def test_resolves_full_name_case_insensitively(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            index_path = Path(temp_dir) / "username_index.json"
            index_path.write_text(
                json.dumps({"users": [{"login_name": "XWei.PRCINS", "full_name": "Wei, Xiao"}]}),
                encoding="utf-8",
            )
            with patch.object(config, "get_username_index_path", return_value=str(index_path)):
                self.assertEqual(user_identity_service.resolve_display_name("xwei.prcins"), "Wei, Xiao")

    def test_unmapped_login_falls_back_to_login_name(self) -> None:
        with patch.object(config, "get_username_index_path", return_value="missing.json"):
            self.assertEqual(user_identity_service.resolve_display_name("unmapped.user"), "unmapped.user")

    def test_current_display_name_reads_the_index_once_per_session(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            index_path = Path(temp_dir) / "username_index.json"
            index_path.write_text(
                json.dumps({"users": [{"login_name": "xwei", "full_name": "Wei, Xiao"}]}),
                encoding="utf-8",
            )
            with patch.object(config, "get_username_index_path", return_value=str(index_path)), \
                    patch.object(user_identity_service, "get_windows_login_name", return_value="xwei"):
                self.assertEqual(user_identity_service.get_current_display_name(), "Wei, Xiao")

                # A later edit to the index is not picked up until the cache is
                # cleared, which is what makes every dataset save cheap.
                index_path.write_text(json.dumps({"users": []}), encoding="utf-8")
                self.assertEqual(user_identity_service.get_current_display_name(), "Wei, Xiao")

                user_identity_service.clear_display_name_cache()
                self.assertEqual(user_identity_service.get_current_display_name(), "xwei")

    def test_current_display_name_is_empty_without_a_login(self) -> None:
        with patch.object(user_identity_service, "get_windows_login_name", return_value=""):
            self.assertEqual(user_identity_service.get_current_display_name(), "")


class ActingIdentityTests(unittest.TestCase):
    """A server-side job acts as the user who submitted it, not as itself."""

    def setUp(self) -> None:
        user_identity_service.clear_display_name_cache()

    def tearDown(self) -> None:
        user_identity_service.clear_display_name_cache()

    def test_a_supplied_display_name_wins_over_this_process_identity(self) -> None:
        with patch.dict("os.environ", {"USERNAME": "engine.svc"}, clear=False):
            self.assertEqual(
                user_identity_service.get_windows_login_name(), "engine.svc"
            )
            with user_identity_service.acting_identity("xwei", "Wei, Xiao"):
                self.assertEqual(
                    user_identity_service.get_current_display_name(), "Wei, Xiao"
                )
                self.assertEqual(
                    user_identity_service.get_windows_login_name(), "xwei"
                )
            self.assertEqual(
                user_identity_service.get_windows_login_name(), "engine.svc"
            )

    def test_a_login_without_a_display_name_resolves_through_the_index(self) -> None:
        with tempfile.TemporaryDirectory(dir=str(FRONTEND_ROOT)) as temp_dir:
            index_path = Path(temp_dir) / "username_index.json"
            index_path.write_text(
                json.dumps({"users": [{"login_name": "xwei", "full_name": "Wei, Xiao"}]}),
                encoding="utf-8",
            )
            with patch.object(
                config, "get_username_index_path", return_value=str(index_path)
            ):
                with user_identity_service.acting_identity("xwei"):
                    self.assertEqual(
                        user_identity_service.get_current_display_name(), "Wei, Xiao"
                    )

    def test_an_unmapped_acting_login_stamps_the_login_itself(self) -> None:
        with patch.object(config, "get_username_index_path", return_value="missing.json"):
            with user_identity_service.acting_identity("unmapped.user"):
                self.assertEqual(
                    user_identity_service.get_current_display_name(), "unmapped.user"
                )

    def test_an_empty_login_leaves_the_process_identity_in_place(self) -> None:
        with patch.dict("os.environ", {"USERNAME": "engine.svc"}, clear=False):
            with patch.object(
                config, "get_username_index_path", return_value="missing.json"
            ):
                with user_identity_service.acting_identity("") as identity:
                    self.assertEqual(
                        user_identity_service.get_windows_login_name(), "engine.svc"
                    )
                    self.assertEqual(identity["login_name"], "engine.svc")

    def test_the_binding_is_restored_when_the_save_raises(self) -> None:
        with patch.dict("os.environ", {"USERNAME": "engine.svc"}, clear=False):
            with self.assertRaises(RuntimeError):
                with user_identity_service.acting_identity("xwei", "Wei, Xiao"):
                    raise RuntimeError("the hosted save failed")
            self.assertEqual(
                user_identity_service.get_windows_login_name(), "engine.svc"
            )


if __name__ == "__main__":
    unittest.main()
