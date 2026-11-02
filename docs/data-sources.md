# データソース調査・取得記録

対象窓: WGS84 `west -44.65 / south -4.61 / east -44.56 / north -4.53`（約 9 × 8.9 km）。
作業座標系: **EPSG:31983**（SIRGAS 2000 / UTM 23S、ブラジル公式 CRS・SGB データと同一）。
共通グリッド: **334 × 296 セル、30 m**（`public/data/manifest.json`）。

すべて**公開・無料・APIキー不要**。取得スクリプトは `scripts/`、生データは `data/raw/`（Git非管理）。

## DEM（標高モデル）— 3種を切替可能

| DEM | 種別 | 解像度 | 鉛直基準 | 取得 | ライセンス |
|---|---|---|---|---|---|
| Copernicus GLO-30 | **DSM**（樹木・建物を含む表面） | 30 m | EGM2008 | AWS COG（範囲リクエスト） | DLR/Airbus, ESA/EU ライセンス |
| FABDEM v1-2 | **DTM**（bare-earth、森林/建物バイアス除去） | 30 m | EGM2008 | HuggingFace COG | **CC BY-NC-SA 4.0（非商用のみ）** |
| SGB/Topodata MDE | **DTM**（SRTM 再処理, 2015） | 30 m | （SGB値に従う） | RIGeo DSpace ZIP | ブラジル政府公開データ |

- Copernicus タイル: `Copernicus_DSM_COG_10_S05_00_W045_00_DEM.tif`（EPSG:4326 COG）
  `scripts/fetch_dem.py` が bbox 部分のみ HTTP Range で取得 → EPSG:31983 に再投影
- 観測所位置でのDEM河川水面: **cop30 = 22.66 m**（元アプリ埋め込み値 22.46 m とほぼ一致 — 事実上同じソースと考えられる）、fabdem ≈ 22.64 m
- DEM ごとに「量水標ゼロの推定標高」が変わる（17.8–18.9 m、docs/flood-model.md 参照）

## SGB / CPRM（ブラジル地質調査所）洪水感受性マップ

- Pedreiras: `https://rigeo.sgb.gov.br/items/d5867523-d0e7-4bcd-818d-fbcab110797a`
- Trizidela do Vale: `https://rigeo.sgb.gov.br/items/41a26de6-d4a4-4a81-bfa5-deb02fb854e0`
- 2015 年成果。ZIP に MDE（Arc/Info GRID 形式）と SIG レイヤ（shapefile）を同梱
- `Inundacao_A.shp`（Pedreiras 1,303 ポリゴン / Trizidela 594、クラス 低/中/高）は
  CPRM が 2012–2014 にモデル+現地検証した洪水感受性 → **検証の独立参照**として使用（IoU 計算）
- 両市の MDE は同一範囲の 30 m UTM23S ラスタ（標高 15.3–161.6 m）→ 3 番目の DEM として `dem_sgb.f32` に採用

## ANA（国家水資源庁）観測データ — 水位の実データ

- 観測所: **33281000 Pedreiras II**（Rio Mearim、lat -4.57 / lon -44.6106、台帳標高 22 m、流域 24,000 km²、1978– 継続）
- `scripts/fetch_ana.py` が HidroWeb 系エンドポイントから日水位（cm）を取得
  - 年間最大 1978–2026（48年分）: 最高 **1985 = 10.10 m**、**2009 = 9.81 m**、2023 = 9.34 m、2024 = 7.45 m
  - 全期間中央値 2.44 m / TanDEM-X 取得期(2010-12〜2015-01)中央値 / SRTM 飛行期(2000-02)中央値を manifest に保存
- **重要な基準注意**: ANA水位は「量水標ゼロ」基準の相対値で、DEM標高と**直接比較できない**。
  換算（量水標ゼロの標高推定）は較正で求める（docs/flood-model.md）。台帳の標高 22 m は基準・精度不明のため不採用
- 観測所座標は丸め（lat -4.57）で河道から 287 m ずれる → 前処理で河道中心線へスナップし距離を記録

## OpenStreetMap（Overpass API）

- 建物 43、道路 ~954 区間、水系 50、POI 41（町・病院・学校等）
- 建物が極端に疎（43棟のみ）— 元アプリが「家屋は合成配置」と明記した理由と一致
- Overpass は 500/504/406 を返すことがあり、`scripts/fetch_osm.py` はクエリ分割 + エンドポイントフォールバックで対処

## Overture Maps / Google Open Buildings

- Overture STAC リリース 2026-09-23.1 の建物レイヤから bbox 交差パーティションのみ取得
- **21,285 フットプリント**（Google Open Buildings 21,242 + OSM 43）
- 高さ・階数属性なし → 表示は一律の低箱形。浸水判定はフットプリントの平面位置のみ使用
- ライセンス: ODbL（Overture コレクション）/ CDLA-Permissive（Google Open Buildings）

## 歴史的洪水記録（検証用・出典明記）

| イベント | 記録 | 出典 |
|---|---|---|
| 2009-05 | ANA 最高 9.81 m。Trizidela が「80–90% 被災/水没」、18,000人中 ~15,000人退避との報道。Folha は家屋被害 4,510/避難 3,643 | Folha, BBC, Gazeta do Povo |
| 2024-04-20 | ANA 最高 7.45 m。Pedreiras で避難世帯の報告 | G1 / O Imparcial |

これらは**広範な検証ポイント**としてのみ使用（棟数の正確なラベルではない）。

## 前処理で生成する共通レイヤ（`public/data/`、約 6 MB）

| ファイル | 内容 |
|---|---|
| `dem_{cop30,fabdem,sgb}.f32` | 標高 Float32 334×296 |
| `zref_hand_*.f32` / `zref_profile_*.f32` | HAND 基準水面 / 河川縦断プロファイル基準水面 |
| `channel.u8` `drainage.u8` | 河道中心線 / 排水網マスク |
| `town.u8` | 0=外 1=Pedreiras 2=Trizidela |
| `susc.u8` | SGB 感受性クラス（0=外,1=低,2=中,3=高,255=範囲外） |
| `buildings.json` `roads.json` `water.json` `pois.json` | ベクタ層 |
| `manifest.json` | グリッド・CRS・観測所・水位統計・出典の索引 |

## 取得時に失敗した経路（記録）

- ANA ArcGIS FeatureServer: `featureserver extension not found` → レガシー HidroWeb エンドポイントに切替
- Overpass: 大きな一括クエリが 500/504/406 → レイヤ別分割 + `overpass-api.de` フォールバックで成功
- Microsoft ML Building Footprints は本窓でのカバレッジ確認のうえ Overture を採用
