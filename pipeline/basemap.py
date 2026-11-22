"""Extract the corridor basemap from the latest Protomaps build, merge, and chunk it.

  python pipeline/basemap.py --plan          # dry-run every region, print sizes, download nothing
  python pipeline/basemap.py --plan --fit    # lower zooms (largest region first) until under budget_mb
  python pipeline/basemap.py                 # plan + extract + merge + split into web/data/tiles/

Layers of the archive (later ones only add zooms the earlier ones lack):
  world     whole planet, z0..zoom.world            (context when zoomed out)
  wide      zoom.wide_km-wide corridor, z..zoom.wide  (in case the flight strays)
  regions   corridor strips from build/segments.json, (wide+1)..maxzoom per region
  airports  circles of zoom.airport_radius_km, up to zoom.airport

Per-region maxzoom can be overridden without editing code:
  config/flight.json  ->  "zoom_overrides": {"km 7194-10165": 11}
or on the command line:  --override 5=11   (region index from the --plan table)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import geo  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PMTILES = shutil.which("pmtiles") or str(ROOT / ".cache/bin/go-pmtiles")
BUILD = ROOT / "build/basemap"
OUT_TILES = ROOT / "web/data/tiles"
CHUNK = 4 * 1024 * 1024  # bytes per stored part; also the SW's unit of reading
MB = 1e6
UA = "window-seat-basemap/0.2 (personal offline-map builder)"


def latest_build(spec):
    if spec != "latest":
        return spec if spec.startswith("http") else f"https://build.protomaps.com/{spec}"
    req = urllib.request.Request("https://build-metadata.protomaps.dev/builds.json", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        builds = json.load(r)
    return f"https://build.protomaps.com/{builds[-1]['key']}"


def strip_polygon(seg, i0, i1, half_override=None):
    st, br = seg["stations"], seg["bearings"]
    left = [half_override or seg["left"][i] for i in range(i0, i1 + 1)]
    right = [half_override or seg["right"][i] for i in range(i0, i1 + 1)]
    L = [geo.destination(*st[i], br[i] - 90, left[i - i0]) for i in range(i0, i1 + 1)]
    R = [geo.destination(*st[i], br[i] + 90, right[i - i0]) for i in range(i0, i1 + 1)]
    ring = [[lon, lat] for lat, lon in L] + [[lon, lat] for lat, lon in reversed(R)]
    return polar_safe(ring)


def polar_safe(ring):
    """A strip that passes near the pole wraps in longitude and self-intersects in lon/lat.
    Replace those with a band from the strip's southern edge to the Mercator limit."""
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    jumps = any(abs(a - b) > 90 for a, b in zip(lons, lons[1:]))
    if max(lats) > 84 or jumps:
        s = max(-85, min(lats))
        ring = [[-180, s], [180, s], [180, 85.06], [-180, 85.06]]
    ring = ring + [ring[0]]
    return {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in ring]]}


def circle(lat, lon, km, n=32):
    ring = [list(geo.destination(lat, lon, 360 * i / n, km))[::-1] for i in range(n)]
    return polar_safe(ring)


def plan_jobs(cfg, seg, overrides):
    z = cfg["zoom"]
    n = len(seg["stations"]) - 1
    jobs = [{"name": "world", "label": "whole planet", "minzoom": 0, "maxzoom": z["world"], "region": None}]
    jobs.append({"name": "wide", "label": f"{z['wide_km']} km corridor", "minzoom": z["world"] + 1,
                 "maxzoom": z["wide"], "region": strip_polygon(seg, 0, n, z["wide_km"] / 2)})
    conf_over = cfg.get("zoom_overrides", {})
    for i, r in enumerate(seg["regions"]):
        label = f"km {r['km0']}-{r['km1']}"
        mz = overrides.get(i, conf_over.get(label, r["maxzoom"]))
        jobs.append({"name": f"r{i:02d}", "label": f"{label} {r['class']}", "minzoom": z["wide"] + 1,
                     "maxzoom": mz, "floor": z["wide"] + 1, "region": strip_polygon(seg, r["i0"], r["i1"]), "index": i})
    for ap in (cfg["origin"], cfg["destination"]):
        jobs.append({"name": f"ap-{ap['iata']}", "label": f"{ap['iata']} {z['airport_radius_km']} km",
                     "minzoom": z["wide"] + 1, "maxzoom": z["airport"],
                     "region": circle(ap["lat"], ap["lon"], z["airport_radius_km"])})
    return [j for j in jobs if j["maxzoom"] >= j["minzoom"]]


