# アーキテクチャ

## 全体像

```
公開データ ──取得──> data/raw ──preprocess.py──> public/data ──HTTP──> ブラウザ
  (SGB/ANA/OSM/                                    (共通30mグリッド)
   Copernicus/Overture)                                  │
                                                  src/core/*: 浸水計算 (CPU)
                                                  src/render/*: Three.js (GPU)
                                                  src/main.ts: UI/状態
```

## フロントエンド構成

依存は **Three.js のみ**（Vite + TypeScript、フレームワーク不使用）。
元アプリが素の Three.js で実装されていたのと同様、直接シーンを組む方式を採用。

| モジュール | 責務 | CPU/GPU |
|---|---|---|
| `src/core/dataset.ts` | `public/data` の f32/u8/json 読込、Dataset 型 | CPU |
| `src/core/grid.ts` | セル索引・座標変換・近傍・粗視化(coarsen) | CPU |
| `src/core/flood.ts` | **arrival 計算**: priority-flood(connected) / 単純閾値(bathtub)、hRel | CPU |
| `src/core/impact.ts` | 建物・道路の露出前計算 + 水位→指標のルックアップ(ImpactIndex) | CPU |
| `src/core/calibration.ts` | 量水標水位 ↔ DEM上昇量の換算 | CPU |
| `src/core/records.ts` | 2024記録への較正、2009検証 | CPU |
| `src/core/scenario.ts` | DEM/基準水面/モデル/粗視化を束ねて再計算 | CPU |
| `src/render/terrain.ts` | 地形メッシュ + 水面メッシュ + シェーダ(段彩/等高線/HAND/到達水位/感受性) | GPU |
| `src/render/assets.ts` | 建物 InstancedMesh + 道路ライン + 冠水着色 | GPU(着色はCPU側属性) |
| `src/ui/chart.ts` | 水位-被害曲線 canvas | CPU(2D) |
| `src/main.ts` | 状態管理・UI配線・カメラ・ラベル・ピック | — |

## CPU / GPU の分担（重要）

- **CPU がやること**: arrival（浸水開始水位）ラスタを**一度だけ**前計算
  （priority-flood は O(n log n) の binary-heap Dijkstra 的処理、334×296 で ~数十 ms）。
  スライダー操作時は `rise` との**比較だけ**で浸水判定が済むため再計算不要。
  建物・道路はシナリオ構築時にセルへ割付け、閾値到達水位を持つのでこちらも O(1) 参照。
- **GPU がやること**: 地形/水面メッシュの描画、シェーダによる段彩・等高線・HAND色分け・
  水面アニメーション（`uRise`, `uStageAtDem`, `uExag`, `uMode`, `uTime` 等の uniform）。
- **やらないこと**: GPU 上の流体ソルバー（元アプリにもその証拠はなかった）。

この「重い浸水計算は起動時に1回、水位変更は uniform 更新だけ」という分担は
スライダーの即応答の鍵。元アプリも同型と推測される（uniform 名が水位/閾値受渡し型）。

## データフロー詳細

```
manifest.json (索引: グリッド/CRS/観測所/水位統計/出典)
dem_*.f32          → z (地盤標高)
zref_hand_*.f32    → zref (HAND: 各セルの排水先河道水位)
zref_profile_*.f32 → zref (河川縦断の最近傍水位)
channel.u8         → 河道種子セル
town.u8/susc.u8    → 都市別集計 / SGB感受性比較
buildings/roads    → セル割付 + 閾値ラスタ
       │
       ▼ Scenario(dem, ref, model, coarsen, stageAtDem)
hRel = z - zref               (比高, HAND的相対高さ)
arrival[k] = セルkが浸水を始める「上昇量」  … connected: priority-flood / bathtub: max(hRel,0)
       │
       ▼ rise = stage - stageAtDem  (量水標水位 → DEM水面からの上昇量)
wet[k] = arrival[k] < rise    → 水面メッシュ頂点・建物/道路色・指標
```

## 較正（量水標ゼロ ↔ DEM標高）

`calibration.stageAtDem` = 「DEM が観測した時点の水面」に相当する量水標水位。
`rise = stage - stageAtDem` が DEM 水面からの実上昇量。

- `record`: 2024-04-20 (7.46 m) の洪水で Pedreiras 浸水棟数が報告避難世帯数と一致するよう逆算
- `epoch`: DEM 取得期間の ANA 中央値（TanDEM-X 2011–14 / SRTM 2000-02）
- `manual`: 手動

## スケーラビリティ

- 334×296 セル = 98,864 セル。全データ f32/u8 で ~6 MB、圧縮・タイル化不要
- `coarsen` で 60/90/120 m へ平均縮退 → 低スペック環境向け
- 建物は InstancedMesh（21k インスタンスを1 draw call）
