"""Public documentation served only from the deployed guide directory."""

from pathlib import Path
from urllib.parse import unquote


GUIDE_DIRECTORY = "user-guide"
GUIDE_PATH = f"/{GUIDE_DIRECTORY}/"
GUIDE_SOURCE = Path(__file__).resolve().parents[3] / "frontend" / "user-manual"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


def guide_asset(server_root: Path, request_path: str) -> tuple[Path, str] | None:
    """Resolve a URL without allowing traversal, drive paths or junction escapes."""
    if not request_path.startswith(GUIDE_PATH):
        return None
    relative = unquote(request_path[len(GUIDE_PATH):]) or "index.html"
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        return None
    if any(character in relative for character in ("\\", ":", "\0")):
        return None
    root = (server_root / GUIDE_DIRECTORY).resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        return None
    content_type = CONTENT_TYPES.get(target.suffix.lower())
    if content_type is None or not target.is_file():
        return None
    return target, content_type
