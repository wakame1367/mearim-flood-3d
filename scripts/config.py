"""Shared configuration for the data pipeline."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
WEB = ROOT / "public" / "data"

# Study area (WGS84). Covers Pedreiras (east bank), Trizidela do Vale (west bank)
# and the Rio Mearim reach between them, with some margin for context.
BBOX_LL = dict(west=-44.650, south=-4.610, east=-44.560, north=-4.530)

# Working projection: SIRGAS 2000 / UTM zone 23S (Brazilian official CRS; also used by SGB data).
CRS = "EPSG:31983"
CELL = 30.0  # metres; native resolution of Copernicus GLO-30 and SGB/Topodata MDE

# ANA gauge "Pedreiras II" (code 33281000) on the Rio Mearim, coordinates from the ANA inventory.
GAUGE = dict(code="33281000", name="Pedreiras II", lat=-4.57, lon=-44.6106)

COPERNICUS_TILE = (
    "https://copernicus-dem-30m.s3.amazonaws.com/"
    "Copernicus_DSM_COG_10_S05_00_W045_00_DEM/Copernicus_DSM_COG_10_S05_00_W045_00_DEM.tif"
)
