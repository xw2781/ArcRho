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


if __name__ == "__main__":
    unittest.main()
