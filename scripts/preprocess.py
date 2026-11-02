#!/usr/bin/env python3
"""Turn the raw downloads into compact, browser-ready layers on one common grid.

Inputs (run the fetch_* scripts first):
  data/raw/copernicus/cop30_clip.tif     Copernicus GLO-30 (EGM2008)
  data/raw/sgb/mde_*/MDE/*_sirgas_utm    SGB/CPRM 2015 kit MDE (Topodata = SRTM-derived, EGM96)
  data/raw/sgb/sig_*/{Limites,Suscetibilidade}/*.shp
  data/raw/osm/osm.json                  OpenStreetMap (roads, river, streams, POIs)
  data/raw/overture/buildings.geojson    Overture buildings (Google Open Buildings + OSM)
  data/raw/ana/stage_33281000.csv        ANA daily stage, Pedreiras II gauge

Outputs (public/data/): manifest.json + little-endian binary rasters (row 0 = north) + JSON vectors.
Everything is in SIRGAS 2000 / UTM 23S; the browser uses local metres relative to the grid centre
(x = east, y = north).
"""
from __future__ import annotations

import csv
import heapq
import json
import math
import statistics
import subprocess
import tempfile
from collections import deque
from datetime import date
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS as RCRS
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform as warp_transform, transform_bounds

from config import BBOX_LL, CELL, CRS, GAUGE, RAW, WEB

DST_CRS = RCRS.from_string(CRS)


# ----------------------------------------------------------------------------- grid
def make_grid():
    b = BBOX_LL
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", DST_CRS, b["west"], b["south"], b["east"], b["north"])
    x0, y1 = math.floor(minx / CELL) * CELL, math.ceil(maxy / CELL) * CELL
    nx, ny = int(math.ceil((maxx - x0) / CELL)), int(math.ceil((y1 - miny) / CELL))
    transform = from_origin(x0, y1, CELL, CELL)
    cx, cy = x0 + nx * CELL / 2, y1 - ny * CELL / 2
    return dict(nx=nx, ny=ny, x0=x0, y1=y1, cx=cx, cy=cy, transform=transform)


def to_local(g, xs, ys):
    return np.asarray(xs) - g["cx"], np.asarray(ys) - g["cy"]


def ll_to_utm(lons, lats):
    xs, ys = warp_transform("EPSG:4326", DST_CRS, list(lons), list(lats))
    return np.array(xs), np.array(ys)


# ----------------------------------------------------------------------------- DEMs
def warp_to_grid(src_path: str, g, src_crs=None, src_nodata=None) -> np.ndarray:
    dst = np.full((g["ny"], g["nx"]), np.nan, dtype=np.float32)
    with rasterio.open(src_path) as src:
        reproject(source=rasterio.band(src, 1), destination=dst, src_crs=src_crs or src.crs,
                  src_nodata=src_nodata if src_nodata is not None else src.nodata, dst_transform=g["transform"],
                  dst_crs=DST_CRS, dst_nodata=np.nan, resampling=Resampling.bilinear)
    return dst


def load_dems(g) -> dict[str, np.ndarray]:
    dems = {"cop30": warp_to_grid(str(RAW / "copernicus" / "cop30_clip.tif"), g)}
    fab = RAW / "fabdem" / "fabdem_clip.tif"
    if fab.exists():
        dems["fabdem"] = warp_to_grid(str(fab), g)
    sgb = None
    for town, code in (("pedreiras", "pd"), ("trizidela", "tv")):
        p = RAW / "sgb" / f"mde_{town}" / "MDE" / f"{code}_sirgas_utm"
        if p.exists():
            # ArcGIS grid with an 'unnamed' GRS80 UTM 23S CRS -> declare SIRGAS 2000 / UTM 23S explicitly
            a = warp_to_grid(str(p), g, src_crs=DST_CRS)
            sgb = a if sgb is None else np.where(np.isnan(sgb), a, sgb)
    if sgb is not None:
        valid = np.isfinite(sgb).mean()
        print(f"SGB MDE valid fraction in window: {valid:.3f}")
        if valid > 0.98:
            dems["sgb"] = fill_nan(sgb)
    for k, v in dems.items():
        print(k, "min/max", np.nanmin(v), np.nanmax(v), "nan", np.isnan(v).sum())
    return dems


