"""Notable geotagged Wikipedia articles inside the corridor, with first-paragraph summaries.

  1. Wikidata SPARQL (wikibase:box) for items with coordinates + an English article, in boxes
     along the route. Sitelink count is a coarse first filter (config pois.min_sitelinks).
  2. Classify by the item's P31 class labels into city / peak / lake / river / glacier /
     island / coast / region; everything else (buildings, people, events, ...) is dropped.
  3. Rank by English Wikipedia page views over the last 60 days (or article length, if page views
     are throttled or pois.rank_by = "length"), nudged toward natural
     landmarks and toward the track, and keep the top pois.per_100km per 100 km of route.
  4. Fetch intro extracts (plain text, no images) and write chunks along the route:
       web/data/pois/index.json, web/data/pois/<hash>.json

Responses are cached in .cache/wiki/ so re-runs are cheap.  Inputs: web/data/route.json.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import geo  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache/wiki"
# Wikimedia asks API clients to identify themselves. Set WS_USER_AGENT to something with your own
# contact (e.g. "window-seat/0.2 (you@example.com)") if you get HTTP 429s; the default carries none.
UA = os.environ.get("WS_USER_AGENT", "window-seat-pois/0.2 (personal offline-map builder; sequential, ~1 req/s, cached)")
OUT = ROOT / "web/data/pois"

TYPES = [  # (type, keywords in a P31 class label), first match wins
    ("glacier", ["glacier", "ice cap", "ice field", "icefield", "ice sheet", "ice shelf"]),
    ("peak", ["mountain", "volcano", "peak", "summit", "massif", "hill", "mountain range", "ridge", "inselberg"]),
    ("lake", ["lake", "reservoir", "lagoon"]),
    ("river", ["river", "tributary"]),
    ("island", ["island", "archipelago", "islet", "atoll"]),
    ("coast", ["bay", "fjord", "fiord", "strait", "gulf", "cape", "peninsula", "sea", "inlet", "sound",
               "headland", "estuary", "spit", "firth", "delta"]),
    ("region", ["desert", "plateau", "steppe", "national park", "valley", "canyon", "depression", "salt flat",
                "salt pan", "plain", "wetland", "nature reserve", "lowland"]),
    ("city", ["city", "town", "capital", "metropolis", "urban-type settlement", "municipality",
              "administrative centre", "megacity", "big city", "oasis", "human settlement", "village"]),
]
EXCLUDE = re.compile(r"district|neighbo|borough|quarter|ward\b|suburb|station|airport|building|railway|road|"
                     r"street|tunnel|bridge|resort|hotel|church|mosque|school|universit|museum|stadium|"
                     r"company|club|team|battle|siege|event|mine\b|oil field|gas field|dam\b|power|historic|"
                     r"archaeological|former|ghost town|shipwreck|military|base\b|ship|lighthouse|cemetery|"
                     r"electoral|constituency|parish|hamlet|locality|village of|census|season|championship|league|"
                     r"tournament|division|election|competition|festival|sport", re.I)
TYPE_BONUS = {"peak": 0.9, "glacier": 1.0, "lake": 0.8, "island": 0.8, "coast": 0.6, "region": 0.5,
              "river": 0.4, "city": 0.0}


def http_json(url, data=None, cache_key=None, retries=5):
    path = None
    if cache_key:
        path = CACHE / (hashlib.sha1(cache_key.encode()).hexdigest() + ".json")
        if path.exists():
            return json.loads(path.read_text())
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = json.load(r)
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(out))
            return out
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = int(e.headers.get("Retry-After") or 0) or 20 * (attempt + 1)
                print(f"    HTTP {e.code}, waiting {wait}s")
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise


SPARQL = """
SELECT ?item ?article ?coord ?sl (MAX(?pop) AS ?population) (MAX(?ele) AS ?elevation)
       (GROUP_CONCAT(DISTINCT ?classLabel; separator="|") AS ?classes) WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(%(w)f %(s)f)"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(%(e)f %(n)f)"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= %(min_sl)d)
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL { ?item wdt:P31 ?class . ?class rdfs:label ?classLabel . FILTER(lang(?classLabel) = "en") }
  OPTIONAL { ?item wdt:P1082 ?pop . }
  OPTIONAL { ?item wdt:P2044 ?ele . }
} GROUP BY ?item ?article ?coord ?sl
"""


def sparql_box(w, s, e, n, min_sl, depth=0):
    q = SPARQL % {"w": w, "s": s, "e": e, "n": n, "min_sl": min_sl}
    try:
        res = http_json("https://query.wikidata.org/sparql?format=json",
                        data=urllib.parse.urlencode({"query": q}).encode(), cache_key=q,
                        retries=1 if depth < 3 else 3)  # a timeout means "too dense": split instead of retrying
        return res["results"]["bindings"]
    except Exception as ex:  # timeouts on dense boxes: split in four
        if depth >= 3:
            print(f"    ! box {w:.1f},{s:.1f},{e:.1f},{n:.1f} failed: {ex}")
            return []
        mx, my = (w + e) / 2, (s + n) / 2
        out = []
        for box in ((w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)):
            out += sparql_box(*box, min_sl, depth + 1)
        return out


def classify(classes):
    labels = [c.strip().lower() for c in classes.split("|") if c.strip()]
    for t, kws in TYPES:
        for lab in labels:
            if EXCLUDE.search(lab):
                continue
            if any(re.search(r"\b" + re.escape(k) + r"s?\b", lab) for k in kws):
                return t
    return None


_last = [0.0]


def wiki_query(params, retries=5):
    base = {"format": "json", "formatversion": "2", "action": "query", "redirects": "1", "maxlag": "5"}
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({**base, **params})
    if not (CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".json")).exists():
        time.sleep(max(0.0, 1.0 - (time.time() - _last[0])))  # ~1 request/s, sequential
        _last[0] = time.time()
    return http_json(url, cache_key=url, retries=retries)


def clean_summary(text, limit):
    # the lead section (all intro paragraphs), up to `limit` characters
    paras = [p.strip() for p in text.split("\n") if len(p.strip()) > 40]
    para = "\n\n".join(paras) if paras else text.strip()
    # drop the pronunciation/etymology parenthetical in the first sentence: "X (/ˈfoʊ/; Russian: ...) is"
    m = re.match(r"^([^(]{0,120}?)\s*\(([^()]|\([^()]*\))*\)", para)
    if m and re.search(r"[;/ˈ]|listen|pronounced|romani[sz]ed", m.group(0)):
        para = m.group(1) + para[m.end():]
    para = re.sub(r"[ \t]{2,}", " ", para)
    if len(para) > limit:
        cut = para[:limit]
        end = max(cut.rfind(". "), cut.rfind("; "))
        para = cut[:end + 1] if end > limit * 0.5 else cut.rsplit(" ", 1)[0] + "…"
    return para


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=ROOT / "config/flight.json", type=Path)
    ap.add_argument("--route", default=ROOT / "web/data/route.json", type=Path)
    a = ap.parse_args()
    cfg = json.loads(a.config.read_text())
    pc = cfg["pois"]
    route = json.loads(a.route.read_text())
    pts = [(p[0], p[1]) for p in route["points"]]
    cum = geo.cumulative_km(pts)
    total = cum[-1]
    half = cfg["corridor_km"] / 2 + 25
    brgs = [geo.bearing_deg(*pts[i], *pts[min(i + 1, len(pts) - 1)]) if i < len(pts) - 1
            else geo.bearing_deg(*pts[i - 1], *pts[i]) for i in range(len(pts))]

    # ---- 1. candidate items, box by box along the route
    print(f"Querying Wikidata along {total:.0f} km ...")
    items = {}
    step = 250
    k = 0.0
    while k < total:
        ia = next(i for i, c in enumerate(cum) if c >= k)
        ib = next((i for i, c in enumerate(cum) if c >= k + step), len(cum) - 1)
        corners = []
        for i in range(ia, ib + 1, max(1, (ib - ia) // 4)):
            for side in (-90, 90):
                corners.append(geo.destination(*pts[i], brgs[i] + side, half))
            corners.append(pts[i])
        lats = [c[0] for c in corners]
        lons = [c[1] for c in corners]
        s, n = max(-89.9, min(lats)), min(89.9, max(lats))
        w, e = min(lons), max(lons)
        if e - w > 180 or n > 82:  # near the pole: full band
            w, e = -180, 180
        rows = sparql_box(w, s, e, n, pc["min_sitelinks"])
        for r in rows:
            qid = r["item"]["value"].rsplit("/", 1)[1]
            if qid in items:
                continue
            m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", r["coord"]["value"])
            if not m:
                continue
            lon, lat = float(m.group(1)), float(m.group(2))
            items[qid] = {
                "qid": qid, "lat": lat, "lon": lon, "sl": int(r["sl"]["value"]),
                "title": urllib.parse.unquote(r["article"]["value"].rsplit("/wiki/", 1)[1]).replace("_", " "),
                "classes": r.get("classes", {}).get("value", ""),
                "pop": float(r["population"]["value"]) if "population" in r else None,
                "ele": float(r["elevation"]["value"]) if "elevation" in r else None,
            }
        print(f"  km {k:6.0f}  box {w:7.1f},{s:5.1f} .. {e:7.1f},{n:5.1f}  {len(rows):5} rows  ({len(items)} items)")
        k += step
        time.sleep(0.5)

    # ---- 2. classify + place along the route
    kept = []
    for it in items.values():
        t = classify(it["classes"])
        if not t:
            continue
        i = min(range(0, len(pts), 3), key=lambda j: geo.haversine_km(pts[j][0], pts[j][1], it["lat"], it["lon"]))
        i = min(range(max(0, i - 3), min(len(pts), i + 4)), key=lambda j: geo.haversine_km(pts[j][0], pts[j][1], it["lat"], it["lon"]))
        xt = geo.cross_track_km(it["lat"], it["lon"], *pts[i], brgs[i])
        if abs(xt) > half:
            continue
        it.update(type=t, km=cum[i], xt=xt)
        kept.append(it)
    print(f"\n{len(items)} items, {len(kept)} classified inside the corridor")
    # page views cost one API call per 50 titles: pre-select by sitelinks, generously
    pre = {}
    for it in kept:
        pre.setdefault(int(it["km"] // 100), []).append(it)
    kept = [it for lst in pre.values() for it in sorted(lst, key=lambda x: -x["sl"])[:pc["per_100km"] * 4]]
    print(f"{len(kept)} candidates after sitelink pre-selection")

    # ---- 3. notability: page views (60 days), or article length if page views are throttled
    titles = sorted({it["title"] for it in kept})

    def resolve(res, acc_r, acc_n):
        acc_r.update({r["from"]: r["to"] for r in res["query"].get("redirects", [])})
        acc_n.update({r["from"]: r["to"] for r in res["query"].get("normalized", [])})

    def metric_views():
        out = {}
        for b in range(0, len(titles), 50):
            batch = titles[b:b + 50]
            redirect, normal, byname, cont = {}, {}, {}, {}
            while True:  # prop=pageviews paginates: follow `continue`
                res = wiki_query({"prop": "pageviews", "pvipdays": "60", "titles": "|".join(batch), **cont}, retries=2)
                resolve(res, redirect, normal)
                for pg in res["query"]["pages"]:
                    if pg.get("pageviews"):
                        byname[pg["title"]] = sum(v or 0 for v in pg["pageviews"].values())
                if "continue" not in res:
                    break
                cont = dict(res["continue"])
            for t in batch:
                out[t] = byname.get(redirect.get(normal.get(t, t), normal.get(t, t)), 0)
            if b // 50 % 10 == 0:
                print(f"  views {b + len(batch)}/{len(titles)}")
        return out

    def metric_length():
        out = {}
        for b in range(0, len(titles), 50):
            batch = titles[b:b + 50]
            redirect, normal = {}, {}
            res = wiki_query({"prop": "info", "titles": "|".join(batch)})
            resolve(res, redirect, normal)
            byname = {pg["title"]: pg.get("length", 0) for pg in res["query"]["pages"]}
            for t in batch:
                out[t] = byname.get(redirect.get(normal.get(t, t), normal.get(t, t)), 0)
        return out

    rank_by = pc.get("rank_by", "pageviews")
    if rank_by == "pageviews":
        print("Fetching page views ...")
        try:
            metric = metric_views()
        except urllib.error.HTTPError as e:
            print(f"  ! page views throttled ({e.code}); ranking by article length instead."
                  " Set WS_USER_AGENT with your contact to get page views.")
            rank_by = "length"
    if rank_by == "length":
        print("Fetching article lengths ...")
        metric = metric_length()
    # put both metrics on one scale: ~1 page view/day ~ a 3 kB article
    floor = pc["min_views"] if rank_by == "pageviews" else pc["min_length"]
    for it in kept:
        m = metric.get(it["title"], 0)
        it["views"] = m if rank_by == "pageviews" else None
        it["metric"] = m
        base = math.log10(m + 10) if rank_by == "pageviews" else 1.6 * math.log10(m / 50 + 10)
        it["score"] = base + TYPE_BONUS[it["type"]] - 0.6 * abs(it["xt"]) / half
    print(f"  ranked by {rank_by}")

    # ---- keep the best per 100 km bin
    bins = {}
    for it in kept:
        bins.setdefault(int(it["km"] // 100), []).append(it)
    final = []
    for b, lst in bins.items():
        lst = [x for x in lst if x["metric"] >= floor]
        lst.sort(key=lambda x: -x["score"])
        final += lst[:pc["per_100km"]]
    final.sort(key=lambda x: -x["score"])
    final = final[:pc["max_total"]]
    final.sort(key=lambda x: x["km"])
    print(f"Keeping {len(final)} POIs")
    by_type = {}
    for it in final:
        by_type[it["type"]] = by_type.get(it["type"], 0) + 1
    print("  " + ", ".join(f"{t}: {n}" for t, n in sorted(by_type.items(), key=lambda x: -x[1])))

    # ---- 4. summaries
    print("Fetching summaries ...")
    summ = {}
    ft = [it["title"] for it in final]
    for b in range(0, len(ft), 20):
        batch = ft[b:b + 20]
        res = wiki_query({"prop": "extracts", "exintro": "1", "explaintext": "1", "exlimit": "20",
                          "titles": "|".join(batch)})
        redirect = {r["from"]: r["to"] for r in res["query"].get("redirects", [])}
        normal = {r["from"]: r["to"] for r in res["query"].get("normalized", [])}
        byname = {p["title"]: p.get("extract", "") for p in res["query"]["pages"]}
        for t in batch:
            tt = redirect.get(normal.get(t, t), normal.get(t, t))
            summ[t] = clean_summary(byname.get(tt, ""), pc["summary_chars"])
        if b // 20 % 25 == 0:
            print(f"  {b + len(batch)}/{len(ft)}")

    # ---- write chunks
    if OUT.exists():
        for f in OUT.glob("*.json"):
            f.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    chunks = []
    ck = pc["chunk_km"]
    for c in range(int(total // ck) + 1):
        lst = [it for it in final if c * ck <= it["km"] < (c + 1) * ck]
        if not lst:
            continue
        rows = [{
            "id": it["qid"], "n": it["title"], "lat": round(it["lat"], 4), "lon": round(it["lon"], 4),
            "t": it["type"], "km": round(it["km"]), "r": round(it["score"], 2), **({"v": it["views"]} if it["views"] is not None else {}),
            **({"pop": int(it["pop"])} if it["pop"] and it["type"] == "city" else {}),
            **({"ele": int(it["ele"])} if it["ele"] and it["type"] in ("peak", "glacier") else {}),
            "s": summ.get(it["title"], ""),
        } for it in lst]
        body = json.dumps({"km0": c * ck, "km1": (c + 1) * ck, "pois": rows}, ensure_ascii=False, separators=(",", ":"))
        h = hashlib.sha256(body.encode()).hexdigest()[:10]
        (OUT / f"{h}.json").write_text(body)
        lats = [r["lat"] for r in rows]
        lons = [r["lon"] for r in rows]
        chunks.append({"url": f"data/pois/{h}.json", "km0": c * ck, "km1": (c + 1) * ck, "count": len(rows),
                       "bbox": [min(lons), min(lats), max(lons), max(lats)], "bytes": len(body.encode())})
    (OUT / "index.json").write_text(json.dumps({"chunks": chunks, "total": len(final)}, indent=1))
    size = sum(c["bytes"] for c in chunks)
    print(f"\nWrote {len(chunks)} chunks, {len(final)} POIs, {size / 1e6:.2f} MB -> web/data/pois/")
    for c in chunks:
        print(f"  km {c['km0']:5}-{c['km1']:<5} {c['count']:4} POIs {c['bytes'] / 1e3:7.1f} kB")


if __name__ == "__main__":
    main()
