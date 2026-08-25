from PIL import Image
from pathlib import Path
import sys

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent.parent
SOURCE_ROOT = BASE_DIR.parent
for path in (PROJECT_ROOT, SOURCE_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from utils import resolve_existing_path

png_path = resolve_existing_path(
    PROJECT_ROOT / "library" / "icon" / "ArcRho Engine.png",
    PROJECT_ROOT.parent / "assets" / "icons" / "ArcRho Engine.png",
    PROJECT_ROOT / "assets" / "icons" / "ArcRho Engine.png",
    BASE_DIR / "arcrho_engine.png",
    BASE_DIR / "ArcRho_agent.png",
    BASE_DIR / "ADAS_agent.png",
)
ico_path = png_path.with_suffix(".ico")

img = Image.open(png_path)

sizes = [(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)]

img.save(
    ico_path,
    format="ICO",
    sizes=sizes
)

print("ICO created:", ico_path)