def fill_nan(a: np.ndarray) -> np.ndarray:
    a = a.copy()
    while np.isnan(a).any():
        m = np.isnan(a)
        p = np.pad(a, 1, mode="edge")
        nb = np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
        a[m] = np.nanmean(nb, axis=0)[m]
    return a


def bilinear(a: np.ndarray, g, xs, ys) -> np.ndarray:
    """Sample raster a at UTM coords (cell-centre convention)."""
    fx = (np.asarray(xs) - g["x0"]) / CELL - 0.5
    fy = (g["y1"] - np.asarray(ys)) / CELL - 0.5
    i0 = np.clip(np.floor(fx).astype(int), 0, g["nx"] - 2)
    j0 = np.clip(np.floor(fy).astype(int), 0, g["ny"] - 2)
    tx, ty = np.clip(fx - i0, 0, 1), np.clip(fy - j0, 0, 1)
    return (a[j0, i0] * (1 - tx) * (1 - ty) + a[j0, i0 + 1] * tx * (1 - ty)
            + a[j0 + 1, i0] * (1 - tx) * ty + a[j0 + 1, i0 + 1] * tx * ty)


# ----------------------------------------------------------------------------- OSM helpers
def load_osm():
    return json.loads((RAW / "osm" / "osm.json").read_text())["elements"]


def way_coords(e) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in e.get("geometry", []) if p]


