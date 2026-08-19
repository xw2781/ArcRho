from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parents[1]
if str(FRONTEND_ROOT) not in sys.path:
    sys.path.insert(0, str(FRONTEND_ROOT))

from starlette.staticfiles import StaticFiles

from app_server import arcode_main, main
from app_server.ui_static import RevalidatedStaticFiles


ASSET_PATH = "method_pages/dfm/dfm_state.js"


def _mounted_static_apps(app) -> list:
    return [
        route.app
        for route in app.routes
        if isinstance(getattr(route, "app", None), StaticFiles)
    ]


class UiAssetRevalidationTests(unittest.TestCase):
    def test_every_static_mount_forces_revalidation(self) -> None:
        for app, label in ((main.app, "arcrho"), (arcode_main.app, "arcode")):
            mounts = _mounted_static_apps(app)
            self.assertTrue(mounts, f"{label} app mounts no static assets")
            for mounted in mounts:
                self.assertIsInstance(
                    mounted,
                    RevalidatedStaticFiles,
                    f"{label} app serves a static mount without revalidation",
                )

    def test_asset_responses_carry_no_cache(self) -> None:
        # A cached module the browser never revalidates can disagree with a
        # freshly fetched importer, and ES module linking fails outright.
        static = RevalidatedStaticFiles(directory=str(FRONTEND_ROOT / "ui"), html=True)
        scope = {
            "type": "http",
            "method": "GET",
            "path": f"/{ASSET_PATH}",
            "headers": [],
            "app": None,
        }

        fresh = asyncio.run(static.get_response(ASSET_PATH, scope))
        self.assertEqual(fresh.status_code, 200)
        self.assertEqual(fresh.headers["cache-control"], "no-cache")

        revalidated_scope = dict(
            scope,
            headers=[(b"if-none-match", fresh.headers["etag"].encode())],
        )
        cached = asyncio.run(static.get_response(ASSET_PATH, revalidated_scope))
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.headers["cache-control"], "no-cache")


if __name__ == "__main__":
    unittest.main()
