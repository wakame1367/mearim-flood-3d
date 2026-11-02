#!/usr/bin/env python3
"""Fetch ANA (Agência Nacional de Águas) gauge inventory and daily stage series
for the Rio Mearim gauges at Pedreiras, using the public HidroWeb SOAP/HTTP-GET
service (no API key):  http://telemetriaws1.ana.gov.br/ServiceANA.asmx

Outputs (data/raw/ana/):
  inventory.json         station metadata (coordinates, drainage area, 'Altitude' if any)
  stage_<code>.csv       date, stage_cm, consistency level (1=raw, 2=consisted)
  summary.json           annual maxima and percentiles (used in docs / UI calibration notes)

NOTE: ANA 'cota' (stage) is relative to the gauge's local zero ("zero da régua").
It is NOT an elevation and must not be compared with DEM heights directly.
"""
from __future__ import annotations

import csv
import json
import statistics
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

BASE = "http://telemetriaws1.ana.gov.br/ServiceANA.asmx"
OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "ana"
STATIONS = ["33280000", "33281000"]  # Pedreiras / Pedreiras II on the Rio Mearim (from ANA inventory)


def get(op: str, **params: str) -> ET.Element:
    url = f"{BASE}/{op}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=180) as r:
        return ET.fromstring(r.read())


def rows(root: ET.Element, tag: str) -> list[dict[str, str]]:
    out = []
    for el in root.iter():
        if el.tag.split("}")[-1] == tag:
            out.append({c.tag.split("}")[-1]: (c.text or "").strip() for c in el})
    return out


def inventory() -> list[dict[str, str]]:
    keys = dict(codEstDE="", codEstATE="", tpEst="1", nmEst="", nmRio="", codSubBacia="", codBacia="",
                nmMunicipio="PEDREIRAS", nmEstado="", sgResp="", sgOper="", telemetrica="")
    inv = rows(get("HidroInventario", **keys), "Table")
    for code in STATIONS:
        if not any(r.get("Codigo") == code for r in inv):
            keys.update(codEstDE=code, codEstATE=code, nmMunicipio="")
            inv += rows(get("HidroInventario", **keys), "Table")
    return inv


def stage_series(code: str) -> list[tuple[str, float, str]]:
    root = get("HidroSerieHistorica", codEstacao=code, dataInicio="01/01/1960", dataFim="31/12/2026",
               tipoDados="1", nivelConsistencia="")
    best: dict[str, tuple[float, str]] = {}
    for t in rows(root, "SerieHistorica"):
        month = t.get("DataHora", "")[:10]
        if not month:
            continue
        y, m = int(month[:4]), int(month[5:7])
        lvl = t.get("NivelConsistencia", "1")
        for d in range(1, 32):
            v = t.get(f"Cota{d:02d}")
            if not v:
                continue
            key = f"{y:04d}-{m:02d}-{d:02d}"
            prev = best.get(key)
            if prev is None or lvl > prev[1]:  # prefer consisted (2) over raw (1)
                best[key] = (float(v), lvl)
    return sorted((k, v[0], v[1]) for k, v in best.items())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    inv = inventory()
    keep = [r for r in inv if "MEARIM" in r.get("RioNome", "").upper() or r.get("Codigo") in STATIONS]
    (OUT / "inventory.json").write_text(json.dumps(keep, ensure_ascii=False, indent=1))
    print("stations:", [(r.get("Codigo"), r.get("Nome"), r.get("Latitude"), r.get("Longitude"), r.get("Altitude"),
                         r.get("AreaDrenagem")) for r in keep])
    summary = {}
    for code in sorted({r["Codigo"] for r in keep}):
        try:
            series = stage_series(code)
        except Exception as e:  # service occasionally times out
            print("failed", code, e, file=sys.stderr)
            continue
        if not series:
            continue
        with open(OUT / f"stage_{code}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "stage_cm", "consistency"])
            w.writerows(series)
        annual = defaultdict(float)
        for d, v, _ in series:
            annual[d[:4]] = max(annual[d[:4]], v)
        vals = sorted(v for _, v, _ in series)
        q = lambda p: vals[min(len(vals) - 1, int(p * len(vals)))]
        summary[code] = {
            "first": series[0][0], "last": series[-1][0], "n_days": len(series),
            "stage_cm_percentiles": {"p05": q(0.05), "p50": q(0.5), "p95": q(0.95), "max": vals[-1]},
            "median_cm": statistics.median(vals),
            "annual_max_cm": dict(sorted(annual.items())),
            "top10_days": sorted(series, key=lambda s: -s[1])[:10],
        }
        print(code, summary[code]["first"], summary[code]["last"], len(series), summary[code]["stage_cm_percentiles"])
    (OUT / "summary.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