def run_extract(url, job, out, dry):
    cmd = [PMTILES, "extract", url, str(out), f"--minzoom={job['minzoom']}", f"--maxzoom={job['maxzoom']}",
           "--download-threads=8"]
    if job["region"]:
        rp = BUILD / f"{job['name']}.geojson"
        rp.write_text(json.dumps(job["region"]))
        cmd.append(f"--region={rp}")
    if dry:
        cmd.append("--dry-run")
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"pmtiles extract failed for {job['name']}:\n{p.stderr[-2000:]}")
    log = p.stdout + p.stderr
    m = re.search(r"archive size of ([\d.]+) (\w?B)", log)
    if not m:
        sys.exit(f"could not parse size from pmtiles output:\n{log[-1500:]}")
    mult = {"B": 1, "kB": 1e3, "MB": 1e6, "GB": 1e9}[m.group(2)]
    return float(m.group(1)) * mult


def print_plan(jobs, sizes, budget):
    total = sum(sizes.values())
    print(f"\n  {'#':>3} {'name':8} {'z':>5}  {'MB':>7}  region")
    for j in jobs:
        idx = str(j.get("index", ""))
        print(f"  {idx:>3} {j['name']:8} {j['minzoom']:>2}-{j['maxzoom']:<2}  {sizes[j['name']] / MB:7.1f}  {j['label']}")
    print(f"  {'':3} {'total':8} {'':5}  {total / MB:7.1f}  (budget {budget} MB; overlaps are de-duplicated in the merge)")
    return total


def merge(parts, out):
    """Union of tiles from several archives of the same build. Identical tile ids carry identical bytes,
    so the first archive that has a tile wins. Each archive is read once, sequentially, into memory
    (a few GB at most); per-tile lookups re-read leaf directories and were ~100x slower."""
    from pmtiles.reader import MmapSource, Reader, all_tiles
    from pmtiles.tile import zxy_to_tileid
    from pmtiles.writer import Writer

    tiles, headers, meta = {}, [], None
    for p in parts:
        with open(p, "rb") as fh:
            src = MmapSource(fh)
            rd = Reader(src)
            headers.append(rd.header())
            if meta is None:
                meta = rd.metadata()
            n = 0
            for (z, x, y), data in all_tiles(src):
                tid = zxy_to_tileid(z, x, y)
                if tid not in tiles:
                    tiles[tid] = bytes(data)
                    n += 1
        print(f"    read {Path(p).name}: +{n} tiles", flush=True)
    h0 = headers[0]
    with open(out, "wb") as f:
        w = Writer(f)
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        header = {
            "tile_type": h0["tile_type"], "tile_compression": h0["tile_compression"],
            "min_zoom": min(h["min_zoom"] for h in headers), "max_zoom": max(h["max_zoom"] for h in headers),
            "min_lon_e7": -1800000000, "min_lat_e7": -850511290, "max_lon_e7": 1800000000, "max_lat_e7": 850511290,
            "center_zoom": 3, "center_lon_e7": 0, "center_lat_e7": 0,
        }
        meta = dict(meta or {})
        meta["window-seat"] = "corridor extract; zooms vary by segment"
        w.finalize(header, meta)
    return len(tiles)


