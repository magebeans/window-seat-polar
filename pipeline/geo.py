"""Spherical geometry, solar position and land lookup shared by the pipeline scripts.

Pure Python on purpose: no shapely/GDAL, so the pipeline runs anywhere with `uv`.
The JS side (web/js/geo.js) implements the same formulas; keep them in step.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

R_KM = 6371.0088


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_KM * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(lat, lon, brg, dist_km):
    d = dist_km / R_KM
    b = math.radians(brg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


def gc_interpolate(lat1, lon1, lat2, lon2, f):
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = haversine_km(lat1, lon1, lat2, lon2) / R_KM
    if d == 0:
        return lat1, lon1
    a = math.sin((1 - f) * d) / math.sin(d)
    b = math.sin(f * d) / math.sin(d)
    x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
    y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
    z = a * math.sin(p1) + b * math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def great_circle(lat1, lon1, lat2, lon2, step_km=25):
    n = max(2, int(haversine_km(lat1, lon1, lat2, lon2) / step_km) + 1)
    return [gc_interpolate(lat1, lon1, lat2, lon2, i / (n - 1)) for i in range(n)]


def cross_track_km(lat, lon, lat1, lon1, brg):
    """Signed distance from (lat,lon) to the great circle through (lat1,lon1) on bearing brg.
    Positive = right of track."""
    d13 = haversine_km(lat1, lon1, lat, lon) / R_KM
    t13 = math.radians(bearing_deg(lat1, lon1, lat, lon))
    return math.asin(math.sin(d13) * math.sin(t13 - math.radians(brg))) * R_KM


def cumulative_km(pts):
    out = [0.0]
    for (a, b), (c, d) in zip(pts, pts[1:]):
        out.append(out[-1] + haversine_km(a, b, c, d))
    return out


def point_at_km(pts, cum, km):
    """Position and bearing at distance km along polyline pts."""
    km = max(0.0, min(cum[-1], km))
    lo, hi = 0, len(cum) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if cum[mid] <= km:
            lo = mid
        else:
            hi = mid
    seg = cum[hi] - cum[lo]
    f = 0 if seg == 0 else (km - cum[lo]) / seg
    (a, b), (c, d) = pts[lo], pts[hi]
    lat, lon = gc_interpolate(a, b, c, d, f)
    return lat, lon, bearing_deg(a, b, c, d)


def resample(pts, step_km):
    cum = cumulative_km(pts)
    n = max(2, int(cum[-1] / step_km) + 1)
    return [point_at_km(pts, cum, cum[-1] * i / (n - 1))[:2] for i in range(n)]


# ---------------------------------------------------------------- sun

def subsolar_point(dt: datetime):
    """(lat, lon) of the subsolar point. NOAA low-precision formulas, ~0.1 deg."""
    dt = dt.astimezone(timezone.utc)
    jd = dt.timestamp() / 86400.0 + 2440587.5
    n = jd - 2451545.0
    L = (280.460 + 0.9856474 * n) % 360
    g = math.radians((357.528 + 0.9856003 * n) % 360)
    lam = math.radians(L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.0000004 * n)
    dec = math.asin(math.sin(eps) * math.sin(lam))
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    gmst = (280.46061837 + 360.98564736629 * n) % 360
    lon = (math.degrees(ra) - gmst + 540) % 360 - 180
    return math.degrees(dec), lon


def sun_elevation(lat, lon, dt: datetime):
    slat, slon = subsolar_point(dt)
    ang = haversine_km(lat, lon, slat, slon) / R_KM
    return 90 - math.degrees(ang)


def light_class(elev):
    """day / twilight / night as seen on the ground below you."""
    if elev > 0:
        return "day"
    if elev > -6:
        return "twilight"
    return "night"


# ---------------------------------------------------------------- land / countries

class Countries:
    """Point-in-polygon against Natural Earth 1:50m countries (bbox-prefiltered)."""

    def __init__(self, path: Path):
        data = json.loads(Path(path).read_text())
        self.items = []
        for f in data["features"]:
            g = f["geometry"]
            polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
            name = f["properties"].get("NAME_EN") or f["properties"].get("NAME")
            for poly in polys:
                ring = poly[0]
                xs = [p[0] for p in ring]
                ys = [p[1] for p in ring]
                self.items.append((min(xs), min(ys), max(xs), max(ys), poly, name))

    @staticmethod
    def _in_ring(x, y, ring):
        inside = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        return inside

    def country_at(self, lat, lon):
        for x0, y0, x1, y1, poly, name in self.items:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and self._in_ring(lon, lat, poly[0]):
                if not any(self._in_ring(lon, lat, hole) for hole in poly[1:]):
                    return name
        return None
