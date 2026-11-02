# 元アプリ技術調査 — sael.net/mearim-flood

調査日: 2026-10。対象: https://sael.net/mearim-flood/ （タイトル: *"When the Mearim Rises: flood response for Pedreiras and Trizidela do Vale"*）

調査方法: Playwright によるページ取得・DOM/ネットワーク/グローバル変数・WebGL シェーダーの観測
（`analysis/probe-reference.mjs`, `analysis/probe-levels.mjs`。成果物は `analysis/reference/`）。

> **凡例**: **[事実]** = 開発者ツール/公開ソースで直接確認。**[推測]** = 観測結果からの合理的推定。
> 元アプリのソースコードはページ埋め込み（インライン module ~162 KB）で公開配送されているが、
> コンソールに「コード・外観・シーンはオリジナルであり再利用には明示的な許可と帰属が必要
> （https://x.com/RyanSael。エージェントにも同条件が適用される）」と明記されているため、
> 本プロジェクトでは**コードやアセットを一切複製せず**、観測した挙動と公開データのみを用いた。

## 1. フロントエンド構成 [事実]

| 項目 | 観測結果 |
|---|---|
| 3D ライブラリ | Three.js。`https://sael.net/lib/three-0.183.2.js` を直接 script タグで読込。`__THREE_LIB_VERSION` グローバルあり |
| 描画 API | **WebGL2** コンテキスト（WebGPU/Canvas2D 地形ではない）。WebGL canvas 1 個 + UI/オーバーレイ用 2D canvas 複数 |
| 地図ライブラリ | MapLibre / Cesium / Babylon 等の使用は**検出されず**。地形・建物・水面は自作 Three.js シーン |
| アプリ本体 | インライン `<script type="module">`（約 162 KB）+ importmap（blob 経由で three/examples を解決） |
| データ | `window.MF_DATA` に埋め込み。地形グリッド、施設、町、名称 + バイナリ blob を含む |
| その他 | Umami アナリティクス、Cloudflare beacon、作者署名スクリプト sael.js |

### 埋め込みデータメタ [事実]

- 中心: `latC ≈ -4.5712, lonC ≈ -44.6058`（両都市の間の Mearim 河道上）
- グリッド: `nx=220, nz=166`、セル約 `30.824 m` → 実効窓 ≈ **6.8 × 5.1 km**
- 参照河川水位 `riverZ = 22.46 m`（DEM 標高基準の河川水面と解釈可能）
- 量子化: `eStep=0.5 m`（標高）、`hStep=0.1 m`（比高/水深）→ 8bit 圧縮ラスタと推測

## 2. データソース [事実 — アプリ内表記]

元アプリの説明文（Lab パネル）による:

- 地形: **Copernicus 30 m 標高モデル**（DSM）。視覚的に **8× 高さ誇張**
- 道路・河川・支流・学校・病院: **OpenStreetMap**
- 建物: OSM に実在する建物は少数のみ。**家屋は人口密度に沿って道路沿いに合成的に配置した推定位置**であり、個別建物記録ではないと明記
- 「 flood-scenario / decision-support visualization であり水理モデルではない」旨明記

## 3. 浸水ロジック [事実 + 推測]

- **[事実]** HAND（Height Above Nearest Drainage）に基づく。「nearest drainage」への相対高さで浸水を判定すると説明文に記載
- **[事実]** 孤立した窪地が越流前に浸水しないよう、**連結 wet-path** フィルタがあると明記（本実装の priority-flood/connected モデルに相当）
- **[事実]** 水位スライダーは観測所水位（量水標）を動かす。フェーズ閾値の初期値:
  Alert 6 m / Mobilization 7 m / Critical 7.5 m / Extreme 8.5 m、Stabilization = クリティカル以上のピークから 0.25 m 低下
- **[事実]** 道路通行不能は水深 > 0.3 m、NO-GO（行動不能）水域は > 1 m
- **[推測]** GPU 上での流体計算は確認されず。シェーダー uniforms（`uH`, `uLevel`, `uGrid`, `uRMode`, `uNogo`, `uAlertH`, `uCut`, `uTime` 等）は**水位値と閾値を GPU に渡して着色・アニメーションする**構成で、浸水判定そのものは事前計算ラスタ（arrival/HAND）+ CPU と見られる。本実装と同じ分担
- **[推測]** `MF_DATA` のバイナリは 30 m グリッドの量子化標高 + HAND + ベクタをまとめた独自パック形式

### 観測した被害数値 [事実 — UI表示をプローブで記録]

| 観測所水位 | 浸水家屋 | 遮断道路 | アプリの文言 |
|---|---|---|---|
| 5.02 m | 0 | 0.0 km | 「河道内に留まる、警戒線の 1.0 m 下」 |
| 6.72 m | 71 | 0.2 km | Alert |
| 8.02 m | 527 | 3.8 km | Response |
| 8.18 m | 602 | 4.8 km | — |
| 8.31 m | 750 | 5.6 km | Response |
| 9.72 m（決壊+31.8 h） | 1,579 | 14.5 km | Stabilization |

家屋1棟 ≈ 3 人換算（"750 houses (about 2,250 people)"）。

## 4. シナリオ構成 [事実]

- **Seasonal flood**: 河川水位スライダー（量水標 m）
- **Flores dam breach**: 「決壊からの経過時間」スライダー。+31.8 h で 9.72 m 等、時間→水位の仮想カーブ。
  アプリ自身が「破堤解析が出るまでの**仮置き値**」と明記。物理的な破堤計算ではない
- レイヤー: City / Risk / Response（避難所・経路・NO-GO 等の応急対応情報）
- ビュー: Lab / Exploded / Studio（分析・分解・プレゼン用の演出プリセット）
- Calibration/Lab: 閾値（Alert 等）をユーザーが調整可能。JSON/リンク共有機能あり

## 5. 元アプリの限界（自己申告） [事実]

説明文より: 流速なし、河道-氾濫原間の交換なし、局所降雨なし、微細な壁・涵洞なし、
水理モデルではなくシナリオ可視化。決壊数値は仮置き。

## 6. 再現実装への示唆

| 元アプリ | 本PoCの対応 |
|---|---|
| HAND + 連結 wet-path | `computeArrival` priority-flood（`src/core/flood.ts`）+ HAND/profile/flat の基準水面切替 |
| Copernicus 30 m + 8× 誇張 | 同DEMを COG から直接取得、誇張スライダ 1–20×（既定6×） |
| OSM ベクタ | Overpass で道路/水系/POI を取得。同じく建物が疎なことを確認（43棟のみ） |
| 合成家屋 | 合成配置は避け、Overture/Google Open Buildings の実フットプリント 21,242 件を使用 |
| 量水標水位スライダー | ANA 33281000 の実測値でキャリブレーション。量水標ゼロ ↔ DEM 標高の換算を推定 |
| 決壊シナリオ（仮置き） | ハイドログラフ不在のため非実装とし、要件を docs/flood-model.md に整理 |
| 閾値 0.3 m / 1 m | 道路通行不能 >0.3 m を採用（`DEFAULT_THRESHOLDS`） |
