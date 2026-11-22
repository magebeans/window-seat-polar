"""Build the planned route, corridor, schedule and per-segment zoom plan.

Inputs : config/flight.json, tracks/* (optional: .kml .csv .gpx .geojson .json)
Outputs: web/data/route.json      (route line + times + corridor + countries; used by the app)
         build/segments.json      (corridor split into zoom regions; used by basemap.py)

With no track files the route is the great circle, and route.json says so.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import geo  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
STATION_KM = 10


# ---------------------------------------------------------------- track parsing

def _ts(s):
    if s is None or s == "":
        return None
    s = str(s).strip()
    if re.fullmatch(r"\d{9,11}(\.\d+)?", s):
        return float(s)
    if re.fullmatch(r"\d{12,14}", s):  # ms
        return float(s) / 1000
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_kml(text):
    # gx:Track (FlightAware): <when> list then <gx:coord> list
    whens = re.findall(r"<when>([^<]+)</when>", text)
    coords = re.findall(r"<gx:coord>([^<]+)</gx:coord>", text)
    if len(coords) >= 10:
        pts = []
        for i, c in enumerate(coords):
            lon, lat, *alt = map(float, c.split())
            pts.append((lat, lon, _ts(whens[i]) if len(whens) == len(coords) else None))
        return pts
    # FR24: one Placemark per fix, each with TimeStamp + Point
    marks = re.findall(r"<Placemark>(.*?)</Placemark>", text, re.S)
    pts = []
    for m in marks:
        w = re.search(r"<when>([^<]+)</when>", m)
        c = re.search(r"<Point>.*?<coordinates>\s*([^<]+?)\s*</coordinates>", m, re.S)
        if c:
            lon, lat, *_ = map(float, c.group(1).split(","))
            pts.append((lat, lon, _ts(w.group(1)) if w else None))
    if len(pts) >= 10:
        return sorted(pts, key=lambda p: p[2] or 0) if all(p[2] for p in pts) else pts
    # Fallback: longest LineString
    best = []
    for block in re.findall(r"<LineString>.*?<coordinates>(.*?)</coordinates>", text, re.S):
        cs = [tuple(map(float, t.split(",")[:2])) for t in block.split()]
        if len(cs) > len(best):
            best = cs
    return [(lat, lon, None) for lon, lat in best]


def parse_csv(text):
    rows = list(csv.DictReader(text.splitlines()))
    if not rows:
        return []
    keys = {k.lower().strip(): k for k in rows[0].keys() if k}
    pts = []
    for r in rows:
        if "position" in keys:  # FR24: Position = "lat,lon"
            lat, lon = map(float, r[keys["position"]].split(","))
        else:
            lat = float(r[keys.get("lat") or keys.get("latitude")])
            lon = float(r[keys.get("lon") or keys.get("lng") or keys.get("longitude")])
        t = None
        for k in ("timestamp", "time", "utc", "when"):
            if k in keys and t is None:
                t = _ts(r[keys[k]])
        pts.append((lat, lon, t))
    return pts


def parse_gpx(text):
    pts = []
    for m in re.finditer(r"<trkpt[^>]*lat=\"([-\d.]+)\"[^>]*lon=\"([-\d.]+)\"[^>]*>(.*?)</trkpt>", text, re.S):
        t = re.search(r"<time>([^<]+)</time>", m.group(3))
        pts.append((float(m.group(1)), float(m.group(2)), _ts(t.group(1)) if t else None))
    return pts


def parse_geojson(text):
    data = json.loads(text)
    feats = data["features"] if data.get("type") == "FeatureCollection" else [data]
    pts = []
    for f in feats:
        g = f.get("geometry") or f
        props = f.get("properties") or {}
        if g["type"] == "LineString":
            times = props.get("times") or props.get("coordTimes") or []
            for i, c in enumerate(g["coordinates"]):
                pts.append((c[1], c[0], _ts(times[i]) if i < len(times) else None))
        elif g["type"] == "MultiLineString":
            for line in g["coordinates"]:
                pts += [(c[1], c[0], None) for c in line]
        elif g["type"] == "Point":
            c = g["coordinates"]
            pts.append((c[1], c[0], _ts(props.get("time") or props.get("timestamp"))))
    return pts


def load_track(path: Path):
    text = path.read_text(errors="replace")
    ext = path.suffix.lower()
    pts = {".kml": parse_kml, ".csv": parse_csv, ".gpx": parse_gpx}.get(ext, parse_geojson)(text)
    # drop duplicate consecutive fixes and wild jumps (> 1500 km/h implied)
    out = []
    for p in pts:
        if out and geo.haversine_km(out[-1][0], out[-1][1], p[0], p[1]) < 0.5:
            continue
        if out and p[2] and out[-1][2] and p[2] > out[-1][2]:
            v = geo.haversine_km(out[-1][0], out[-1][1], p[0], p[1]) / ((p[2] - out[-1][2]) / 3600)
            if v > 1500:
                continue
        out.append(p)
    return out


# ---------------------------------------------------------------- route + schedule

def synthetic_profile(n_stations, total_km, cfg, airborne_min):
    """Fraction-of-airborne-time at each station for a climb/cruise/descent speed profile."""
    climb, desc = cfg["climb_minutes"], cfg["descent_minutes"]
    v_climb, v_desc = 0.55, 0.6  # fraction of cruise speed averaged over climb / descent
    cruise_min = airborne_min - climb - desc
    v = total_km / (climb * v_climb + cruise_min + desc * v_desc)  # km per minute at cruise
    d_climb, d_desc = climb * v_climb * v, desc * v_desc * v
    fr = []
    for i in range(n_stations):
        km = total_km * i / (n_stations - 1)
        if km <= d_climb:
            t = km / (v * v_climb)
        elif km >= total_km - d_desc:
            t = airborne_min - (total_km - km) / (v * v_desc)
        else:
            t = climb + (km - d_climb) / v
        fr.append(t / airborne_min)
    return fr, v * 60


def build(cfg, track_files, out_route, out_segments, countries_path):
    o, d = cfg["origin"], cfg["destination"]
    tracks = []
    for f in track_files:
        pts = load_track(f)
        if len(pts) < 10:
            print(f"  ! {f.name}: only {len(pts)} usable points, ignored")
            continue
        # anchor the ends at the airports if the track starts/ends mid-air
        if geo.haversine_km(pts[0][0], pts[0][1], o["lat"], o["lon"]) > 5:
            pts.insert(0, (o["lat"], o["lon"], None))
        if geo.haversine_km(pts[-1][0], pts[-1][1], d["lat"], d["lon"]) > 5:
            pts.append((d["lat"], d["lon"], None))
        km = geo.cumulative_km([p[:2] for p in pts])[-1]
        tracks.append({"file": f.name, "pts": pts, "km": km})
        print(f"  track {f.name}: {len(pts)} fixes, {km:.0f} km, timestamps={'yes' if sum(1 for p in pts if p[2]) > len(pts) / 2 else 'no'}")

    if tracks:
        med = statistics.median_low([t["km"] for t in tracks])
        primary = next(t for t in tracks if t["km"] == med)
        source = f"tracks: {', '.join(t['file'] for t in tracks)} (route line = {primary['file']})"
        raw = primary["pts"]
    else:
        primary = None
        source = "great-circle (no track files in tracks/)"
        raw = [(lat, lon, None) for lat, lon in geo.great_circle(o["lat"], o["lon"], d["lat"], d["lon"])]

    stations = geo.resample([p[:2] for p in raw], STATION_KM)
    cum = geo.cumulative_km(stations)
    total_km = cum[-1]

    dep = datetime.fromisoformat(cfg["departure"])
    wheels_up = dep + timedelta(minutes=cfg["taxi_out_minutes"])
    airborne_min = cfg["block_minutes"] - cfg["taxi_out_minutes"] - cfg["taxi_in_minutes"]

    timed = [p for p in raw if p[2]]
    if primary and len(timed) > len(raw) / 2:
        # time profile from the real track, rescaled to the scheduled airborne time
        rc = geo.cumulative_km([p[:2] for p in timed])
        t0, t1 = timed[0][2], timed[-1][2]
        fr = []
        for km in cum:
            k = km / total_km * rc[-1]
            j = max(1, next((i for i, c in enumerate(rc) if c >= k), len(rc) - 1))
            seg = rc[j] - rc[j - 1] or 1
            t = timed[j - 1][2] + (timed[j][2] - timed[j - 1][2]) * (k - rc[j - 1]) / seg
            fr.append((t - t0) / (t1 - t0))
        cruise_kmh = None
        profile = "from track timestamps"
    else:
        fr, cruise_kmh = synthetic_profile(len(stations), total_km, cfg, airborne_min)
        profile = f"synthetic: climb {cfg['climb_minutes']} min, descent {cfg['descent_minutes']} min, cruise {cruise_kmh:.0f} km/h"

    t_min = [cfg["taxi_out_minutes"] + f * airborne_min for f in fr]  # minutes after scheduled departure

    # ---- corridor: base half-width, widened to contain every other track
    half = cfg["corridor_km"] / 2
    cap = cfg["max_corridor_km"] / 2
    bearings = [geo.bearing_deg(*stations[i], *stations[min(i + 1, len(stations) - 1)]) if i < len(stations) - 1
                else geo.bearing_deg(*stations[i - 1], *stations[i]) for i in range(len(stations))]
    left = [half] * len(stations)
    right = [half] * len(stations)
    for t in tracks:
        if t is primary:
            continue
        for lat, lon in geo.resample([p[:2] for p in t["pts"]], 25):
            i = min(range(len(stations)), key=lambda k: geo.haversine_km(*stations[k], lat, lon))
            xt = geo.cross_track_km(lat, lon, *stations[i], bearings[i])
            need = min(cap, abs(xt) + half / 2)
            if xt > 0:
                right[i] = max(right[i], need)
            else:
                left[i] = max(left[i], need)
    # spread widening to neighbours so the outline has no notches (±100 km)
    w = int(100 / STATION_KM)
    left = [max(left[max(0, i - w):i + w + 1]) for i in range(len(left))]
    right = [max(right[max(0, i - w):i + w + 1]) for i in range(len(right))]

    L = [geo.destination(*stations[i], bearings[i] - 90, left[i]) for i in range(len(stations))]
    Rr = [geo.destination(*stations[i], bearings[i] + 90, right[i]) for i in range(len(stations))]

    def strip(i0, i1):
        ring = [(lon, lat) for lat, lon in L[i0:i1 + 1]] + [(lon, lat) for lat, lon in reversed(Rr[i0:i1 + 1])]
        ring.append(ring[0])
        return [[round(x, 5), round(y, 5)] for x, y in ring]

    corridor = strip(0, len(stations) - 1)

    # ---- countries along the route
    countries = geo.Countries(countries_path)
    runs = []
    for i in range(0, len(stations), 2):
        name = countries.country_at(*stations[i]) or "open water"
        if not runs or runs[-1][1] != name:
            runs.append([round(cum[i]), name])

    # ---- zoom segments
    z = cfg["zoom"]
    seg_n = max(1, round(total_km / cfg["segment_km"]))
    segs = []
    for s in range(seg_n):
        i0 = round(s * (len(stations) - 1) / seg_n)
        i1 = round((s + 1) * (len(stations) - 1) / seg_n)
        elevs = []
        for i in (i0, (i0 + i1) // 2, i1):
            when = dep + timedelta(minutes=t_min[i])
            elevs.append(geo.sun_elevation(*stations[i], when))
        light = geo.light_class(max(elevs))
        # land fraction from a grid across the strip
        samples = land = 0
        for i in range(i0, i1 + 1, max(1, (i1 - i0) // 5)):
            for f in (-1, -0.5, 0, 0.5, 1):
                off = f * (right[i] if f > 0 else left[i])
                lat, lon = geo.destination(*stations[i], bearings[i] + 90, off)
                samples += 1
                land += countries.country_at(lat, lon) is not None
        water = 1 - land / samples
        is_water = water >= z["water_threshold"]
        key = ("day" if light == "day" else "twilight" if light == "twilight" else "night") + ("_water" if is_water else "_land")
        maxzoom = {
            "day_land": z["day_land"], "twilight_land": z["twilight_land"], "night_land": z["night_land"],
            "day_water": z["day_water"], "twilight_water": z["day_water"], "night_water": z["night_water"],
        }[key]
        segs.append({"i0": i0, "i1": i1, "km0": round(cum[i0]), "km1": round(cum[i1]),
                     "t0": round(t_min[i0]), "t1": round(t_min[i1]),
                     "sun_max": round(max(elevs), 1), "light": light,
                     "water": round(water, 2), "class": key, "maxzoom": maxzoom,
                     "country": countries.country_at(*stations[(i0 + i1) // 2]) or "open water"})

    # merge neighbours with the same maxzoom into regions (one pmtiles extract each)
    regions = []
    for s in segs:
        if regions and regions[-1]["maxzoom"] == s["maxzoom"]:
            r = regions[-1]
            r["i1"], r["km1"], r["t1"] = s["i1"], s["km1"], s["t1"]
            r["segments"].append(s)
        else:
            regions.append({**{k: s[k] for k in ("i0", "i1", "km0", "km1", "t0", "t1", "maxzoom", "class")}, "segments": [s]})
    for r in regions:
        r["polygon"] = {"type": "Polygon", "coordinates": [strip(r["i0"], r["i1"])]}

    route = {
        "version": 1,
        "flight": cfg["flight"],
        "departure": dep.isoformat(),
        "wheelsUp": wheels_up.isoformat(),
        "landing": (wheels_up + timedelta(minutes=airborne_min)).isoformat(),
        "arrival": (dep + timedelta(minutes=cfg["block_minutes"])).isoformat(),
        "origin": o, "destination": d,
        "source": source,
        "timeProfile": profile,
        "totalKm": round(total_km),
        "points": [[round(lat, 4), round(lon, 4), round(t, 1)] for (lat, lon), t in zip(stations, t_min)],
        "corridor": corridor,
        "countries": runs,
        "segments": [{k: s[k] for k in ("km0", "km1", "t0", "t1", "light", "class", "maxzoom", "country")} for s in segs],
    }
    out_route.parent.mkdir(parents=True, exist_ok=True)
    out_route.write_text(json.dumps(route, separators=(",", ":")))
    out_segments.parent.mkdir(parents=True, exist_ok=True)
    out_segments.write_text(json.dumps({"stations": stations, "left": left, "right": right,
                                        "bearings": bearings, "regions": regions}, indent=1))

    print(f"\nRoute: {source}")
    print(f"  {total_km:.0f} km, {profile}")
    print(f"  departure {dep.isoformat()}  wheels-up {wheels_up.strftime('%H:%M')}  landing {(wheels_up + timedelta(minutes=airborne_min)).astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M')}Z")
    print(f"\n  {'km':>11}  {'t+min':>9}  {'light':9} {'water':>5}  z  over")
    for s in segs:
        print(f"  {s['km0']:5}-{s['km1']:<5}  {s['t0']:4}-{s['t1']:<4}  {s['light']:9} {s['water']:5.2f}  {s['maxzoom']:2} {s['country']}")
    print(f"\n  {len(regions)} zoom regions -> {out_segments}")
    return route


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=ROOT / "config/flight.json", type=Path)
    ap.add_argument("--tracks", default=ROOT / "tracks", type=Path)
    ap.add_argument("--out", default=ROOT / "web/data/route.json", type=Path)
    ap.add_argument("--segments", default=ROOT / "build/segments.json", type=Path)
    ap.add_argument("--countries", default=ROOT / ".cache/ne/countries50.geojson", type=Path)
    a = ap.parse_args()
    cfg = json.loads(a.config.read_text())
    files = sorted(p for p in a.tracks.glob("*") if p.suffix.lower() in (".kml", ".csv", ".gpx", ".geojson", ".json"))
    build(cfg, files, a.out, a.segments, a.countries)


if __name__ == "__main__":
    main()
