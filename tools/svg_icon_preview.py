"""Build a browser gallery of the repository's SVG icons and open it.

An SVG is a few hundred bytes of geometry, which an editor shows at whatever size the file
declares - usually 16px, far too small to judge. This collects every SVG under the paths given,
inlines them into one self-contained page, and opens that page in the default browser, where they
can be resized, recolored, filtered, and inspected side by side.

    python tools/svg_icon_preview.py
    python tools/svg_icon_preview.py frontend/ui/shell/tab-type-icons
    python tools/svg_icon_preview.py frontend/ui assets --out tmp_data/icons.html
    python tools/svg_icon_preview.py --no-open
    python tools/svg_icon_preview.py --serve

With no path the whole repository is scanned, minus dependency and build directories. The page is
written under `tmp_data/`, which is git-ignored, so regenerating it never dirties the tree.

With --serve the gallery is served from a small local server instead of written as a static file.
Every page load re-scans the SVGs on disk, so the page's own Refresh button (or the browser's
reload) always shows the current file contents - no need to rerun the tool after each edit.
Stop it with Ctrl+C.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import webbrowser
from pathlib import Path
from xml.dom import minidom

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "tmp_data" / "svg_icon_preview" / "index.html"

# Directories that hold vendored, generated, or packaged copies rather than source artwork.
EXCLUDED_DIRS = {
    ".git",
    ".cache",
    ".pytest-tools",
    "__pycache__",
    "dist",
    "node-portable",
    "node_modules",
    "python_build",
    "python_dist",
    "site-packages",
    "venv",
    ".venv",
}

MAX_SOURCE_CHARS = 40_000

# Attributes the gallery sets itself, so a copy from the source file cannot duplicate them.
COPY_SKIP = {"width", "height", "class", "aria-hidden", "preserveAspectRatio"}


# ---------------------------------------------------------------------------- discovery


def find_svg_files(roots: list[Path]) -> list[Path]:
    found: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        if root.is_file():
            candidates = [root]
        else:
            candidates = sorted(root.rglob("*.svg"))
        for path in candidates:
            if any(part in EXCLUDED_DIRS for part in path.parts):
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            found.append(path)
    return sorted(found, key=lambda p: (str(p.parent).lower(), p.name.lower()))


def scan(roots: list[Path]) -> tuple[list[Path], list[dict]]:
    """Re-read every SVG under `roots` from disk. Cheap enough to call on every page load."""
    files = find_svg_files(roots)
    entries: list[dict] = []
    for index, path in enumerate(files):
        entries.extend(read_icons(path, index))
    return files, entries


# ---------------------------------------------------------------------------- svg handling


def _serialize_children(node) -> str:
    parts = []
    for child in node.childNodes:
        if child.nodeType == child.TEXT_NODE and not child.data.strip():
            continue
        parts.append(child.toxml())
    return "".join(parts)


def _attributes(node, drop: set[str]) -> dict[str, str]:
    out = {}
    if node.attributes is None:
        return out
    for i in range(node.attributes.length):
        attr = node.attributes.item(i)
        name = attr.name
        if name in drop or name.startswith("xmlns"):
            continue
        out[name] = attr.value
    return out


def _namespace_ids(markup: str, prefix: str) -> str:
    """Prefix every internal id so two inlined files cannot collide on one page."""
    ids = set(re.findall(r'\bid="([^"]+)"', markup))
    for raw in sorted(ids, key=len, reverse=True):
        escaped = re.escape(raw)
        markup = re.sub(rf'\bid="{escaped}"', f'id="{prefix}{raw}"', markup)
        markup = re.sub(rf'href="#{escaped}"', f'href="#{prefix}{raw}"', markup)
        markup = re.sub(rf'url\(#{escaped}\)', f"url(#{prefix}{raw})", markup)
    return markup


def _view_box(attrs: dict[str, str]) -> str:
    view_box = (attrs.get("viewBox") or "").strip()
    if view_box:
        return view_box
    width = (attrs.get("width") or "").strip().rstrip("px")
    height = (attrs.get("height") or "").strip().rstrip("px")
    try:
        return f"0 0 {float(width):g} {float(height):g}"
    except ValueError:
        return "0 0 24 24"


def read_icons(path: Path, index: int) -> list[dict]:
    """Turn one file into one gallery entry, or several when it is a symbol sprite."""
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [_broken_entry(path, f"could not be read: {exc}")]

    try:
        document = minidom.parseString(source.encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - any parse failure is reported the same way
        return [_broken_entry(path, f"is not well-formed XML: {exc}")]

    root = document.documentElement
    if root.tagName != "svg":
        return [_broken_entry(path, f"has a <{root.tagName}> root instead of <svg>")]

    symbols = [
        node
        for node in root.getElementsByTagName("symbol")
        if node.getAttribute("id")
    ]

    rel = path.relative_to(REPO_ROOT).as_posix()
    group = str(Path(rel).parent).replace("\\", "/")
    trimmed = source if len(source) <= MAX_SOURCE_CHARS else source[:MAX_SOURCE_CHARS] + "\n..."

    if symbols:
        entries = []
        for order, symbol in enumerate(symbols):
            symbol_id = symbol.getAttribute("id")
            attrs = _attributes(symbol, drop=COPY_SKIP | {"id"})
            markup = _namespace_ids(_serialize_children(symbol), f"g{index}s{order}-")
            entries.append(
                {
                    "name": f"{path.stem} › {symbol_id}",
                    "file": path.name,
                    "path": rel,
                    "group": group,
                    "viewBox": _view_box(attrs),
                    "attrs": {k: v for k, v in attrs.items() if k != "viewBox"},
                    "markup": markup,
                    "bytes": path.stat().st_size,
                    "source": trimmed,
                    "note": "one symbol of a sprite file",
                    "ok": True,
                }
            )
        return entries

    attrs = _attributes(root, drop=COPY_SKIP | {"id"})
    markup = _namespace_ids(_serialize_children(root), f"g{index}-")
    return [
        {
            "name": path.stem,
            "file": path.name,
            "path": rel,
            "group": group,
            "viewBox": _view_box(attrs),
            "attrs": {k: v for k, v in attrs.items() if k != "viewBox"},
            "markup": markup,
            "bytes": path.stat().st_size,
            "source": trimmed,
            "note": "",
            "ok": True,
        }
    ]


def _broken_entry(path: Path, reason: str) -> dict:
    rel = path.relative_to(REPO_ROOT).as_posix()
    return {
        "name": path.stem,
        "file": path.name,
        "path": rel,
        "group": str(Path(rel).parent).replace("\\", "/"),
        "viewBox": "0 0 24 24",
        "attrs": {},
        "markup": "",
        "bytes": path.stat().st_size if path.exists() else 0,
        "source": "",
        "note": reason,
        "ok": False,
    }


# ---------------------------------------------------------------------------- page


def render_card(entry: dict, index: int) -> str:
    attr_text = " ".join(f'{name}="{html.escape(value, quote=True)}"' for name, value in entry["attrs"].items())
    if entry["ok"]:
        art = (
            f'<svg class="art" viewBox="{html.escape(entry["viewBox"], quote=True)}" '
            f'preserveAspectRatio="xMidYMid meet" {attr_text} aria-hidden="true">'
            f'{entry["markup"]}</svg>'
        )
    else:
        art = '<div class="broken" title="this file could not be drawn">!</div>'

    return (
        f'<button type="button" class="card" data-index="{index}" '
        f'data-search="{html.escape((entry["name"] + " " + entry["path"]).lower(), quote=True)}">'
        f'<span class="stage"><span class="art-wrap">{art}</span></span>'
        f'<span class="label" title="{html.escape(entry["path"], quote=True)}">{html.escape(entry["name"])}</span>'
        f"</button>"
    )


def build_page(entries: list[dict], roots: list[Path], live: bool = False) -> str:
    groups: dict[str, list[tuple[int, dict]]] = {}
    for index, entry in enumerate(entries):
        groups.setdefault(entry["group"], []).append((index, entry))

    sections = []
    for group in sorted(groups):
        cards = "\n".join(render_card(entry, index) for index, entry in groups[group])
        sections.append(
            f'<section class="group" data-group="{html.escape(group, quote=True)}">'
            f'<h2><span class="groupName">{html.escape(group or ".")}</span>'
            f'<span class="count">{len(groups[group])}</span></h2>'
            f'<div class="grid">{cards}</div>'
            f"</section>"
        )

    meta = [
        {
            "name": entry["name"],
            "file": entry["file"],
            "path": entry["path"],
            "viewBox": entry["viewBox"],
            "bytes": entry["bytes"],
            "note": entry["note"],
            "ok": entry["ok"],
            "source": entry["source"],
        }
        for entry in entries
    ]
    scanned = ", ".join(str(root.relative_to(REPO_ROOT)) if root != REPO_ROOT else "." for root in roots)
    mode_note = (
        " &middot; live: Refresh shows current disk contents"
        if live
        else " &middot; static snapshot: rerun the tool (or use --serve) to update"
    )

    return PAGE_TEMPLATE.format(
        count=len(entries),
        group_count=len(groups),
        scanned=html.escape(scanned),
        mode_note=mode_note,
        sections="\n".join(sections),
        meta=json.dumps(meta).replace("</", "<\\/"),
    )


PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SVG Icon Preview</title>
<style>
  :root {{
    color-scheme: light;
    --bg: #eef2f6;
    --panel: #ffffff;
    --text: #202327;
    --muted: #667085;
    --border: #d8dde3;
    --accent: #2b6df6;
    --ink: #333a45;
    --stage: #ffffff;
    --size: 64px;
  }}
  body.dark {{
    --bg: #161b22;
    --panel: #1f2733;
    --text: #e6ebf2;
    --muted: #9aa5b4;
    --border: #333e4d;
    --ink: #e6ebf2;
    --stage: #131922;
  }}

  * {{ box-sizing: border-box; }}

  body {{
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: Arial, "Segoe UI", "SegoeUI", Tahoma, sans-serif;
    font-size: 13px;
    line-height: 1.45;
  }}

  header {{
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 10px 18px;
  }}
  .titleRow {{ display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }}
  h1 {{ margin: 0; font-size: 16px; font-weight: 700; }}
  .sub {{ color: var(--muted); font-size: 12px; }}

  .toolbar {{
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 9px;
  }}
  .tool {{ display: flex; align-items: center; gap: 7px; }}
  .tool > label {{ color: var(--muted); font-size: 11px; font-weight: 700; }}

  input[type="search"] {{
    width: 230px;
    height: 28px;
    padding: 0 9px;
    font: inherit;
    color: var(--text);
    background: var(--stage);
    border: 1px solid var(--border);
    border-radius: 4px;
  }}
  input[type="range"] {{ width: 170px; accent-color: var(--accent); }}
  input[type="color"] {{
    width: 28px; height: 28px; padding: 0;
    background: none; border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
  }}

  .chip {{
    height: 28px;
    min-width: 34px;
    padding: 0 9px;
    font: inherit;
    font-size: 12px;
    color: var(--text);
    background: var(--stage);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
  }}
  .chip:hover {{ border-color: var(--accent); }}
  .chip.on {{ background: var(--accent); border-color: var(--accent); color: #ffffff; font-weight: 700; }}
  .chips {{ display: flex; gap: 4px; }}

  main {{ padding: 16px 18px 60px; }}

  .group {{ margin-bottom: 22px; }}
  .group h2 {{
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 8px 0; font-size: 11px; font-weight: 700; color: var(--muted);
  }}
  .count {{
    background: var(--border); color: var(--text);
    border-radius: 9px; padding: 1px 7px; font-size: 10px;
  }}

  .grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--size) + 44px), 1fr));
    gap: 10px;
  }}

  .card {{
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    padding: 10px 6px 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    color: inherit;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }}
  .card:hover {{ border-color: var(--accent); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06); }}
  .card.sel {{ border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }}

  .stage {{
    display: grid;
    place-items: center;
    width: 100%;
    min-height: calc(var(--size) + 16px);
    padding: 8px;
    background: var(--stage);
    border-radius: 3px;
  }}
  body.checker .stage {{
    background-image:
      linear-gradient(45deg, rgba(128,138,152,0.24) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(128,138,152,0.24) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(128,138,152,0.24) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(128,138,152,0.24) 75%);
    background-size: 12px 12px;
    background-position: 0 0, 0 6px, 6px -6px, -6px 0;
  }}

  .art-wrap {{ display: block; color: var(--ink); }}
  .art {{ display: block; width: var(--size); height: var(--size); }}

  .broken {{
    width: var(--size); height: var(--size);
    display: grid; place-items: center;
    color: #be123c; font-weight: 700; font-size: calc(var(--size) / 2);
  }}

  .label {{
    max-width: 100%;
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }}

  /* Detail drawer */
  #drawer {{
    position: fixed;
    right: 0; top: 0; bottom: 0;
    width: min(430px, 92vw);
    background: var(--panel);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 20px rgba(15, 23, 42, 0.08);
    transform: translateX(100%);
    transition: transform 160ms ease;
    z-index: 10;
    display: flex;
    flex-direction: column;
  }}
  #drawer.open {{ transform: translateX(0); }}
  .drawerHead {{
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
  }}
  .drawerHead h3 {{ margin: 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }}
  .drawerBody {{ padding: 14px; overflow: auto; }}

  .bigStage {{
    display: grid; place-items: center;
    min-height: 230px; padding: 16px;
    background: var(--stage);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--ink);
  }}
  .bigStage svg {{ width: 200px; height: 200px; }}

  .sizeRow {{ display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-top: 14px; color: var(--ink); }}
  .sizeItem {{ display: grid; justify-items: center; gap: 5px; }}
  .sizeItem span {{ font-size: 10px; color: var(--muted); }}

  dl {{ display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 16px 0 0 0; }}
  dt {{ color: var(--muted); font-size: 11px; font-weight: 700; }}
  dd {{ margin: 0; overflow-wrap: anywhere; font-family: Consolas, "Courier New", monospace; font-size: 11px; }}

  pre {{
    margin: 14px 0 0 0; padding: 10px;
    background: var(--stage); border: 1px solid var(--border); border-radius: 4px;
    font-family: Consolas, "Courier New", monospace; font-size: 11px;
    white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto;
  }}

  .drawerBtns {{ display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }}
  .empty {{ padding: 40px 0; text-align: center; color: var(--muted); }}
</style>
</head>
<body>
<header>
  <div class="titleRow">
    <h1>SVG Icon Preview</h1>
    <span class="sub"><strong id="shown">{count}</strong> of {count} icons in {group_count} folders &middot; scanned <code>{scanned}</code>{mode_note}</span>
    <button type="button" class="chip" id="refreshBtn" title="Reload this page">&#8635; Refresh</button>
  </div>
  <div class="toolbar">
    <div class="tool">
      <label for="q">Find</label>
      <input id="q" type="search" placeholder="name or path, / to focus" autocomplete="off">
    </div>
    <div class="tool">
      <label for="size">Size</label>
      <input id="size" type="range" min="16" max="256" step="2" value="64">
      <span class="chips">
        <button type="button" class="chip preset" data-size="16">16</button>
        <button type="button" class="chip preset" data-size="24">24</button>
        <button type="button" class="chip preset" data-size="48">48</button>
        <button type="button" class="chip preset" data-size="96">96</button>
        <button type="button" class="chip preset" data-size="160">160</button>
      </span>
    </div>
    <div class="tool">
      <label for="ink">Color</label>
      <span class="chips">
        <button type="button" class="chip swatch" data-ink="#333a45">Ink</button>
        <button type="button" class="chip swatch" data-ink="#2b6df6">Blue</button>
        <button type="button" class="chip swatch" data-ink="#667085">Grey</button>
        <button type="button" class="chip swatch" data-ink="#ffffff">White</button>
      </span>
      <input id="ink" type="color" value="#333a45" title="Any other color">
    </div>
    <div class="tool">
      <label>Background</label>
      <span class="chips">
        <button type="button" class="chip bg" data-bg="light">Light</button>
        <button type="button" class="chip bg" data-bg="dark">Dark</button>
        <button type="button" class="chip bg" data-bg="checker">Checker</button>
      </span>
    </div>
  </div>
</header>

<main id="main">
{sections}
  <div class="empty" id="empty" hidden>Nothing matches that search.</div>
</main>

<aside id="drawer" aria-hidden="true">
  <div class="drawerHead">
    <h3 id="dName"></h3>
    <button type="button" class="chip" id="dClose" aria-label="Close">Close</button>
  </div>
  <div class="drawerBody">
    <div class="bigStage" id="dStage"></div>
    <div class="sizeRow" id="dSizes"></div>
    <dl>
      <dt>Path</dt><dd id="dPath"></dd>
      <dt>viewBox</dt><dd id="dBox"></dd>
      <dt>Bytes</dt><dd id="dBytes"></dd>
      <dt>Note</dt><dd id="dNote"></dd>
    </dl>
    <div class="drawerBtns">
      <button type="button" class="chip" id="dCopyPath">Copy path</button>
      <button type="button" class="chip" id="dCopySvg">Copy SVG source</button>
    </div>
    <pre id="dSource"></pre>
  </div>
</aside>

<script>
const META = {meta};
const KEY = "arcrho.svgPreview.v1";

const body = document.body;
const cards = Array.from(document.querySelectorAll(".card"));
const groups = Array.from(document.querySelectorAll(".group"));
const shown = document.getElementById("shown");
const empty = document.getElementById("empty");

const state = Object.assign({{ size: 64, ink: "#333a45", bg: "light" }}, load());

function load() {{
  try {{ return JSON.parse(localStorage.getItem(KEY) || "{{}}"); }} catch {{ return {{}}; }}
}}
function save() {{
  try {{ localStorage.setItem(KEY, JSON.stringify(state)); }} catch {{ /* private window */ }}
}}

function applySize(px) {{
  state.size = px;
  document.documentElement.style.setProperty("--size", px + "px");
  document.getElementById("size").value = px;
  document.querySelectorAll(".preset").forEach(b => b.classList.toggle("on", Number(b.dataset.size) === px));
  save();
}}

function applyInk(color) {{
  state.ink = color;
  document.documentElement.style.setProperty("--ink", color);
  document.getElementById("ink").value = color;
  document.querySelectorAll(".swatch").forEach(b => b.classList.toggle("on", b.dataset.ink.toLowerCase() === color.toLowerCase()));
  save();
}}

function applyBg(mode) {{
  state.bg = mode;
  body.classList.toggle("dark", mode === "dark");
  body.classList.toggle("checker", mode === "checker");
  document.querySelectorAll(".bg").forEach(b => b.classList.toggle("on", b.dataset.bg === mode));
  save();
}}

document.getElementById("refreshBtn").addEventListener("click", () => location.reload());

document.getElementById("size").addEventListener("input", e => applySize(Number(e.target.value)));
document.querySelectorAll(".preset").forEach(b => b.addEventListener("click", () => applySize(Number(b.dataset.size))));
document.getElementById("ink").addEventListener("input", e => applyInk(e.target.value));
document.querySelectorAll(".swatch").forEach(b => b.addEventListener("click", () => applyInk(b.dataset.ink)));
document.querySelectorAll(".bg").forEach(b => b.addEventListener("click", () => applyBg(b.dataset.bg)));

const q = document.getElementById("q");
q.addEventListener("input", () => {{
  const needle = q.value.trim().toLowerCase();
  let count = 0;
  cards.forEach(card => {{
    const hit = !needle || card.dataset.search.includes(needle);
    card.hidden = !hit;
    if (hit) count += 1;
  }});
  groups.forEach(g => {{
    g.hidden = !Array.from(g.querySelectorAll(".card")).some(c => !c.hidden);
  }});
  shown.textContent = String(count);
  empty.hidden = count > 0;
}});

document.addEventListener("keydown", e => {{
  if (e.key === "/" && document.activeElement !== q) {{ e.preventDefault(); q.focus(); q.select(); }}
  if (e.key === "Escape") {{
    if (document.activeElement === q && q.value) {{ q.value = ""; q.dispatchEvent(new Event("input")); }}
    else closeDrawer();
  }}
}});

// ---- detail drawer
const drawer = document.getElementById("drawer");
let current = -1;

function closeDrawer() {{
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  cards.forEach(c => c.classList.remove("sel"));
  current = -1;
}}

function openDrawer(index) {{
  const info = META[index];
  const card = cards.find(c => Number(c.dataset.index) === index);
  if (!info || !card) return;
  current = index;
  cards.forEach(c => c.classList.toggle("sel", c === card));

  document.getElementById("dName").textContent = info.name;
  document.getElementById("dPath").textContent = info.path;
  document.getElementById("dBox").textContent = info.viewBox;
  document.getElementById("dBytes").textContent = info.bytes.toLocaleString();
  document.getElementById("dNote").textContent = info.note || (info.ok ? "\\u2014" : "unreadable");
  document.getElementById("dSource").textContent = info.source || "(source not stored)";

  const art = card.querySelector("svg");
  const stage = document.getElementById("dStage");
  stage.textContent = "";
  if (art) stage.appendChild(art.cloneNode(true));

  const sizes = document.getElementById("dSizes");
  sizes.textContent = "";
  [14, 16, 20, 24, 32, 48, 64].forEach(px => {{
    const item = document.createElement("div");
    item.className = "sizeItem";
    if (art) {{
      const copy = art.cloneNode(true);
      copy.style.width = px + "px";
      copy.style.height = px + "px";
      item.appendChild(copy);
    }}
    const tag = document.createElement("span");
    tag.textContent = px;
    item.appendChild(tag);
    sizes.appendChild(item);
  }});

  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}}

cards.forEach(card => card.addEventListener("click", () => {{
  const index = Number(card.dataset.index);
  if (index === current) closeDrawer(); else openDrawer(index);
}}));
document.getElementById("dClose").addEventListener("click", closeDrawer);

function copy(text, button) {{
  const done = () => {{
    const was = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {{ button.textContent = was; }}, 1100);
  }};
  if (navigator.clipboard && navigator.clipboard.writeText) {{
    navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
  }} else {{
    fallback(text, done);
  }}
}}
function fallback(text, done) {{
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {{ document.execCommand("copy"); done(); }} catch {{ /* nothing else to try */ }}
  area.remove();
}}

document.getElementById("dCopyPath").addEventListener("click", e => {{
  if (current >= 0) copy(META[current].path, e.currentTarget);
}});
document.getElementById("dCopySvg").addEventListener("click", e => {{
  if (current >= 0) copy(META[current].source, e.currentTarget);
}});

applySize(state.size);
applyInk(state.ink);
applyBg(state.bg);
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------- live server


def run_server(roots: list[Path], port: int, open_browser: bool) -> None:
    import http.server

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - required override name
            if self.path.startswith("/favicon"):
                self.send_response(404)
                self.end_headers()
                return
            _files, entries = scan(roots)
            body = build_page(entries, roots, live=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
            pass  # keep the console quiet; errors still show via exceptions

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Serving live at {url} - edit an SVG, then press Refresh in the page. Ctrl+C to stop.")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


# ---------------------------------------------------------------------------- cli


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Build a browser gallery of SVG icons and open it.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="files or folders to scan, relative to the repository root (default: the whole repository)",
    )
    parser.add_argument("--out", default=str(DEFAULT_OUT), help=f"output HTML file (default: {DEFAULT_OUT})")
    parser.add_argument("--no-open", action="store_true", help="write the page but do not open a browser")
    parser.add_argument(
        "--serve",
        action="store_true",
        help="serve the gallery live instead of writing a static file, so its Refresh button "
        "always shows the current SVGs on disk (Ctrl+C to stop)",
    )
    parser.add_argument("--port", type=int, default=0, help="port for --serve (default: pick any free port)")
    args = parser.parse_args(argv)

    roots: list[Path] = []
    for raw in args.paths or ["."]:
        path = Path(raw)
        if not path.is_absolute():
            path = REPO_ROOT / path
        if not path.exists():
            print(f"error: {raw} does not exist", file=sys.stderr)
            return 2
        roots.append(path.resolve())

    files, entries = scan(roots)
    if not files:
        print("No SVG files found under: " + ", ".join(str(r) for r in roots), file=sys.stderr)
        return 1

    if args.serve:
        run_server(roots, args.port, open_browser=not args.no_open)
        return 0

    out = Path(args.out)
    if not out.is_absolute():
        out = REPO_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_page(entries, roots), encoding="utf-8")

    broken = [e for e in entries if not e["ok"]]
    print(f"{len(entries)} icons from {len(files)} files -> {out}")
    if broken:
        print(f"{len(broken)} could not be drawn:")
        for entry in broken:
            print(f"  {entry['path']}: {entry['note']}")

    if not args.no_open:
        webbrowser.open(out.as_uri())
        print("Opened in the default browser.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
