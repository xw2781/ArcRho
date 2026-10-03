"""Exercise the actual public guide HTTP handler against an isolated workspace."""

import http.client
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
TEST_ROOT = REPO_ROOT / "test"
TEST_ROOT.mkdir(exist_ok=True)
for path in (REPO_ROOT / "server-components" / "src", REPO_ROOT / "server-components", REPO_ROOT / "python-api" / "src", REPO_ROOT / "frontend"):
    sys.path.insert(0, str(path))

from arcrho_api.gateway_test_guard import allow_test_gateway  # noqa: E402
from arcrho_gateway.main import GatewayServer  # noqa: E402
from arcrho_gateway.user_guide import GUIDE_DIRECTORY, GUIDE_PATH, guide_asset  # noqa: E402
from arcrho_gateway.publish_guide import publish_guide  # noqa: E402
from arcrho_build_components import component_by_key  # noqa: E402
import deploy  # noqa: E402


class UserGuideTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.guide = self.root / GUIDE_DIRECTORY
        (self.guide / "pages").mkdir(parents=True)
        (self.guide / "index.html").write_text("<h1>Arco User Guide</h1>", encoding="utf-8")
        (self.guide / "pages" / "dfm.html").write_text("<h1>DFM</h1>", encoding="utf-8")
        (self.guide / "guide.css").write_text("body { color: black; }", encoding="utf-8")
        (self.guide / "example.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        (self.guide / "private.json").write_text('{"secret":"hidden"}', encoding="utf-8")
        (self.root / "outside.html").write_text("workspace secret", encoding="utf-8")
        self.server = GatewayServer(("127.0.0.1", 0), SimpleNamespace(root=self.root))
        self.addCleanup(self.server.server_close)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 3)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(allow_test_gateway(f"http://127.0.0.1:{self.server.server_port}"))

    def request(self, path, method="GET"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_public_index_page_assets_and_head_have_correct_headers(self):
        for name, content_type in [("", "text/html; charset=utf-8"), ("pages/dfm.html", "text/html; charset=utf-8"), ("guide.css", "text/css; charset=utf-8"), ("example.png", "image/png")]:
            with self.subTest(name=name):
                status, headers, body = self.request(GUIDE_PATH + name)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], content_type)
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["Cache-Control"], "no-cache")
                head_status, head_headers, head_body = self.request(GUIDE_PATH + name, "HEAD")
                self.assertEqual(head_status, 200)
                self.assertEqual(head_headers["Content-Length"], str(len(body)))
                self.assertEqual(head_body, b"")

    def test_slash_redirect_preserves_relative_page_links(self):
        status, headers, body = self.request(GUIDE_PATH.rstrip("/"))
        self.assertEqual(status, 308)
        self.assertEqual(headers["Location"], GUIDE_PATH)
        self.assertEqual(body, b"")

    def test_traversal_drive_paths_private_files_and_directory_lists_are_refused(self):
        for path in ["../outside.html", "%2e%2e/outside.html", "%2f../outside.html", "..%5coutside.html", "C:%5csecret.html", "private.json", "pages/", "missing.html", "index.html%00.png", "index.html:stream.png"]:
            with self.subTest(path=path):
                status, _, body = self.request(GUIDE_PATH + path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"secret", body)
        self.assertEqual(self.request("/outside.html")[0], 404)

    def test_link_resolving_outside_the_guide_is_refused(self):
        outside = self.root / "outside.html"
        original = Path.resolve

        def resolve(path, *args, **kwargs):
            if path.name == "linked.html":
                return outside
            return original(path, *args, **kwargs)

        with patch.object(Path, "resolve", resolve):
            self.assertIsNone(guide_asset(self.root, GUIDE_PATH + "linked.html"))

    def test_changed_guide_is_visible_without_gateway_restart(self):
        (self.guide / "index.html").write_text("updated guide", encoding="utf-8")
        self.assertEqual(self.request(GUIDE_PATH)[2], b"updated guide")

    def test_gateway_working_tree_payload_includes_guide_without_freezing_it(self):
        gateway = component_by_key("gateway")
        self.assertIn("frontend/user-manual", deploy._repository_relative_roots([gateway]))
        self.assertNotIn(REPO_ROOT / "frontend" / "user-manual", gateway.freshness_source_dirs)

    def test_publisher_uses_shared_deploy_rotation_and_rejects_missing_index(self):
        with patch("arcrho_gateway.publish_guide.stage_deploy") as stage, patch("arcrho_gateway.publish_guide.swap_deploy") as swap:
            self.assertEqual(publish_guide(self.root, self.guide), self.guide)
            stage.assert_called_once_with(self.guide, self.root, GUIDE_DIRECTORY)
            swap.assert_called_once_with(self.root, GUIDE_DIRECTORY)
            with self.assertRaises(FileNotFoundError):
                publish_guide(self.root, self.root / "missing")


if __name__ == "__main__":
    unittest.main()