def join_rings(segments: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Assemble multipolygon member ways into closed rings by matching endpoints."""
    segs = [s[:] for s in segments if len(s) >= 2]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for k, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(k)
                changed = True
                break
        if len(cur) >= 4:
            rings.append(cur)
    return rings


def polygons_of(e) -> list[dict]:
    """GeoJSON-like polygons in lon/lat for a closed way or multipolygon relation."""
    if e["type"] == "way":
        c = way_coords(e)
        return [{"outer": [c], "inner": []}] if len(c) >= 4 and c[0] == c[-1] else []
    outer = join_rings([way_coords(m) for m in e.get("members", []) if m.get("role") == "outer"])
    inner = join_rings([way_coords(m) for m in e.get("members", []) if m.get("role") == "inner"])
    return [{"outer": outer, "inner": inner}] if outer else []


def ring_to_utm(ring):
    xs, ys = ll_to_utm([p[0] for p in ring], [p[1] for p in ring])
    return list(zip(xs.tolist(), ys.tolist()))


def rasterize_polys(polys_utm, g, all_touched=False) -> np.ndarray:
    shapes = []
    for p in polys_utm:
        for r in p["outer"]:
            shapes.append(({"type": "Polygon", "coordinates": [r]}, 1))
        for r in p["inner"]:
            shapes.append(({"type": "Polygon", "coordinates": [r]}, 0))
    if not shapes:
        return np.zeros((g["ny"], g["nx"]), np.uint8)
    return rasterize(shapes, out_shape=(g["ny"], g["nx"]), transform=g["transform"], fill=0,
                     all_touched=all_touched, dtype="uint8")


def rasterize_lines(lines_utm, g) -> np.ndarray:
    shapes = [({"type": "LineString", "coordinates": l}, 1) for l in lines_utm if len(l) >= 2]
    if not shapes:
        return np.zeros((g["ny"], g["nx"]), np.uint8)
    return rasterize(shapes, out_shape=(g["ny"], g["nx"]), transform=g["transform"], fill=0, all_touched=True,
                     dtype="uint8")


def merge_polyline(parts: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    parts = [p[:] for p in parts if len(p) >= 2]
    line = parts.pop(0)
    while parts:
        best = None
        for k, p in enumerate(parts):
            for rev_p in (False, True):
                q = p[::-1] if rev_p else p
                for at_end in (True, False):
                    a = line[-1] if at_end else line[0]
                    b = q[0] if at_end else q[-1]
                    d = math.dist(a, b)
                    if best is None or d < best[0]:
                        best = (d, k, q, at_end)
        _, k, q, at_end = best
        parts.pop(k)
        line = line + q if at_end else q + line
    return line


def densify(line, step):
    out = [line[0]]
    for a, b in zip(line[:-1], line[1:]):
        d = math.dist(a, b)
        n = max(1, int(d // step))
        for t in range(1, n + 1):
            out.append((a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n))
    return out


# ----------------------------------------------------------------------------- vectors via ogr2ogr
def read_shp_utm(path: Path) -> list[dict]:
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "o.geojson"
        subprocess.run(["ogr2ogr", "-f", "GeoJSON", "-t_srs", CRS, str(out), str(path)], check=True)
        return json.loads(out.read_text())["features"]


def feature_polys(f) -> list[dict]:
    geom = f["geometry"]
    if geom is None:
        return []
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return [{"outer": [[tuple(c[:2]) for c in poly[0]]], "inner": [[tuple(c[:2]) for c in r] for r in poly[1:]]}
            for poly in polys]


# ----------------------------------------------------------------------------- hydrology
N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def keep_components_touching(mask: np.ndarray, seed: np.ndarray) -> np.ndarray:
    ny, nx = mask.shape
    out = np.zeros_like(mask)
    q = deque(zip(*np.nonzero(mask & seed)))
    for j, i in q:
        out[j, i] = 1
    while q:
        j, i = q.popleft()
        for dj, di in N8:
            jj, ii = j + dj, i + di
            if 0 <= jj < ny and 0 <= ii < nx and mask[jj, ii] and not out[jj, ii]:
                out[jj, ii] = 1
                q.append((jj, ii))
    return out


def river_profile(dem, g, center_utm, channel):
    """Along-channel reference water-surface profile from the DEM (upstream -> downstream)."""
    pts = densify(center_utm, CELL)
    xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
    inside = (xs > g["x0"]) & (xs < g["x0"] + g["nx"] * CELL) & (ys < g["y1"]) & (ys > g["y1"] - g["ny"] * CELL)
    xs, ys = xs[inside], ys[inside]
    z = bilinear(dem, g, xs, ys)
    n = len(z)
    if z[: n // 5].mean() < z[-n // 5:].mean():  # make index 0 = upstream (higher)
        xs, ys, z = xs[::-1], ys[::-1], z[::-1]
    w = 10
    zs = np.array([np.percentile(z[max(0, k - w): k + w + 1], 25) for k in range(n)])
    zs = np.minimum.accumulate(zs)  # water surface cannot rise downstream
    chain = np.concatenate([[0], np.cumsum(np.hypot(np.diff(xs), np.diff(ys)))])
    return dict(x=xs, y=ys, raw=z, z=zs, chain=chain)


def nearest_profile(prof, g) -> tuple[np.ndarray, np.ndarray]:
    """For each cell: index of nearest centre-line sample (Euclidean)."""
    jj, ii = np.mgrid[0:g["ny"], 0:g["nx"]]
    cx = g["x0"] + (ii.ravel() + 0.5) * CELL
    cy = g["y1"] - (jj.ravel() + 0.5) * CELL
    best = np.full(cx.size, np.inf)
    idx = np.zeros(cx.size, np.int32)
    for k0 in range(0, len(prof["x"]), 64):
        px, py = prof["x"][k0:k0 + 64], prof["y"][k0:k0 + 64]
        d = (cx[:, None] - px[None, :]) ** 2 + (cy[:, None] - py[None, :]) ** 2
        a = d.argmin(1)
        dm = d[np.arange(cx.size), a]
        upd = dm < best
        best[upd], idx[upd] = dm[upd], a[upd] + k0
    return idx.reshape(g["ny"], g["nx"]), np.sqrt(best).reshape(g["ny"], g["nx"])


def priority_flood_ref(dem: np.ndarray, channel: np.ndarray, seed_ref: np.ndarray):
    """Priority-flood (Barnes et al. 2014) from the river channel.

    Every cell inherits the reference water level of the channel cell whose drainage tree it joins
    (least-spill path = D8 flow path on the depression-filled DEM). Returns (ref, fill):
      ref  : river reference level of the cell's drainage outlet  -> HAND = dem - ref
      fill : spill elevation (minimax path height from the river)
    """
    ny, nx = dem.shape
    ref = np.full(dem.shape, np.nan, np.float32)
    fill = np.full(dem.shape, np.nan, np.float32)
    done = np.zeros(dem.shape, bool)
    heap = []
    for j, i in zip(*np.nonzero(channel)):
        ref[j, i] = seed_ref[j, i]
        fill[j, i] = dem[j, i]
        done[j, i] = True
        heapq.heappush(heap, (float(dem[j, i]), int(j), int(i)))
    while heap:
        lv, j, i = heapq.heappop(heap)
        for dj, di in N8:
            jj, ii = j + dj, i + di
            if 0 <= jj < ny and 0 <= ii < nx and not done[jj, ii]:
                done[jj, ii] = True
                nl = max(float(dem[jj, ii]), lv)
                fill[jj, ii] = nl
                ref[jj, ii] = ref[j, i]
                heapq.heappush(heap, (nl, jj, ii))
    return ref, fill


# ----------------------------------------------------------------------------- ANA calibration
def stage_stats():
    p = RAW / "ana" / f"stage_{GAUGE['code']}.csv"
    if not p.exists():
        return None
    rows = [(date.fromisoformat(r["date"]), float(r["stage_cm"]) / 100, r["consistency"]) for r in csv.DictReader(open(p))]
    def window(a, b):
        v = [s for d, s, _ in rows if a <= d <= b]
        return dict(median=round(statistics.median(v), 2), p10=round(np.percentile(v, 10), 2),
                    p90=round(np.percentile(v, 90), 2), n=len(v)) if v else None
    annual = {}
    for d, s, c in rows:
        if s > annual.get(d.year, (0, None, None))[0]:
            annual[d.year] = (s, d.isoformat(), c)
    allv = [s for _, s, _ in rows]
    return {
        "station": GAUGE,
        "period": [rows[0][0].isoformat(), rows[-1][0].isoformat()],
        "all": dict(median=round(statistics.median(allv), 2), p95=round(float(np.percentile(allv, 95)), 2),
                    max=max(allv)),
        # Copernicus GLO-30 = TanDEM-X acquisitions Dec 2010 - Jan 2015
        "tandemx_2011_2014": window(date(2010, 12, 1), date(2015, 1, 31)),
        # SRTM (basis of Topodata / SGB MDE) flew 11-22 Feb 2000
        "srtm_feb2000": window(date(2000, 2, 11), date(2000, 2, 22)),
        "annual_max": {y: {"stage_m": round(s, 2), "date": d, "consistency": c} for y, (s, d, c) in sorted(annual.items())},
        # observed daily hydrographs (Feb-Jun) of notable floods, replayed in the UI through the static model
        "events": {str(y): [[d.isoformat(), round(s, 2)] for d, s, _ in rows if d.year == y and 2 <= d.month <= 6]
                   for y in (1985, 2009, 2023, 2024)},
    }


# ----------------------------------------------------------------------------- main
def main():
    WEB.mkdir(parents=True, exist_ok=True)
    g = make_grid()
    nx, ny = g["nx"], g["ny"]
    print("grid", nx, ny, g["x0"], g["y1"])
    dems = load_dems(g)
    osm = load_osm()

    # --- water
    river_polys, lake_polys, streams, mearim_parts = [], [], [], []
    for e in osm:
        t = e.get("tags", {})
        if t.get("natural") == "water" or t.get("waterway") == "riverbank":
            target = river_polys if t.get("water") == "river" or t.get("waterway") == "riverbank" else lake_polys
            for p in polygons_of(e):
                target.append({"outer": [ring_to_utm(r) for r in p["outer"]], "inner": [ring_to_utm(r) for r in p["inner"]]})
        elif t.get("waterway") == "river" and e["type"] == "way":
            mearim_parts.append(ring_to_utm(way_coords(e)))
        elif t.get("waterway") in ("stream", "canal", "drain", "ditch") and e["type"] == "way":
            streams.append(ring_to_utm(way_coords(e)))
    center = merge_polyline(mearim_parts)
    center_mask = rasterize_lines([center], g)
    channel = keep_components_touching(rasterize_polys(river_polys, g) | center_mask, center_mask.astype(bool))
    lakes = rasterize_polys(lake_polys, g)
    drainage = np.where(rasterize_lines(streams, g) > 0, 1, 0).astype(np.uint8)
    drainage[lakes > 0] = 2
    drainage[channel > 0] = 0
    print("channel cells", int(channel.sum()), "stream cells", int((drainage == 1).sum()))

    # --- towns and SGB susceptibility
    town = np.zeros((ny, nx), np.uint8)
    susc = np.full((ny, nx), 255, np.uint8)
    cls = {"Baixa": 1, "Média": 2, "Alta": 3}
    town_defs = [(1, "Pedreiras", "sig_pedreiras", "Pedreiras_Sirgas2000_UTM23.shp"),
                 (2, "Trizidela do Vale", "sig_trizidela", "Trizidela_do_Vale_Sirgas2000_UTM23.shp")]
    for tid, name, folder, shp in town_defs:
        base = RAW / "sgb" / folder
        lim = base / "Limites" / shp
        if not lim.exists():
            continue
        polys = [p for f in read_shp_utm(lim) for p in feature_polys(f)]
        m = rasterize_polys(polys, g) > 0
        town[m] = tid
        sus_shp = base / "Suscetibilidade" / "Inundacao_A.shp"
        if sus_shp.exists():
            s = np.zeros((ny, nx), np.uint8)
            feats = read_shp_utm(sus_shp)
            for c_name, c_val in cls.items():  # paint low -> high so higher classes win on shared edges
                ps = [p for f in feats if f["properties"].get("CLASSE") == c_name for p in feature_polys(f)]
                s[rasterize_polys(ps, g) > 0] = c_val
            susc[m] = s[m]
    print("town cells", {k: int((town == k).sum()) for k in (1, 2)},
          "susc", {int(k): int((susc == k).sum()) for k in np.unique(susc)})

    # --- per-DEM river profile, reference surfaces
    gx, gy = ll_to_utm([GAUGE["lon"]], [GAUGE["lat"]])
    dem_meta = {}
    for key, dem in dems.items():
        prof = river_profile(dem, g, center, channel)
        idx, dist = nearest_profile(prof, g)
        zref_profile = prof["z"][idx].astype(np.float32)
        ref_hand, fill = priority_flood_ref(dem, channel > 0, zref_profile)
        # ANA coordinates are given to 0.01 deg (lat) -> snap the gauge to the nearest centre-line sample
        d2 = (prof["x"] - gx[0]) ** 2 + (prof["y"] - gy[0]) ** 2
        k_g = int(np.argmin(d2))
        gauge_snap = (float(prof["x"][k_g]), float(prof["y"][k_g]), float(np.sqrt(d2[k_g])))
        z_gauge = float(prof["z"][k_g])
        dem.astype("<f4").tofile(WEB / f"dem_{key}.f32")
        zref_profile.astype("<f4").tofile(WEB / f"zref_profile_{key}.f32")
        ref_hand.astype("<f4").tofile(WEB / f"zref_hand_{key}.f32")
        hand = dem - ref_hand
        lx, ly = to_local(g, prof["x"], prof["y"])
        dem_meta[key] = dict(
            file=f"dem_{key}.f32", zrefProfile=f"zref_profile_{key}.f32", zrefHand=f"zref_hand_{key}.f32",
            zMin=float(dem.min()), zMax=float(dem.max()), riverZAtGauge=round(z_gauge, 2),
            profile=dict(chain=np.round(prof["chain"][::5], 1).tolist(), raw=np.round(prof["raw"][::5], 2).tolist(),
                         z=np.round(prof["z"][::5], 2).tolist(), x=np.round(lx[::5], 1).tolist(), y=np.round(ly[::5], 1).tolist(),
                         gaugeChain=round(float(prof["chain"][k_g]), 1)),
            riverDrop=round(float(prof["z"][0] - prof["z"][-1]), 2), riverLength=round(float(prof["chain"][-1]), 1),
            handPercentiles={str(p): round(float(np.percentile(hand[channel == 0], p)), 2) for p in (5, 25, 50, 75, 95)},
        )
        print(key, "gauge river z", z_gauge, "drop", dem_meta[key]["riverDrop"], "len", dem_meta[key]["riverLength"])

    channel.astype(np.uint8).tofile(WEB / "channel.u8")
    drainage.tofile(WEB / "drainage.u8")
    town.tofile(WEB / "town.u8")
    susc.tofile(WEB / "susc.u8")

    # --- vectors: river polygons + streams (display)
    def lr(r):
        x, y = to_local(g, [p[0] for p in r], [p[1] for p in r])
        return np.round(np.column_stack([x, y]).ravel(), 1).tolist()
    water = {"river": [{"outer": [lr(r) for r in p["outer"]], "inner": [lr(r) for r in p["inner"]]} for p in river_polys],
             "lakes": [{"outer": [lr(r) for r in p["outer"]], "inner": [lr(r) for r in p["inner"]]} for p in lake_polys],
             "streams": [lr(s) for s in streams], "centerline": lr(center)}
    (WEB / "water.json").write_text(json.dumps(water, separators=(",", ":")))

    # --- roads
    roads = []
    for e in osm:
        t = e.get("tags", {})
        if "highway" in t and e["type"] == "way" and t["highway"] not in ("construction", "proposed"):
            c = ring_to_utm(way_coords(e))
            roads.append({"c": lr(c), "k": t["highway"], "n": t.get("name"),
                          "br": 1 if t.get("bridge") in ("yes", "viaduct") else 0})
    (WEB / "roads.json").write_text(json.dumps(roads, separators=(",", ":"), ensure_ascii=False))

    # --- buildings (Overture: Google Open Buildings + OSM)
    bpath = RAW / "overture" / "buildings.geojson"
    buildings, bsrc = [], {}
    if bpath.exists():
        feats = json.loads(bpath.read_text())["features"]
        rings, meta = [], []
        for f in feats:
            geom = f["geometry"]
            poly = geom["coordinates"][0] if geom["type"] == "MultiPolygon" else geom["coordinates"]
            ring = poly[0]
            s = f["properties"].get("sources") or []
            s = json.loads(s) if isinstance(s, str) else s
            ds = s[0].get("dataset") if s else "unknown"
            conf = s[0].get("confidence") if s else None
            rings.append(ring)
            meta.append((ds, conf, f["properties"].get("height"), f["properties"].get("num_floors")))
        flat = [p for r in rings for p in r]
        xs, ys = ll_to_utm([p[0] for p in flat], [p[1] for p in flat])
        lx, ly = to_local(g, xs, ys)
        k = 0
        half = (nx * CELL / 2, ny * CELL / 2)
        for r, (ds, conf, h, nf) in zip(rings, meta):
            n = len(r)
            px, py = lx[k:k + n], ly[k:k + n]
            k += n
            if abs(px.mean()) > half[0] or abs(py.mean()) > half[1]:
                continue
            bsrc[ds] = bsrc.get(ds, 0) + 1
            buildings.append({"c": np.round(np.column_stack([px[:-1], py[:-1]]).ravel(), 1).tolist(),
                              "s": "G" if ds == "Google Open Buildings" else ("O" if ds == "OpenStreetMap" else "X"),
                              "p": None if conf is None else round(conf, 3),
                              "h": h if h else (nf * 3.0 if nf else None)})
    (WEB / "buildings.json").write_text(json.dumps(buildings, separators=(",", ":")))
    print("buildings", len(buildings), bsrc, "roads", len(roads))

    # --- POIs
    pois = []
    for e in osm:
        t = e.get("tags", {})
        kind = t.get("place") or t.get("amenity")
        if not kind or kind not in ("town", "city", "village", "suburb", "neighbourhood", "school", "hospital", "clinic"):
            continue
        if e["type"] == "node":
            lon, lat = e["lon"], e["lat"]
        elif "bounds" in e:
            bb = e["bounds"]
            lon, lat = (bb["minlon"] + bb["maxlon"]) / 2, (bb["minlat"] + bb["maxlat"]) / 2
        else:
            c = way_coords(e)
            if not c:
                continue
            lon, lat = sum(p[0] for p in c) / len(c), sum(p[1] for p in c) / len(c)
        x, y = ll_to_utm([lon], [lat])
        lx_, ly_ = to_local(g, x, y)
        pois.append({"k": kind, "n": t.get("name"), "x": round(float(lx_[0]), 1), "y": round(float(ly_[0]), 1)})
    (WEB / "pois.json").write_text(json.dumps(pois, ensure_ascii=False, separators=(",", ":")))

    gl = to_local(g, gx, gy)
    gs = to_local(g, [gauge_snap[0]], [gauge_snap[1]])
    osm_meta = json.loads((RAW / "osm" / "meta.json").read_text())
    ov_meta = json.loads((RAW / "overture" / "meta.json").read_text()) if (RAW / "overture" / "meta.json").exists() else None
    manifest = {
        "version": 1,
        "crs": CRS, "cell": CELL, "nx": nx, "ny": ny,
        "originUTM": {"x0": g["x0"], "y1": g["y1"]}, "centerUTM": {"x": g["cx"], "y": g["cy"]},
        "bboxLL": BBOX_LL,
        "dems": dem_meta,
        "demLabels": {"cop30": "Copernicus GLO-30 DSM (TanDEM-X 2011-2015, EGM2008)",
                      "fabdem": "FABDEM V1-2 bare-earth (Copernicus minus buildings/forest, CC BY-NC-SA)",
                      "sgb": "SGB/CPRM 2015 kit MDE (Topodata/SRTM 2000, EGM96)"},
        "rasters": {"channel": "channel.u8", "drainage": "drainage.u8", "town": "town.u8", "susc": "susc.u8"},
        "towns": [{"id": 1, "name": "Pedreiras"}, {"id": 2, "name": "Trizidela do Vale"}],
        "gauge": {**GAUGE, "xAna": round(float(gl[0][0]), 1), "yAna": round(float(gl[1][0]), 1),
                  "x": round(float(gs[0][0]), 1), "y": round(float(gs[1][0]), 1),
                  "snapDistance": round(gauge_snap[2], 1), "anaInventoryAltitude": 22},
        "stage": stage_stats(),
        "sources": {"osm": osm_meta, "overture": ov_meta},
    }
    (WEB / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print("stage calibration windows:", manifest["stage"] and {k: manifest["stage"][k] for k in ("tandemx_2011_2014", "srtm_feb2000", "all")})


if __name__ == "__main__":
    main()
