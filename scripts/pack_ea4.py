#!/usr/bin/env python3
"""Pack LISFLOOD-FP EA benchmark Test 4 output into a web region pack.

Source: Zenodo 10.5281/zenodo.4661888 (LISFLOOD-FP 8.0 simulation results), ea4.zip.
Test 4: point-source inflow flooding a ~1km x 2km floodplain (Environment Agency
2D-model benchmark; Néelz & Pender 2013). Synthetic terrain, real solver output.

Input  : data/raw/lisflood-eden/ea4/ea4/  (ea4-5m.dem.gz + ea4-5m/<solver>/ea4-000N.wd)
Output : public/regions/ea4/              (manifest v2 + dem.f32 + u16 depth frames)

Frame encoding: little-endian uint16, depth in millimetres, row-major,
row 0 = north (same cell order as the .f32 DEMs in public/data).
"""
import gzip
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data/raw/lisflood-eden/ea4/ea4"
OUT = ROOT / "public/regions/ea4"
RES = "5m"
SOLVER = "fv1"  # full-physics solver; acc/dg2 also available in the archive
MM_PER_M = 1000.0


def read_asc(path, nodata_to=0.0):
    """Read an ESRI ASCII grid -> (header dict, flat list row-major, row0=north)."""
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        hdr = {}
        for _ in range(6):
            k, v = f.readline().split()
            hdr[k.lower()] = float(v)
        vals = [float(x) for x in f.read().split()]
    n = int(hdr["ncols"] * hdr["nrows"])
    assert len(vals) == n, f"{path}: expected {n} cells, got {len(vals)}"
    nd = hdr.get("nodata_value", -9999.0)
    return hdr, [nodata_to if v == nd else v for v in vals]


def main():
    dem_path = SRC / f"ea4-{RES}.dem.gz"
    frame_dir = SRC / f"ea4-{RES}" / SOLVER
    frames = sorted(frame_dir.glob("ea4-*.wd"))
    if not dem_path.exists() or not frames:
        sys.exit(f"missing inputs under {SRC} (extract ea4.zip first)")

    hdr, dem = read_asc(dem_path, nodata_to=0.0)
    nx, ny, cell = int(hdr["ncols"]), int(hdr["nrows"]), hdr["cellsize"]
    xll, yll = hdr["xllcorner"], hdr["yllcorner"]

    (OUT / "frames").mkdir(parents=True, exist_ok=True)
    (OUT / "dem.f32").write_bytes(struct.pack(f"<{len(dem)}f", *dem))
    zv = [v for v in dem if v != 0.0] or dem
    zmin, zmax = min(zv), max(zv)

    frame_names, dmax = [], 0.0
    for i, p in enumerate(frames):
        fh, vals = read_asc(p)
        if int(fh["ncols"]) != nx or int(fh["nrows"]) != ny:
            sys.exit(f"{p.name}: grid mismatch")
        q = [min(65535, max(0, round(v * MM_PER_M))) for v in vals]
        dmax = max(dmax, max(q) / MM_PER_M)
        name = f"d_{i:04d}.u16"
        (OUT / "frames" / name).write_bytes(struct.pack(f"<{len(q)}H", *q))
        frame_names.append(f"frames/{name}")

    n = nx * ny
    for r in ("channel", "drainage", "town", "susc"):
        (OUT / f"{r}.u8").write_bytes(b"\x00" * n)
    (OUT / "buildings.json").write_text("[]")
    (OUT / "roads.json").write_text("[]")
    (OUT / "water.json").write_text('{"river":[],"lakes":[],"streams":[],"centerline":[]}')
    (OUT / "pois.json").write_text("[]")

    manifest = {
        "version": 2,
        "region": "ea4",
        "name": "EA benchmark Test 4 — floodplain point-source fill (LISFLOOD-FP)",
        "crs": "local (test grid, metres)",
        "cell": cell,
        "nx": nx,
        "ny": ny,
        "originUTM": {"x0": xll, "y1": yll + ny * cell},
        "centerUTM": {"x": xll + nx * cell / 2, "y": yll + ny * cell / 2},
        "bboxLL": {"west": xll, "south": yll, "east": xll + nx * cell, "north": yll + ny * cell},
        "dems": {
            "model": {
                "file": "dem.f32",
                "zrefProfile": "dem.f32",
                "zrefHand": "dem.f32",
                "zMin": round(zmin, 3),
                "zMax": round(zmax, 3),
                "riverZAtGauge": 0.0,
                "riverDrop": 0.0,
                "riverLength": 0.0,
                "profile": {"chain": [], "raw": [], "z": [], "x": [], "y": [], "gaugeChain": 0},
                "handPercentiles": {},
            }
        },
        "demLabels": {"model": f"EA Test4 DEM ({cell} m)"},
        "rasters": {"channel": "channel.u8", "drainage": "drainage.u8", "town": "town.u8", "susc": "susc.u8"},
        "towns": [],
        "gauge": None,
        "stage": None,
        "scenarios": [
            {
                "id": "ea4-fv1",
                "type": "simulation",
                "name": "EA Test 4: 集水域への点源流入 (LISFLOOD-FP FV1 solver)",
                "solver": SOLVER,
                "resolution_m": cell,
                "dtSeconds": 3600,
                "timeBase": "relative",
                "unit": "mm",
                "maxDepth_m": round(dmax, 2),
                "frames": frame_names,
                "note": "Environment Agency 2D model benchmark Test 4 (Neelz & Pender 2013). "
                        "Idealised floodplain; output from LISFLOOD-FP 8.0 (Zenodo 4661888). "
                        "Frames are hourly solver snapshots; between frames the viewer "
                        "interpolates visually (not a physical state).",
            }
        ],
        "sources": {
            "lisflood-fp": "Zenodo 10.5281/zenodo.4661888 (LISFLOOD-FP 8.0 simulation results)",
            "benchmark": "Neelz & Pender 2013, Benchmarking 2D hydraulic models (UK Environment Agency)",
        },
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"packed {nx}x{ny} @{cell}m, {len(frame_names)} frames, maxDepth {dmax:.2f} m -> {OUT}")


if __name__ == "__main__":
    main()
