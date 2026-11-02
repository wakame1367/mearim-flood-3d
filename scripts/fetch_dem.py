#!/usr/bin/env python3
"""Clip DEMs for the study area from public Cloud-Optimized GeoTIFFs (HTTP range requests, no key).

1. Copernicus GLO-30 DSM (AWS Open Data, s3://copernicus-dem-30m)       -> data/raw/copernicus/cop30_clip.tif
   heights in metres above EGM2008; equivalent to OpenTopography OT.032021.4326.1 (needs an API key there).
2. FABDEM V1-2 (Copernicus GLO-30 with buildings and forest removed, Univ. of Bristol)
   licence CC BY-NC-SA 4.0 (NON-COMMERCIAL). Official distribution = 10 deg zip bundles (1-2 GB) at
   data.bris.ac.uk; here read from a public COG re-host of the same tiles (huggingface links-ads/fabdem).
   -> data/raw/fabdem/fabdem_clip.tif        (skip with --no-fabdem)

Native grids are kept (EPSG:4326, 1 arc-second) so the raw clips are reproducible.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import rasterio
from rasterio.windows import from_bounds

from config import BBOX_LL, COPERNICUS_TILE, RAW

FABDEM_TILE = ("https://huggingface.co/buckets/links-ads/fabdem/resolve/tiles/"
               "S10W050-N00W040_FABDEM_V1-2/S05W045_FABDEM_V1-2.tif")
MARGIN = 0.01  # degrees (~1.1 km) so reprojection to UTM has full coverage


def clip(url: str, out: Path, tags: dict) -> dict:
    out.parent.mkdir(parents=True, exist_ok=True)
    b = BBOX_LL
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="4"):
        with rasterio.open("/vsicurl/" + url) as src:
            win = from_bounds(b["west"] - MARGIN, b["south"] - MARGIN, b["east"] + MARGIN, b["north"] + MARGIN,
                              src.transform).round_offsets().round_lengths()
            arr = src.read(1, window=win)
            profile = dict(driver="GTiff", dtype=arr.dtype, count=1, crs=src.crs, nodata=src.nodata,
                           width=arr.shape[1], height=arr.shape[0], transform=src.window_transform(win),
                           compress="deflate")
            with rasterio.open(out, "w", **profile) as dst:
                dst.write(arr, 1)
                dst.update_tags(SOURCE=url, **tags)
    meta = {"source": url, "shape": arr.shape, "min": float(arr.min()), "max": float(arr.max()),
            "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **tags}
    (out.parent / "meta.json").write_text(json.dumps(meta, indent=1))
    print(meta)
    return meta


def main() -> None:
    clip(COPERNICUS_TILE, RAW / "copernicus" / "cop30_clip.tif",
         {"VERTICAL_DATUM": "EGM2008", "LICENSE": "Copernicus DEM licence (free, attribution)"})
    if "--no-fabdem" not in sys.argv:
        try:
            clip(FABDEM_TILE, RAW / "fabdem" / "fabdem_clip.tif",
                 {"VERTICAL_DATUM": "EGM2008", "LICENSE": "CC BY-NC-SA 4.0 (non-commercial)"})
        except Exception as e:  # optional layer
            print("FABDEM not available:", e)


if __name__ == "__main__":
    main()
