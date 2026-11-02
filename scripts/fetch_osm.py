#!/usr/bin/env python3
"""Download OpenStreetMap features for the study area via the public Overpass API.

Output: data/raw/osm/osm.json (raw Overpass JSON with geometry), © OpenStreetMap contributors, ODbL.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

from config import BBOX_LL, RAW

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


# Split into small queries: public Overpass instances reject/timeout heavy combined requests.
PARTS = {
    "buildings": 'way["building"]({bbox});relation["building"]({bbox});',
    "highways": 'way["highway"]({bbox});',
    "water": 'way["waterway"]({bbox});way["natural"="water"]({bbox});relation["natural"="water"]({bbox});'
             'relation["waterway"="riverbank"]({bbox});way["man_made"="embankment"]({bbox});',
    "pois": 'node["place"]({bbox});nwr["amenity"~"school|hospital|clinic"]({bbox});',
}
UA = "mearim-flood-local/0.1 (research proof-of-concept; local use)"


def fetch(q: str) -> dict:
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for ep in ENDPOINTS:
        for _ in range(3):
            try:
                req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=200) as r:
                    return {"endpoint": ep, **json.loads(r.read())}
            except Exception as e:  # retry, then try next mirror
                last = e
                print("  failed", ep, e)
                time.sleep(10)
    raise SystemExit(f"Overpass download failed: {last}")


def main() -> None:
    out = RAW / "osm"
    out.mkdir(parents=True, exist_ok=True)
    b = BBOX_LL
    bbox = f"{b['south']},{b['west']},{b['north']},{b['east']}"
    elements, seen, meta = [], set(), {"fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "parts": {}}
    for name, body in PARTS.items():
        js = fetch(f"[out:json][timeout:120];({body.format(bbox=bbox)});out geom;")
        n = 0
        for e in js["elements"]:
            if (e["type"], e["id"]) not in seen:
                seen.add((e["type"], e["id"]))
                elements.append(e)
                n += 1
        meta["parts"][name] = {"endpoint": js["endpoint"], "elements": n,
                               "osm_base": js.get("osm3s", {}).get("timestamp_osm_base")}
        print(name, meta["parts"][name])
        time.sleep(3)
    (out / "osm.json").write_text(json.dumps({"elements": elements}))
    (out / "meta.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
