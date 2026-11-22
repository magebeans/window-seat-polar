"""Extract real QTR720 tracks from adsb.lol's open daily archives (ODbL) into tracks/.

  python pipeline/fetch_adsblol.py 2026-11-18            # one day
  python pipeline/fetch_adsblol.py 2026-11-15 2026-11-18 # several days

Each day is published as a ~3.5-4 GB tar (split into .aa/.ab parts) on GitHub releases of
adsblol/globe_history_<year>. This script STREAMS it — nothing is written to disk except the
matching track — but it still downloads the full size per day. It asks before starting.

Only traces in Qatar Airways' ICAO address block (06a000-06afff) are decompressed; a trace is kept
if any of its records carries the callsign. The SEA->DOH leg is cut out by airport proximity and
written as tracks/adsblol-<date>-<hex>.geojson (LineString + per-point times), which
pipeline/route.py and the in-app importer both read.

NOTE: written against the readsb trace format (trace_full_<hex>.json: {"timestamp": t0,
"trace": [[dt, lat, lon, alt, gs, track, flags, vrate, details|null, ...], ...]}). It has not been
run end to end as part of this repo's build because of the download size.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import re
import sys
import tarfile
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import geo  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
UA = "window-seat-tracks/0.2 (personal offline-map builder)"


class Concat(io.RawIOBase):
    """Read several HTTP responses back to back as one stream (the tar is split into parts)."""
    def __init__(self, urls):
        self.urls = list(urls); self.cur = None; self.read_bytes = 0
    def readable(self):
        return True
    def readinto(self, b):
        while True:
            if self.cur is None:
                if not self.urls:
                    return 0
                self.cur = urllib.request.urlopen(urllib.request.Request(self.urls.pop(0), headers={"User-Agent": UA}), timeout=120)
            n = self.cur.readinto(b)
            if n:
                self.read_bytes += n
                return n
            self.cur.close(); self.cur = None


def release_assets(day: date):
    api = f"https://api.github.com/repos/adsblol/globe_history_{day.year}/releases/tags/v{day:%Y.%m.%d}-planes-readsb-prod-0"
    with urllib.request.urlopen(urllib.request.Request(api, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"}), timeout=60) as r:
        rel = json.load(r)
    assets = sorted(rel["assets"], key=lambda a: a["name"])
    return [(a["browser_download_url"], a["size"]) for a in assets if ".tar" in a["name"]]


def extract_leg(trace, t0, origin, dest):
    pts = []
    for rec in trace:
        dt, lat, lon = rec[0], rec[1], rec[2]
        if lat is None or lon is None:
            continue
        pts.append((lat, lon, t0 + dt))
    # last point near the origin, then first point near the destination after it
    near = lambda p, a, km: geo.haversine_km(p[0], p[1], a["lat"], a["lon"]) < km
    starts = [i for i, p in enumerate(pts) if near(p, origin, 60)]
    if not starts:
        return None
    for s in reversed(starts):
        ends = [j for j in range(s, len(pts)) if near(pts[j], dest, 60)]
        if ends:
            return pts[s:ends[0] + 1]
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", type=date.fromisoformat)
    ap.add_argument("end", type=date.fromisoformat, nargs="?")
    ap.add_argument("--callsign", default="QTR720")
    ap.add_argument("--hex-prefix", default="06a", help="ICAO block to scan (Qatar Airways: 06a)")
    ap.add_argument("--yes", action="store_true", help="don't ask before downloading")
    a = ap.parse_args()
    cfg = json.loads((ROOT / "config/flight.json").read_text())
    days = [a.start + timedelta(d) for d in range(((a.end or a.start) - a.start).days + 1)]

    plan = [(d, release_assets(d)) for d in days]
    total = sum(s for _, assets in plan for _, s in assets)
    for d, assets in plan:
        print(f"  {d}: {sum(s for _, s in assets) / 1e9:.2f} GB in {len(assets)} part(s)")
    print(f"Total download: {total / 1e9:.2f} GB (streamed, not stored)")
    if not a.yes and input("Proceed? [y/N] ").strip().lower() != "y":
        return

    want = a.callsign.encode()
    out_dir = ROOT / "tracks"
    for d, assets in plan:
        stream = Concat([u for u, _ in assets])
        found = 0
        with tarfile.open(fileobj=io.BufferedReader(stream, 1 << 20), mode="r|") as tf:
            for m in tf:
                name = m.name.rsplit("/", 1)[-1]
                mm = re.match(r"trace_full_([0-9a-f]{6})\.json", name)
                if not m.isfile() or not mm or not mm.group(1).startswith(a.hex_prefix):
                    continue
                raw = tf.extractfile(m).read()
                try:
                    data = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
                except Exception:
                    continue
                if want not in json.dumps(data).encode():
                    continue
                leg = extract_leg(data.get("trace", []), data.get("timestamp", 0), cfg["origin"], cfg["destination"])
                if not leg or len(leg) < 50:
                    continue
                path = out_dir / f"adsblol-{d:%Y%m%d}-{mm.group(1)}.geojson"
                path.write_text(json.dumps({"type": "Feature", "properties": {
                    "source": "adsb.lol globe_history (ODbL)", "callsign": a.callsign, "hex": mm.group(1),
                    "times": [p[2] for p in leg]},
                    "geometry": {"type": "LineString", "coordinates": [[round(p[1], 5), round(p[0], 5)] for p in leg]}}))
                found += 1
                print(f"  {d}: {mm.group(1)} -> {path.relative_to(ROOT)} ({len(leg)} points)")
                print(f"     ({stream.read_bytes / 1e9:.2f} GB read so far)")
        if not found:
            print(f"  {d}: no {a.callsign} SEA->DOH leg found")
    print("\nNow re-run: python pipeline/route.py && python pipeline/basemap.py --plan")


if __name__ == "__main__":
    main()
