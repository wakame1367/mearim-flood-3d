import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { gaugeZeroElevation, wseAtGauge } from './core/calibration';
import { fetchIO, loadDataset, type Dataset } from './core/dataset';
import type { FloodModel } from './core/flood';
import { cellIndexAt } from './core/grid';
import { DEFAULT_THRESHOLDS } from './core/impact';
import { calibrateToRecord, FLOOD_RECORDS } from './core/records';
import { defaultStageAtDem, Scenario, type RefSurface } from './core/scenario';
import { buildAssets, type AssetsBundle } from './render/assets';
import { buildTerrain, COLOR_MODES, type ColorMode, type TerrainBundle, type TerrainUniforms } from './render/terrain';
import { drawImpactChart } from './ui/chart';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 2) => v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });

type CalMode = 'record' | 'epoch' | 'manual';
const state = {
  stage: 7.45,
  dem: 'cop30',
  ref: 'hand' as RefSurface,
  model: 'connected' as FloodModel,
  coarsen: 1,
  calMode: 'record' as CalMode,
  calManual: 4,
  exag: 6,
  colorMode: 'elevation' as ColorMode,
  contour: 1,
};

// ------------------------------------------------------------------ renderer / scene
const container = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1018);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 20, 80000);
camera.position.set(-1500, 5500, 7000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 150;
controls.maxDistance = 30000;
controls.keyPanSpeed = 40;
controls.listenToKeyEvents(window);

const uniforms: TerrainUniforms = {
  uRise: { value: 0 },
  uExag: { value: state.exag },
  uZBase: { value: 15 },
  uZMin: { value: 20 },
  uZMax: { value: 130 },
  uMode: { value: 0 },
  uContour: { value: 1 },
  uStageAtDem: { value: 4 },
  uTime: { value: 0 },
  uLightDir: { value: new THREE.Vector3(-0.5, 0.8, -0.35).normalize() },
  uShowFlood: { value: 1 },
};

let ds: Dataset;
let scn: Scenario;
let terrain: TerrainBundle | null = null;
let assets: AssetsBundle | null = null;
let rebuilds = 0;

// ------------------------------------------------------------------ scenario
function computeCalibration(): number {
  if (state.calMode === 'manual') return state.calManual;
  if (state.calMode === 'epoch') return defaultStageAtDem(ds, state.dem);
  return calibrateToRecord(scn, FLOOD_RECORDS[0]) ?? defaultStageAtDem(ds, state.dem);
}

function rebuildScenario() {
  scn = new Scenario(ds, {
    dem: state.dem,
    ref: state.ref,
    model: state.model,
    coarsen: state.coarsen,
    stageAtDem: 0,
    thresholds: DEFAULT_THRESHOLDS,
  });
  const meta = ds.manifest.dems[state.dem];
  uniforms.uZMin.value = meta.zMin;
  uniforms.uZMax.value = meta.zMax;
  if (terrain) {
    scene.remove(terrain.terrain, terrain.water, terrain.skirt);
    terrain.dispose();
  }
  if (assets) {
    scene.remove(assets.buildings, assets.roads);
    assets.dispose();
  }
  terrain = buildTerrain(scn, uniforms);
  assets = buildAssets(scn, uniforms);
  applyExaggeration();
  scene.add(terrain.terrain, terrain.water, terrain.skirt, assets.buildings, assets.roads);
  applyVisibility();
  rebuilds++;
  updateCalibration();
}

function applyExaggeration() {
  if (!terrain || !assets) return;
  terrain.setExaggeration(state.exag);
  assets.setExaggeration(state.exag, terrain.heightAt);
  $('exagVal').textContent = `${state.exag}×`;
  placeLabels();
}

function applyVisibility() {
  if (!terrain || !assets) return;
  assets.buildings.visible = $<HTMLInputElement>('showBuildings').checked;
  assets.roads.visible = $<HTMLInputElement>('showRoads').checked;
  terrain.water.visible = $<HTMLInputElement>('showWater').checked;
  uniforms.uShowFlood.value = terrain.water.visible ? 1 : 0;
  $('labels').style.display = $<HTMLInputElement>('showLabels').checked ? '' : 'none';
}

function updateCalibration() {
  const cal = computeCalibration();
  scn.calibration.stageAtDem = cal;
  uniforms.uStageAtDem.value = cal;
  const slider = $<HTMLInputElement>('calManual');
  slider.value = String(cal);
  slider.disabled = state.calMode !== 'manual';
  $('calVal').textContent = `${fmt(cal)} m`;
  const m = ds.manifest;
  const z0 = gaugeZeroElevation(scn.calibration);
  const notes: Record<CalMode, string> = {
    record: `2024-04-20 の洪水 (水位 7.46 m) で Pedreiras の浸水建物数がDefesa Civil報告の避難世帯数 ${FLOOD_RECORDS[0].households} に一致するよう逆算。`,
    epoch:
      state.dem === 'sgb'
        ? `SRTM 観測日 (2000-02-11〜22) のANA水位中央値 ${m.stage?.srtm_feb2000?.median} m をDEM水面とみなす。`
        : `TanDEM-X 観測期間 (2010-12〜2015-01) のANA水位中央値 ${m.stage?.tandemx_2011_2014?.median} m をDEM水面とみなす (取得日不明のため不確か)。`,
    manual: '手動設定。',
  };
  $('calNote').textContent =
    `${notes[state.calMode]} → 量水標ゼロの推定標高 ${fmt(z0)} m (DEM鉛直基準)。` +
    ` 参考: ANA台帳の標高 ${m.gauge.anaInventoryAltitude} m は基準・精度不明のため未使用。`;
  updateStage();
  updateInfo();
}

// ------------------------------------------------------------------ stage / stats
function townCard(t: 1 | 2) {
  const r = scn.rise(state.stage);
  const s = scn.impact.at(r, t);
  const name = t === 1 ? 'Pedreiras (東岸)' : 'Trizidela do Vale (西岸)';
  return `<h3>${name}</h3>
    <div class="big" data-testid="bld${t}">${s.buildings.toLocaleString('ja-JP')} <small>棟</small></div>
    <div class="kv"><span>浸水建物/全建物</span><b>${fmt((100 * s.buildings) / Math.max(1, s.buildingsTotal), 1)}%</b>
    <span>浸水面積</span><b>${fmt(s.floodedAreaKm2)} km²</b>
    <span>冠水道路</span><b>${fmt(s.roadsWetKm, 1)} km</b>
    <span>通行不能 (&gt;${DEFAULT_THRESHOLDS.roadCut} m)</span><b>${fmt(s.roadsCutKm, 1)} km</b></div>`;
}

let marks: { stage: number; label: string }[] = [];

function updateStage() {
  const rise = scn.rise(state.stage);
  uniforms.uRise.value = rise;
  $('stageVal').textContent = `${fmt(state.stage)} m`;
  $<HTMLInputElement>('stage').value = String(state.stage);
  $('wseVal').textContent = `${fmt(wseAtGauge(scn.calibration, state.stage))} m`;
  $('riseVal').textContent = `${rise >= 0 ? '+' : ''}${fmt(rise)} m`;
  $('town1').innerHTML = townCard(1);
  $('town2').innerHTML = townCard(2);
  document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((b) => {
    b.classList.toggle('active', Math.abs(Number(b.dataset.stage) - state.stage) < 0.005);
  });
  drawImpactChart($<HTMLCanvasElement>('chart'), scn, state.stage, marks);
  const first = (t: number, n: number) => {
    const r = scn.impact.firstRiseWithBuildings(t, n);
    return r === null ? '—' : `${fmt(r + scn.calibration.stageAtDem)} m`;
  };
  $('orderNote').innerHTML =
    `浸水開始 (10棟): <span style="color:var(--ped)">Pedreiras ${first(1, 10)}</span> / <span style="color:var(--tri)">Trizidela ${first(2, 10)}</span>` +
    ` ・100棟: <span style="color:var(--ped)">${first(1, 100)}</span> / <span style="color:var(--tri)">${first(2, 100)}</span>`;
}

function updateInfo() {
  const m = ds.manifest;
  const dm = m.dems[state.dem];
  const g = scn.grid;
  const srcCount = ds.buildings.reduce<Record<string, number>>((a, b) => ((a[b.s] = (a[b.s] ?? 0) + 1), a), {});
  const rows: [string, string][] = [
    ['DEM', m.demLabels[state.dem] ?? state.dem],
    ['グリッド', `${g.nx} × ${g.ny} セル, ${g.cell} m (${((g.nx * g.cell) / 1000).toFixed(1)} × ${((g.ny * g.cell) / 1000).toFixed(1)} km)`],
    ['座標系', `${m.crs} (SIRGAS 2000 / UTM 23S)`],
    ['標高範囲', `${fmt(dm.zMin, 1)} – ${fmt(dm.zMax, 1)} m`],
    ['観測所での河川水面 (DEM)', `${fmt(dm.riverZAtGauge)} m`],
    ['河川縦断勾配 (窓内)', `${fmt(dm.riverDrop)} m / ${fmt(dm.riverLength / 1000, 1)} km`],
    ['観測所位置の補正', `ANA座標→河道中心線へ ${fmt(m.gauge.snapDistance, 0)} m`],
    ['建物', `${ds.buildings.length.toLocaleString()} (Google ${srcCount.G ?? 0}, OSM ${srcCount.O ?? 0})`],
    ['道路区間', `${scn.roads.count.toLocaleString()} 区間 (≤${g.cell / 2} m)`],
    ['シナリオ計算 (CPU)', `${scn.computeMs.toFixed(0)} ms`],
    ['描画三角形', `${renderer.info.render.triangles.toLocaleString()}`],
    ['FPS', `<span id="fps">–</span>`],
  ];
  $('info').innerHTML = rows.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
}

function updateLegend() {
  const mode = state.colorMode;
  const sw = (c: string, t: string) => `<span class="sw" style="background:${c}"></span>${t}`;
  const terrainLegend: Record<ColorMode, string> = {
    elevation: `地形: 段彩 ${fmt(ds.manifest.dems[state.dem].zMin, 0)}→${fmt(ds.manifest.dems[state.dem].zMax, 0)} m`,
    hand: `比高: ${sw('#cc2626', '0 m')}${sw('#f28c26', '7')}${sw('#f2e673', '13')}${sw('#59995a', '≥20 m')}`,
    arrival: `浸水開始水位: ${sw('#730d59', '≤4 m')}${sw('#d94040', '6.7')}${sw('#fabf4d', '9.3')}${sw('#d9e6d9', '≥12 m')}`,
    susceptibility: `SGB感受性: ${sw('#d93333', '高')}${sw('#f5991a', '中')}${sw('#fae673', '低')}${sw('#b3c7a8', '対象外')}${sw('#8c8c8c', '範囲外')}`,
  };
  $('legend').innerHTML =
    `<div>${terrainLegend[mode]}</div>` +
    `<div>建物: ${sw('#eee8dc', '非浸水')}${sw('#ff8c73', '浸水')}${sw('#cc1426', '深い')}</div>` +
    `<div>道路: ${sw('#faf7eb', '通行可')}${sw('#ffa61a', '冠水')}${sw('#f21a33', '通行不能')}${sw('#8cf2ff', '橋')}</div>` +
    `<div>水深: ${sw('#8cd9f2', '浅')}${sw('#0d3880', '≥4 m')}</div>`;
}

// ------------------------------------------------------------------ labels / views
interface Label {
  el: HTMLDivElement;
  x: number;
  y: number;
  world: THREE.Vector3;
}
let labels: Label[] = [];

function makeLabels() {
  const host = $('labels');
  host.innerHTML = '';
  labels = [];
  const add = (text: string, cls: string, x: number, y: number) => {
    const el = document.createElement('div');
    el.className = `label ${cls}`;
    el.textContent = text;
    host.appendChild(el);
    labels.push({ el, x, y, world: new THREE.Vector3() });
  };
  for (const p of ds.pois) {
    if (p.k === 'town') add(p.n ?? '', p.n === 'Pedreiras' ? 'town1' : 'town2', p.x, p.y);
    if (p.k === 'hospital') add(`✚ ${p.n ?? 'hospital'}`, 'poi', p.x, p.y);
  }
  add(`観測所 ${ds.manifest.gauge.name}`, 'gauge', ds.manifest.gauge.x, ds.manifest.gauge.y);
  placeLabels();
}

function placeLabels() {
  if (!terrain) return;
  for (const l of labels) l.world.set(l.x, terrain.heightAt(l.x, l.y) + 30, -l.y);
}

const tmp = new THREE.Vector3();
function updateLabels() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const l of labels) {
    tmp.copy(l.world).project(camera);
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    l.el.style.display = vis ? '' : 'none';
    if (vis) l.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -120%)`;
  }
}

let camTween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t0: number } | null = null;
function setView(name: string) {
  if (!terrain) return;
  const poi = (n: string) => ds.pois.find((p) => p.k === 'town' && p.n === n)!;
  const at = (x: number, y: number) => new THREE.Vector3(x, terrain!.heightAt(x, y), -y);
  let target: THREE.Vector3;
  let offset: THREE.Vector3;
  const g = ds.manifest.gauge;
  switch (name) {
    case 'pedreiras': {
      const p = poi('Pedreiras');
      target = at(p.x, p.y);
      offset = new THREE.Vector3(700, 1100, 1500);
      break;
    }
    case 'trizidela': {
      const p = poi('Trizidela do Vale');
      target = at(p.x - 300, p.y - 300);
      offset = new THREE.Vector3(-900, 1100, 1400);
      break;
    }
    case 'gauge':
      target = at(g.x, g.y);
      offset = new THREE.Vector3(400, 500, 700);
      break;
    case 'profile':
      target = at(g.x, g.y);
      offset = new THREE.Vector3(0, 120 + state.exag * 15, 2600);
      break;
    default:
      target = new THREE.Vector3(0, 100, 0);
      offset = new THREE.Vector3(-1500, 5400, 6800);
  }
  camTween = { from: camera.position.clone(), to: target.clone().add(offset), tFrom: controls.target.clone(), tTo: target, t0: performance.now() };
}

// ------------------------------------------------------------------ picking
const raycaster = new THREE.Raycaster();
let downAt: [number, number] | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !terrain) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(terrain.terrain)[0];
  const box = $('pick');
  if (!hit) return box.classList.add('hidden');
  const x = hit.point.x;
  const y = -hit.point.z;
  const k = cellIndexAt(scn.grid, x, y);
  if (k < 0) return;
  const rise = scn.rise(state.stage);
  const wet = scn.arrival[k] < rise;
  const susc = ['対象外', '低', '中', '高'][scn.susc[k]] ?? '範囲外';
  const town = ['範囲外', 'Pedreiras', 'Trizidela do Vale'][scn.town[k]];
  box.classList.remove('hidden');
  box.innerHTML = `<b>地点情報</b> <span class="muted">(${x.toFixed(0)}, ${y.toFixed(0)}) m</span>
    <div class="kv small">
    <span>地盤標高 (DEM)</span><b>${fmt(scn.z[k])} m</b>
    <span>基準河川水面</span><b>${fmt(scn.zref[k])} m</b>
    <span>比高 (HAND等)</span><b>${fmt(scn.hRel[k])} m</b>
    <span>浸水開始水位</span><b>${scn.channel[k] ? '河道' : `${fmt(scn.arrival[k] + scn.calibration.stageAtDem)} m`}</b>
    <span>現在の水深</span><b>${wet ? fmt(Math.max(rise - scn.hRel[k], 0)) + ' m' : '—'}</b>
    <span>行政区</span><b>${town}</b><span>SGB感受性</span><b>${susc}</b></div>`;
});

// ------------------------------------------------------------------ UI wiring
function bindUI() {
  const m = ds.manifest;
  const am = m.stage?.annual_max ?? {};
  const presets: [string, number][] = [
    [`平水 中央値`, m.stage?.all.median ?? 2.44],
    ['警戒目安 6 m', 6],
    ...['2024', '2023', '2009', '1985'].filter((y) => am[y]).map((y) => [`${y} 最高`, am[y].stage_m] as [string, number]),
  ];
  marks = ['2024', '2009'].filter((y) => am[y]).map((y) => ({ stage: am[y].stage_m, label: y }));
  $('presets').innerHTML = presets.map(([l, v]) => `<button data-stage="${v}">${l} ${fmt(v)}m</button>`).join('');
  $('presets').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) {
      state.stage = Number(b.dataset.stage);
      updateStage();
    }
  });
  $<HTMLInputElement>('stage').addEventListener('input', (e) => {
    state.stage = Number((e.target as HTMLInputElement).value);
    updateStage();
  });
  const demSel = $<HTMLSelectElement>('dem');
  demSel.innerHTML = Object.keys(m.dems).map((k) => `<option value="${k}">${k === 'cop30' ? 'Copernicus GLO-30 (DSM)' : k === 'fabdem' ? 'FABDEM (bare-earth)' : 'SGB/Topodata (SRTM)'}</option>`).join('');
  const onSel = (id: string, fn: (v: string) => void) => $<HTMLSelectElement>(id).addEventListener('change', (e) => fn((e.target as HTMLSelectElement).value));
  onSel('dem', (v) => ((state.dem = v), rebuildScenario(), updateLegend()));
  onSel('coarsen', (v) => ((state.coarsen = Number(v)), rebuildScenario()));
  onSel('model', (v) => ((state.model = v as FloodModel), rebuildScenario()));
  onSel('ref', (v) => ((state.ref = v as RefSurface), rebuildScenario()));
  onSel('calMode', (v) => ((state.calMode = v as CalMode), updateCalibration()));
  onSel('colorMode', (v) => {
    state.colorMode = v as ColorMode;
    uniforms.uMode.value = COLOR_MODES.indexOf(state.colorMode);
    updateLegend();
  });
  onSel('contour', (v) => (uniforms.uContour.value = state.contour = Number(v)));
  $<HTMLInputElement>('calManual').addEventListener('input', (e) => {
    state.calManual = Number((e.target as HTMLInputElement).value);
    updateCalibration();
  });
  $<HTMLInputElement>('exag').addEventListener('input', (e) => {
    state.exag = Number((e.target as HTMLInputElement).value);
    applyExaggeration();
  });
  for (const id of ['showBuildings', 'showRoads', 'showWater', 'showLabels']) $(id).addEventListener('change', applyVisibility);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view!)));

  // observed hydrograph replay (ANA daily stages through the static model)
  const events = m.stage?.events ?? {};
  $<HTMLSelectElement>('eventSel').innerHTML = Object.keys(events).map((y) => `<option value="${y}">${y} (ANA日水位)</option>`).join('');
  let timer: number | null = null;
  $('playBtn').addEventListener('click', () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      $('playBtn').textContent = '▶ 観測ハイドログラフ再生';
      return;
    }
    const series = events[$<HTMLSelectElement>('eventSel').value] ?? [];
    let i = 0;
    $('playBtn').textContent = '■ 停止';
    timer = window.setInterval(() => {
      if (i >= series.length) {
        clearInterval(timer!);
        timer = null;
        $('playBtn').textContent = '▶ 観測ハイドログラフ再生';
        return;
      }
      const [d, st] = series[i++];
      state.stage = st;
      $('eventDate').textContent = d;
      updateStage();
    }, 120);
  });
}

// ------------------------------------------------------------------ loop
let frames = 0;
let lastFps = performance.now();
let fps = 0;
function animate(t: number) {
  requestAnimationFrame(animate);
  uniforms.uTime.value = t / 1000;
  if (camTween) {
    const k = Math.min(1, (t - camTween.t0) / 900);
    const e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(camTween.from, camTween.to, e);
    controls.target.lerpVectors(camTween.tFrom, camTween.tTo, e);
    if (k >= 1) camTween = null;
  }
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
  frames++;
  if (t - lastFps > 1000) {
    fps = (frames * 1000) / (t - lastFps);
    frames = 0;
    lastFps = t;
    const el = document.getElementById('fps');
    if (el) el.textContent = fps.toFixed(0);
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------ boot
async function main() {
  ds = await loadDataset(fetchIO());
  uniforms.uZBase.value = Math.floor(Math.min(...Object.values(ds.manifest.dems).map((d) => d.zMin))) - 2;
  bindUI();
  rebuildScenario();
  makeLabels();
  updateLegend();
  setView('overview');
  camTween = null;
  camera.position.set(-1500, 5400, 6800);
  controls.target.set(0, 100, 0);
  $('loading').classList.add('done');
  requestAnimationFrame(animate);
  setTimeout(updateInfo, 500);
  // test / automation hook
  Object.assign(window, {
    __app: {
      ready: true,
      state,
      get rebuilds() {
        return rebuilds;
      },
      get fps() {
        return fps;
      },
      setStage(v: number) {
        state.stage = v;
        updateStage();
      },
      setView,
      stats() {
        const r = scn.rise(state.stage);
        return { rise: r, stageAtDem: scn.calibration.stageAtDem, uRise: uniforms.uRise.value, t1: scn.impact.at(r, 1), t2: scn.impact.at(r, 2) };
      },
    },
  });
}

main().catch((e) => {
  $('loading').textContent = `読込エラー: ${e.message} — scripts/ のデータ取得・前処理を実行してください (README参照)`;
  console.error(e);
});
