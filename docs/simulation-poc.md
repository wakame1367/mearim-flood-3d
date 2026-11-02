# 水理モデル出力リプレイ PoC — 先行事例調査と `simulation` シナリオ実装

2025-11-02。外部 2D 水理モデルの時系列出力をこのビューアで再生する PoC と、世界の先行事例調査の記録。

## 1. 先行事例（日本含まず・含む）

| 事例 | 形態 | 時系列 | 備考 |
|---|---|---|---|
| **Don Watch** (Fortitude Omnis, Sheffield River Don) | 静的 Next.js + Three.js (WebGPU/TSL) | 2019-11 洪水を実水位計データで時間再生 | **最も近い先行実装**。固定流域・レベル駆動の浸水、LIDAR 地形、リスク資産。「決定支援であり公式警報ではない」と明記。PWA/オフライン対応 |
| **GRADIS** (Tulane HydroInformatics Lab) | ブラウザ内 WebGPU 計算 + Three.js/Leaflet | リアルタイム動的シミュレーション | 計算自体をブラウザで回す研究系。PoC は重い |
| **USGS fim-js** | 地図ライブラリ | リアルタイム USGS 水位 → 浸水マップ | CC0。水位→浸水の既製ライブラリ |
| **GridVizA** (makinux, 日本) | Cesium + 時系列 GeoTIFF | **フレーム間線形補間つき再生** | 時系列ラスタ再生の直接的先行例。1時点=1 GeoTIFF |
| **HEC-RAS RAS Mapper / ras2cng / RAS Commander** | デスクトップ → クラウド変換 | 深度・流速・WSE の時系列エクスポート | HDF5 結果 → GeoTIFF/PMTiles/GeoParquet の公式経路 |
| **Deltares FloodAdapt** | SFINCS + Delft-FIAT | シナリオベース浸水・影響マップ | 「サイト固定 DB + シナリオ再生」が製品形態として一致 |
| **FloodMapp** (商用) | リアルタイム洪水予測 | NowCast/Forecast/PostCast の時間更新 | ゲージ駆動 + 道路・物件影響。商用の形態参考 |
| **Google Flood Hub / First Street** | 公開ポータル | 予測・履歴・リスク層 | 包絡ハザードと時系列を分けて提供 |
| **PLATEAU / MILT** (日本) | Re:Earth + Cesium | **時系列浸水深データ**を 3D 都市モデル上で再生 | 国交省が浸水想定区域図の作成過程で時系列浸水深を整備し、実証で使用 |
| **NILIM** (日本・国土技術政策総合研究所) | リアルタイム都市内水予測 | 10分間隔・1時間先まで | 降雨予測 + 下水道/河川モデル連携。ソース非公開 |
| **LISFLOOD-FP** | OSS 2D 水理モデル | `.wd` 水深・`.Vx/.Vy` 流速の時系列ラスタ | 本 PoC の入力データ源。ベンチマーク・実イベント出力が Zenodo 公開 |

**含意**: 「固定地域を切り出し、シナリオを時系列再生する」製品形態は Don Watch / FloodAdapt / PLATEAU 実証で既に確立。描画は Three.js で十分（Don Watch も同じ）。MapLibre/Cesium が要るのは「任意地点を地図上で触る」要件だけ。

## 2. 採用データ

- **LISFLOOD-FP 8.0 結果アーカイブ** (Zenodo `10.5281/zenodo.4661888`)
- **EA benchmark Test 4** (`ea4.zip`): 平坦な氾濫原への点源流入、5 h シミュレーション、1 h 間隔 6 フレーム
  - DEM 同梱（`ea4-5m.dem.gz`、200×400 セル @5 m = 1×2 km）
  - FV1/ACC/DG2 の 3 ソルバー出力 → FV1（全物理）を採用
  - 最大水深 0.52 m
- Néelz & Pender 2013「Benchmarking the latest generation of 2D hydraulic flood modelling packages」(UK Environment Agency) の標準テスト

**却下した候補**: `eden-resampled.zip`（最大水深のみで時系列なし）、`ea5-20m.zip`（31 フレームあるが実地形 DEM がアーカイブ外 — UK EA 個別配布のため未取得）、`alzette`（実地形 2021 Luxembourg 洪水・入力 71 MB — モデル実行が必要で次段階）。`ea4` は地形が平坦で見た目は地味だが、**実ソルバー出力・DEM 同梱・軽量**で PoC に最適だった。

