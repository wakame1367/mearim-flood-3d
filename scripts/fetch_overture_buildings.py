#!/usr/bin/env python3
"""Extract building footprints for the study area from Overture Maps (public GeoParquet on S3, no account).

Overture's buildings theme conflates OpenStreetMap, Microsoft ML footprints, Google Open Buildings and
Esri Community Maps (licence ODbL-1.0; per-feature 'sources' kept). Steps:
  1. read the release STAC collection, pick the Parquet parts whose bbox intersects config.BBOX_LL
  2. ogr2ogr each part with a spatial filter (GDAL reads only the footer and matching row groups)
Output: data/raw/overture/buildings.geojson (EPSG:4326) + meta.json
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request

from config import BBOX_LL, RAW

STAC = "https://stac.overturemaps.org"


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read())


def main(release: str | None = None) -> None:
    out = RAW / "overture"
    out.mkdir(parents=True, exist_ok=True)
    release = release or get_json(f"{STAC}/catalog.json")["latest"]
    coll = get_json(f"{STAC}/{release}/buildings/building/collection.json")
    items = [l["href"] for l in coll["links"] if l["rel"] == "item"]
    boxes = coll["extent"]["spatial"]["bbox"][1:]  # [0] is the overall extent, then one per part
    b = BBOX_LL
    hits = [i for i, bb in enumerate(boxes)
            if not (bb[2] < b["west"] or bb[0] > b["east"] or bb[3] < b["south"] or bb[1] > b["north"])]
    env = dict(os.environ, AWS_NO_SIGN_REQUEST="YES", AWS_REGION="us-west-2", GDAL_HTTP_MAX_RETRY="4",
               GDAL_HTTP_RETRY_DELAY="2")
    features, parts = [], []
    for i in hits:
        item = get_json(items[i])
        href = item["assets"]["aws"]["href"]
        path = "/vsis3/overturemaps-us-west-2/" + href.split(".amazonaws.com/")[1]
        tmp = out / f"part_{i}.geojson"
        t0 = time.time()
        subprocess.run(["ogr2ogr", "-f", "GeoJSON", str(tmp), path, "-spat", str(b["west"]), str(b["south"]),
                        str(b["east"]), str(b["north"]), "-select", "id,height,num_floors,class,subtype,sources",
                        "-lco", "RFC7946=YES", "-overwrite"], check=True, env=env)
        fc = json.loads(tmp.read_text())
        features += fc["features"]
        tmp.unlink()
        parts.append({"part": href.rsplit("/", 1)[1], "features": len(fc["features"]), "seconds": round(time.time() - t0)})
        print(parts[-1])
    seen, uniq = set(), []
    for f in features:
        fid = f["properties"].get("id")
        if fid not in seen:
            seen.add(fid)
            uniq.append(f)
    (out / "buildings.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": uniq}))
    meta = {"release": release, "license": coll.get("license"), "bbox": b, "parts": parts, "features": len(uniq),
            "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(meta)


if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else None)
