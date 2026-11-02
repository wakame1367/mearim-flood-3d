#!/usr/bin/env bash
# Download SGB (Serviço Geológico do Brasil / CPRM) susceptibility-map packages
# for Pedreiras and Trizidela do Vale from the RIGeo DSpace repository.
# Bitstream UUIDs were read from the public item pages:
#   https://rigeo.sgb.gov.br/items/d5867523-d0e7-4bcd-818d-fbcab110797a (Pedreiras, 2015, 1:80.000)
#   https://rigeo.sgb.gov.br/items/41a26de6-d4a4-4a81-bfa5-deb02fb854e0 (Trizidela do Vale, 2015, 1:30.000)
# Usage: scripts/fetch_sgb.sh [mde|sig|bc|img|pdf|all]   (default: mde sig)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=data/raw/sgb
mkdir -p "$OUT"
API=https://rigeo.sgb.gov.br/server/api/core/bitstreams

declare -A FILES=(
  [mde_pedreiras]=c175fc29-31c4-4a2d-b40d-2009da171cf8
  [sig_pedreiras]=6bcc1f61-05e0-41a6-8021-4361c69dcdd8
  [bc_pedreiras]=5dfe6524-70cb-4c22-a6a4-baf74a51377b
  [img_pedreiras]=13c34dea-3e52-46f0-84ba-ef9af90fba60
  [pdf_pedreiras]=afa48333-9ecd-496d-b198-fb573b98d53c
  [mde_trizidela]=4035c69a-1e0e-4d89-b02d-2c10aea1da0b
  [sig_trizidela]=47f1b5cb-ed69-4181-9440-6977244a5be6
  [bc_trizidela]=b499a130-6c74-40ba-b753-8597f249c3e3
  [img_trizidela]=d797712e-0517-43e6-8687-2f771ab88e40
  [pdf_trizidela]=1235260e-2862-45d9-b1b3-f5238346c34a
)

kinds=("$@")
[ ${#kinds[@]} -eq 0 ] && kinds=(mde sig)
[ "${kinds[0]}" = all ] && kinds=(mde sig bc img pdf)

for kind in "${kinds[@]}"; do
  for town in pedreiras trizidela; do
    key="${kind}_${town}"
    id="${FILES[$key]}"
    ext=zip; [ "$kind" = pdf ] && ext=pdf
    dest="$OUT/${key}.${ext}"
    if [ -s "$dest" ]; then echo "skip $dest"; continue; fi
    echo "download $key -> $dest"
    curl -fL --retry 3 --max-time 900 -o "$dest.part" "$API/$id/content"
    mv "$dest.part" "$dest"
  done
done

for z in "$OUT"/*.zip; do
  d="${z%.zip}"
  [ -d "$d" ] || { mkdir -p "$d"; unzip -q -o "$z" -d "$d"; }
done
ls -la "$OUT"