## 3. 変換パイプライン

`scripts/pack_ea4.py` が ESRI ASCII (`.dem.gz` / `.wd`) をウェブ向けリージョンパックに変換:

```
public/regions/ea4/
  manifest.json   v2 (scenarios[] + gauge/stage=null)
  dem.f32         Float32 標高 (row0=north, Mearim パックと同じ並び)
  frames/d_NNNN.u16  深度 mm 量子化・u16 (80k セル = 160 KB/枚)
  channel/drainage/town/susc.u8, buildings/roads/water/pois.json  (空プレースホルダ)
```

リージョン追加は「新ディレクトリ + manifest v2 + 変換スクリプト」のみ。`REGIONS` テーブルに 1 行足すだけで UI に現れる（`?region=ea4`）。

## 4. manifest v2 とシナリオ型

```jsonc
"scenarios": [{
  "id": "ea4-fv1", "type": "simulation",
  "solver": "fv1", "dtSeconds": 3600, "timeBase": "relative",
  "unit": "mm", "maxDepth_m": 0.52,
  "frames": ["frames/d_0000.u16", ...],
  "note": "…出典・補間は物理状態でない旨…"
}]
```

3 型を想定: `replay`（観測ハイドログラフ × 既存モデル、実日時）、`simulation`（外部モデル出力フレーム列、実日時 or 相対時刻）、`envelope`（浸水想定区域など最大包絡、時間軸なし）。`gauge`/`stage`/`towns` を nullable/optional にして非河川地域も表現可能にした。

## 5. 描画実装

- `src/render/simwater.ts`: 頂点シェーダで `mix(aDepthA, aDepthB, uMix)` — **フレーム間は GPU 補間**。スクラブはユニフォーム更新のみ、隣接フレーム 2 枚だけ保持
- `src/core/dataset.ts`: `SimScenario` 型、`gauge|null` 対応
- `src/main.ts`: `?region=` でリージョン切替（ページ遷移で単純確実）、`setupSim()` が duck-typed Scenario で既存 `buildTerrain` を再利用、タイムライン UI（再生/停止・スクラバー・倍速・T+ 表示・浸水面積/最大水深のリアルタイム統計）
- Mearim 側 UI は `body.sim .mearim-only` で隠す — コード経路を分岐させず DOM 表示だけ切替

## 6. 検証結果

- `?region=ea4`: T+0 乾燥 → T+2.5（GPU 補間の中間状態、1.60 km²）→ T+5（2.00 km²、最大 0.15 m）を再生。コンソールエラーなし（`screenshots/ea4_t25.png`, `ea4_t5.png`）
- `/`（Mearim）: 全機能無退行（水位スライダー・プリセット・市街カード・チャート・ハイドログラフ再生）
- `tests/unit/sim-pack.test.ts` 5 件: manifest v2 構造・DEM/フレーム寸法・単位量子化・`maxDepth_m` 上限・空資産の整合性。全 28+5 テストパス

## 7. 限界と注意

- **EA4 の地形は全セル標高 0 m の完全平坦** — ベンチマークとしては正しいが、地形表現のデモには向かない。実地形は ea5/alzette/Eden の取り込みで対応可（パイプラインは同じ、フレームが大きくなるだけ）
- フレーム間補間は **視覚的平滑化** であり物理状態ではない — UI と note で明記済み
- 建物・道路・影響指標は ea4 パック未整備（プレースホルダ）。実地域では `impact` をフレーム毎に事前計算して `simulation` に添える設計を manifest v2 で許容（未実装）
- 速度場（`.Vx/.Vy`）は変換対象外。矢印/流れ表示は将来レイヤ
- `REGIONS` はハードコード — プロダクトではリージョンインデックス JSON（顧客ごとのシナリオ一覧）に置き換える想定

## 8. 次の一手候補

1. **実地形 + 多フレーム**: ea5 DEM を EA/SEAMLESS-WAVE から取得 or `alzette` を自前実行（GPU 有りなら ACC で数十分）→ 地形のある時系列リプレイ
2. **日本国内データ**: GSI DEM + 浸水想定区域（最大包絡 = `envelope` 型）or 時系列浸水深データ（自治体公表情報の変換）
3. `envelope`/`replay` 型の UI 実装（包絡は時間軸なしレイヤ、Mearim ハイドログラフは `replay` として manifest 化）
