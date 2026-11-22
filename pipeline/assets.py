"""Vendor runtime assets and write the precache manifest + service worker.

  python pipeline/assets.py

1. Copies MapLibre, pmtiles (+fflate), @protomaps/basemaps from node_modules into web/vendor/,
   and Protomaps fonts (glyph PBFs) and sprites from .cache/basemaps-assets into web/.
2. Generates the app icons (pure Python PNG writer) and a 1 s silent keep-awake video (ffmpeg, optional).
3. Writes web/precache.json — every file the app may request, with size and sha256 — and
   web/sw.js from web/js/sw-template.js with the manifest version baked in, so a new data
   build always produces a new service worker.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
NM = ROOT / "node_modules"
ASSETS = ROOT / ".cache/basemaps-assets"
FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"]
SPRITES = ["light", "dark"]

# Files the app shell needs to boot offline: cached by the service worker at install time.
SHELL_PREFIXES = ("index.html", "manifest.webmanifest", "css/", "js/", "vendor/", "icons/", "sprites/",
                  "data/route.json", "data/basemap.json", "data/pois/index.json", "media/")


def vendor():
    v = WEB / "vendor"
    if v.exists():
        shutil.rmtree(v)
    v.mkdir(parents=True)
    copies = {
        NM / "maplibre-gl/dist/maplibre-gl.mjs": "maplibre-gl.mjs",
        NM / "maplibre-gl/dist/maplibre-gl-worker.mjs": "maplibre-gl-worker.mjs",
        NM / "maplibre-gl/dist/maplibre-gl.css": "maplibre-gl.css",
        NM / "maplibre-gl/LICENSE.txt": "LICENSE-maplibre.txt",
        NM / "pmtiles/dist/esm/index.js": "pmtiles.mjs",
        NM / "fflate/esm/browser.js": "fflate.mjs",
        NM / "@protomaps/basemaps/dist/esm/index.js": "basemaps.mjs",
    }
    for src, dst in copies.items():
        if not src.exists():
            sys.exit(f"missing {src} — run `npm install` first")
        text = src.read_bytes()
        # strip sourcemap comments: the .map files are not shipped, and Safari would try to fetch them
        text = text.replace(b"//# sourceMappingURL=", b"// (sourcemap removed) ")
        (v / dst).write_bytes(text)

    fonts = WEB / "fonts"
    if fonts.exists():
        shutil.rmtree(fonts)
    for f in FONTS:
        shutil.copytree(ASSETS / "fonts" / f, fonts / f)
    shutil.copy(ASSETS / "fonts/OFL.txt", fonts / "OFL.txt")
    sp = WEB / "sprites"
    if sp.exists():
        shutil.rmtree(sp)
    sp.mkdir()
    for s in SPRITES:
        for suf in (".json", ".png", "@2x.json", "@2x.png"):
            shutil.copy(ASSETS / "sprites/v4" / f"{s}{suf}", sp / f"{s}{suf}")


# ---------------------------------------------------------------- icons

def png(w, h, pixel):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw += bytes(pixel(x, y))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def icon(size, maskable=False):
    """An airplane window: rounded frame, sky-to-ground gradient, a horizon line."""
    def px(x, y):
        u, v = (x + 0.5) / size, (y + 0.5) / size
        inset = 0.20 if maskable else 0.12
        # window: rounded rectangle (superellipse-ish) in the middle
        cx, cy = (u - 0.5) / (0.5 - inset), (v - 0.5) / (0.5 - inset * 0.6)
        inside = abs(cx) ** 4 + abs(cy) ** 4 < 1
        frame = abs(cx) ** 4 + abs(cy) ** 4 < 1.45
        if inside:
            if v < 0.58:
                t = v / 0.58
                return (int(40 + 80 * t), int(90 + 100 * t), int(170 + 60 * t))
            t = (v - 0.58) / 0.42
            return (int(60 - 20 * t), int(110 - 40 * t), int(80 - 30 * t))
        if frame:
            return (226, 230, 236)
        return (24, 32, 56)
    return png(size, size, px)


def icons():
    d = WEB / "icons"
    d.mkdir(exist_ok=True)
    (d / "apple-touch-icon.png").write_bytes(icon(180))
    (d / "icon-192.png").write_bytes(icon(192))
    (d / "icon-512.png").write_bytes(icon(512))
    (d / "icon-maskable-512.png").write_bytes(icon(512, maskable=True))


def keepawake_video():
    """A 1-second silent video. Looping it muted + playsinline is the classic iOS keep-awake fallback
    for when the Wake Lock API is missing or broken in home-screen apps."""
    out = WEB / "media/keepawake.mp4"
    if out.exists():
        return
    out.parent.mkdir(exist_ok=True)
    ff = shutil.which("ffmpeg")
    if not ff:
        print("  (ffmpeg not found: skipping keep-awake video; Wake Lock API only)")
        return
    subprocess.run([ff, "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1:d=1",
                    "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1", "-shortest",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "8k",
                    "-movflags", "+faststart", str(out)], check=True)


# ---------------------------------------------------------------- manifest + sw

def sha256(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


PREFIX = __import__('os').environ.get('WS_PREFIX', 'ws')  # cache/localStorage namespace


def write_prefix():
    (WEB / "js/prefix.js").write_text(f"// generated by pipeline/assets.py (WS_PREFIX)\nexport const PREFIX = '{PREFIX}';\n")


def manifest():
    skip = {"precache.json", "sw.js"}
    entries = []
    for p in sorted(WEB.rglob("*")):
        rel = p.relative_to(WEB).as_posix()
        if not p.is_file() or any(part.startswith(".") for part in rel.split("/")) or p.name in skip:
            continue
        if rel.startswith("js/sw-template"):
            continue
        group = "shell" if rel.startswith(SHELL_PREFIXES) else "data"
        entries.append({"url": quote(rel, safe="/@!$&'()*+,;=:~"), "size": p.stat().st_size, "sha256": sha256(p), "group": group})
    version = hashlib.sha256("".join(e["url"] + e["sha256"] for e in entries).encode()).hexdigest()[:12]
    basemap = json.loads((WEB / "data/basemap.json").read_text()) if (WEB / "data/basemap.json").exists() else None
    m = {"version": version, "entries": entries,
         "basemap": {k: basemap[k] for k in ("url", "size", "chunkSize", "tag")} if basemap else None}
    (WEB / "precache.json").write_text(json.dumps(m, separators=(",", ":")))
    tpl = (WEB / "js/sw-template.js").read_text()
    (WEB / "sw.js").write_text(tpl.replace("__VERSION__", version).replace("__PREFIX__", PREFIX))

    tot = {}
    for e in entries:
        top = e["url"].split("/")[0] if "/" in e["url"] else "(root)"
        if e["url"].startswith("data/"):
            top = "/".join(e["url"].split("/")[:2])
        tot.setdefault(top, [0, 0])
        tot[top][0] += 1
        tot[top][1] += e["size"]
    print(f"\nprecache.json  version {version}")
    for k, (n, s) in sorted(tot.items(), key=lambda x: -x[1][1]):
        print(f"  {k:22} {n:5} files {s / 1e6:8.2f} MB")
    total = sum(e["size"] for e in entries)
    shell = sum(e["size"] for e in entries if e["group"] == "shell")
    print(f"  {'TOTAL':22} {len(entries):5} files {total / 1e6:8.2f} MB   (shell {shell / 1e6:.1f} MB)")
    return m


if __name__ == "__main__":
    write_prefix()
    vendor()
    icons()
    keepawake_video()
    manifest()