def split(archive: Path):
    data_hash = hashlib.sha256()
    with open(archive, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            data_hash.update(block)
    tag = data_hash.hexdigest()[:10]
    if OUT_TILES.exists():
        shutil.rmtree(OUT_TILES)
    dest = OUT_TILES / tag
    dest.mkdir(parents=True)
    parts = []
    with open(archive, "rb") as f:
        i = 0
        while block := f.read(CHUNK):
            name = f"p{i:05d}.bin"
            (dest / name).write_bytes(block)
            parts.append({"url": f"data/tiles/{tag}/{name}", "size": len(block),
                          "sha256": hashlib.sha256(block).hexdigest()})
            i += 1
    size = archive.stat().st_size
    index = {"url": "data/basemap.pmtiles", "size": size, "chunkSize": CHUNK, "tag": tag, "parts": parts}
    (ROOT / "web/data/basemap.json").write_text(json.dumps(index, indent=1))
    return index


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=ROOT / "config/flight.json", type=Path)
    ap.add_argument("--segments", default=ROOT / "build/segments.json", type=Path)
    ap.add_argument("--plan", action="store_true", help="dry-run only: print sizes")
    ap.add_argument("--fit", action="store_true", help="lower region zooms until the total fits budget_mb")
    ap.add_argument("--override", action="append", default=[], help="REGION=MAXZOOM, e.g. 5=11")
    ap.add_argument("--build", help="Protomaps build key or URL (default: config protomaps_build)")
    ap.add_argument("--merge-only", action="store_true", help="reuse the extracts already in build/basemap/")
    a = ap.parse_args()

    cfg = json.loads(a.config.read_text())
    seg = json.loads(a.segments.read_text())
    BUILD.mkdir(parents=True, exist_ok=True)
    url = latest_build(a.build or cfg["protomaps_build"])
    print(f"Protomaps build: {url}")
    overrides = {int(k): int(v) for k, v in (o.split("=") for o in a.override)}
    budget = cfg["budget_mb"]

    jobs = plan_jobs(cfg, seg, overrides)
    sizes = {j["name"]: run_extract(url, j, BUILD / "dry.pmtiles", True) for j in jobs}
    total = print_plan(jobs, sizes, budget)

    if a.fit:
        while total > budget * MB * 0.92:  # leave room for fonts, POIs, app
            cand = [j for j in jobs if "floor" in j and j["maxzoom"] > j["floor"]]
            if not cand:
                print("  ! cannot fit: every region is at its floor zoom")
                break
            j = max(cand, key=lambda j: sizes[j["name"]])
            j["maxzoom"] -= 1
            sizes[j["name"]] = run_extract(url, j, BUILD / "dry.pmtiles", True)
            total = sum(sizes.values())
            print(f"  fit: {j['name']} ({j['label']}) -> z{j['maxzoom']}, total {total / MB:.0f} MB")
        print_plan(jobs, sizes, budget)
        print("\n  To keep these zooms, pass:", " ".join(f"--override {j['index']}={j['maxzoom']}" for j in jobs if "index" in j))

    (BUILD / "plan.json").write_text(json.dumps({"build": url, "jobs": [{k: v for k, v in j.items() if k != "region"} | {"bytes": sizes[j["name"]]} for j in jobs]}, indent=1))
    if a.plan:
        return

    parts = []
    for j in jobs:
        out = BUILD / f"{j['name']}.pmtiles"
        if not a.merge_only:
            print(f"  extracting {j['name']:8} z{j['minzoom']}-{j['maxzoom']} ~{sizes[j['name']] / MB:.0f} MB ...", flush=True)
            run_extract(url, j, out, False)
        parts.append(out)
    merged = BUILD / "basemap.pmtiles"
    n = merge(parts, merged)
    idx = split(merged)
    print(f"\n  merged {n} tiles -> {merged.stat().st_size / MB:.1f} MB, {len(idx['parts'])} parts of {CHUNK >> 20} MiB in web/data/tiles/{idx['tag']}/")


if __name__ == "__main__":
    main()
