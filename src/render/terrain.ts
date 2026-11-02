import * as THREE from 'three';
import { cellX, cellY } from '../core/grid';
import type { Scenario } from '../core/scenario';

/**
 * Terrain and water meshes on the DEM grid (one vertex per cell centre).
 *
 * CPU: builds the geometry once per scenario (positions recomputed when the vertical exaggeration changes).
 * GPU: everything that depends on the river level is evaluated per vertex/fragment from the uniform
 *      `uRise`, so dragging the slider costs no geometry upload:
 *        flooded  <=> arrival < uRise        depth = uRise - hRel        WSE = zref + uRise
 */

export const COLOR_MODES = ['elevation', 'hand', 'arrival', 'susceptibility'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface TerrainUniforms {
  [k: string]: THREE.IUniform;
  uRise: { value: number };
  uExag: { value: number };
  uZBase: { value: number };
  uZMin: { value: number };
  uZMax: { value: number };
  uMode: { value: number };
  uContour: { value: number };
  uStageAtDem: { value: number };
  uTime: { value: number };
  uLightDir: { value: THREE.Vector3 };
  uShowFlood: { value: number };
}

const COMMON_GLSL = /* glsl */ `
  vec3 ramp(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    t = clamp(t, 0.0, 1.0);
    if (t < 0.333) return mix(a, b, t / 0.333);
    if (t < 0.666) return mix(b, c, (t - 0.333) / 0.333);
    return mix(c, d, (t - 0.666) / 0.334);
  }
`;

const TERRAIN_VS = /* glsl */ `
  attribute float aElev;
  attribute float aHRel;
  attribute float aArrival;
  attribute float aSusc;
  attribute float aChannel;
  varying float vElev;
  varying float vHRel;
  varying float vArrival;
  varying float vSusc;
  varying float vChannel;
  varying vec3 vNormal;
  void main() {
    vElev = aElev; vHRel = aHRel; vArrival = aArrival; vSusc = aSusc; vChannel = aChannel;
    vNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FS = /* glsl */ `
  uniform float uRise;
  uniform float uZMin;
  uniform float uZMax;
  uniform int uMode;
  uniform float uContour;
  uniform float uStageAtDem;
  uniform vec3 uLightDir;
  uniform float uShowFlood;
  varying float vElev;
  varying float vHRel;
  varying float vArrival;
  varying float vSusc;
  varying float vChannel;
  varying vec3 vNormal;
  ${COMMON_GLSL}
  void main() {
    vec3 col;
    if (uMode == 0) {            // hypsometric tint
      float t = (vElev - uZMin) / max(uZMax - uZMin, 1.0);
      col = ramp(pow(t, 0.7), vec3(0.20,0.42,0.30), vec3(0.55,0.65,0.35), vec3(0.80,0.72,0.48), vec3(0.62,0.45,0.35));
    } else if (uMode == 1) {     // height above the river reference (HAND-like), 0..20 m
      float t = clamp(vHRel / 20.0, 0.0, 1.0);
      col = ramp(t, vec3(0.80,0.15,0.15), vec3(0.95,0.55,0.15), vec3(0.95,0.90,0.45), vec3(0.35,0.60,0.35));
    } else if (uMode == 2) {     // gauge stage at which the cell floods (arrival + calibration), 4..12 m
      float st = vArrival + uStageAtDem;
      float t = clamp((st - 4.0) / 8.0, 0.0, 1.0);
      col = ramp(t, vec3(0.45,0.05,0.35), vec3(0.85,0.25,0.25), vec3(0.98,0.75,0.30), vec3(0.85,0.90,0.85));
    } else {                     // SGB/CPRM flood susceptibility classes
      int s = int(vSusc + 0.5);
      col = s == 3 ? vec3(0.85,0.20,0.20) : s == 2 ? vec3(0.96,0.60,0.20) : s == 1 ? vec3(0.98,0.90,0.45)
          : s == 0 ? vec3(0.70,0.78,0.66) : vec3(0.55,0.55,0.55);
    }
    vec3 n = normalize(vNormal);
    float diff = max(dot(n, normalize(uLightDir)), 0.0);
    col *= 0.45 + 0.65 * diff;
    if (uContour > 0.0) {        // contour lines on true elevation
      float f = vElev / uContour;
      float w = fwidth(f);
      float line = 1.0 - smoothstep(0.0, w * 1.2, abs(fract(f - 0.5) - 0.5));
      col = mix(col, col * 0.55, line * 0.8);
    }
    if (vChannel > 0.5) col = mix(col, vec3(0.15,0.30,0.40), 0.6);
    if (uShowFlood > 0.5 && vArrival < uRise) col *= 0.75;   // wet ground under the water
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const WATER_VS = /* glsl */ `
  attribute float aElev;
  attribute float aZRef;
  attribute float aHRel;
  attribute float aArrival;
  attribute float aChannel;
  uniform float uRise;
  uniform float uExag;
  uniform float uZBase;
  varying float vDepth;
  varying vec3 vWorld;
  void main() {
    bool wet = aArrival < uRise;
    float depth = wet ? uRise - aHRel : -0.5;
    float wse = aZRef + uRise;
    if (aChannel > 0.5) { depth = max(depth, 0.6); wse = max(wse, aElev + 0.3); }
    vDepth = depth;
    vec3 p = vec3(position.x, (wse - uZBase) * uExag + 0.15, position.z);
    vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const WATER_FS = /* glsl */ `
  uniform float uTime;
  uniform vec3 uLightDir;
  varying float vDepth;
  varying vec3 vWorld;
  void main() {
    if (vDepth <= 0.0) discard;
    float t = clamp(vDepth / 4.0, 0.0, 1.0);
    vec3 col = mix(vec3(0.55,0.85,0.95), vec3(0.05,0.22,0.50), t);
    // cheap animated ripples for the specular term only (purely visual)
    vec3 n = normalize(vec3(sin(vWorld.x * 0.05 + uTime) * 0.04, 1.0, cos(vWorld.z * 0.05 + uTime * 0.8) * 0.04));
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 h = normalize(normalize(uLightDir) + v);
    float spec = pow(max(dot(n, h), 0.0), 80.0) * 0.6;
    float edge = smoothstep(0.0, 0.25, vDepth);
    gl_FragColor = vec4(col + spec, mix(0.35, 0.82, edge));
    #include <colorspace_fragment>
  }
`;

export interface TerrainBundle {
  terrain: THREE.Mesh;
  water: THREE.Mesh;
  skirt: THREE.Mesh;
  uniforms: TerrainUniforms;
  setExaggeration(exag: number): void;
  heightAt(x: number, y: number): number; // world y at local point (for draping)
  dispose(): void;
}

export function buildTerrain(s: Scenario, uniforms: TerrainUniforms): TerrainBundle {
  const g = s.grid;
  const { nx, ny } = g;
  const n = nx * ny;
  const pos = new Float32Array(n * 3);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[3 * k] = cellX(g, i);
      pos[3 * k + 2] = -cellY(g, j); // three.js: -Z = north
    }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let q = 0;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.set([a, c, b, b, c, d], q);
      q += 6;
    }
  const susc = Float32Array.from(s.susc);
  const channel = Float32Array.from(s.channel);
  const arrival = Float32Array.from(s.arrival, (v) => (Number.isFinite(v) ? v : 1e6));

  const geo = new THREE.BufferGeometry();
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aElev', new THREE.BufferAttribute(s.z, 1));
  geo.setAttribute('aHRel', new THREE.BufferAttribute(s.hRel, 1));
  geo.setAttribute('aArrival', new THREE.BufferAttribute(arrival, 1));
  geo.setAttribute('aSusc', new THREE.BufferAttribute(susc, 1));
  geo.setAttribute('aChannel', new THREE.BufferAttribute(channel, 1));

  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setIndex(geo.index);
  waterGeo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  waterGeo.setAttribute('aElev', geo.getAttribute('aElev'));
  waterGeo.setAttribute('aZRef', new THREE.BufferAttribute(s.zref, 1));
  waterGeo.setAttribute('aHRel', geo.getAttribute('aHRel'));
  waterGeo.setAttribute('aArrival', geo.getAttribute('aArrival'));
  waterGeo.setAttribute('aChannel', geo.getAttribute('aChannel'));

  const terrainMat = new THREE.ShaderMaterial({ uniforms, vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS });
  const waterMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VS,
    fragmentShader: WATER_FS,
    transparent: true,
    depthWrite: false,
  });
  const terrain = new THREE.Mesh(geo, terrainMat);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.renderOrder = 2;
  water.frustumCulled = false;

  // side walls ("skirt") down to the base so the relief reads like a physical model
  const ring: number[] = [];
  for (let i = 0; i < nx; i++) ring.push(i);
  for (let j = 1; j < ny; j++) ring.push(j * nx + nx - 1);
  for (let i = nx - 2; i >= 0; i--) ring.push((ny - 1) * nx + i);
  for (let j = ny - 2; j > 0; j--) ring.push(j * nx);
  ring.push(0);
  const skirtPos = new Float32Array(ring.length * 6);
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.BufferAttribute(skirtPos, 3));
  const sIdx: number[] = [];
  for (let r = 0; r < ring.length - 1; r++) {
    const a = 2 * r;
    sIdx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  skirtGeo.setIndex(sIdx);
  const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshBasicMaterial({ color: 0x3b3326, side: THREE.DoubleSide }));

  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  let curExag = 1;
  const setExaggeration = (exag: number) => {
    curExag = exag;
    const zb = uniforms.uZBase.value;
    for (let k = 0; k < n; k++) pos[3 * k + 1] = (s.z[k] - zb) * exag;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    // analytic normals from central differences: n ~ (-exag dz/dx, 1, exag dz/dnorth)
    const c2 = 2 * g.cell;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const zx = (s.z[j * nx + Math.min(i + 1, nx - 1)] - s.z[j * nx + Math.max(i - 1, 0)]) / c2;
        const zn = (s.z[Math.max(j - 1, 0) * nx + i] - s.z[Math.min(j + 1, ny - 1) * nx + i]) / c2;
        const vx = -exag * zx;
        const vz = exag * zn;
        const l = Math.hypot(vx, 1, vz);
        nrm.array[3 * k] = vx / l;
        nrm.array[3 * k + 1] = 1 / l;
        nrm.array[3 * k + 2] = vz / l;
      }
    nrm.needsUpdate = true;
    const floor = -20;
    ring.forEach((k, r) => {
      skirtPos.set([pos[3 * k], pos[3 * k + 1], pos[3 * k + 2], pos[3 * k], floor, pos[3 * k + 2]], 6 * r);
    });
    (skirtGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    skirtGeo.computeBoundingSphere();
    uniforms.uExag.value = exag;
  };

  const heightAt = (x: number, y: number) => {
    const fx = (x + nx * g.cell * 0.5) / g.cell - 0.5;
    const fy = (ny * g.cell * 0.5 - y) / g.cell - 0.5;
    const i0 = Math.min(Math.max(Math.floor(fx), 0), nx - 2);
    const j0 = Math.min(Math.max(Math.floor(fy), 0), ny - 2);
    const tx = Math.min(Math.max(fx - i0, 0), 1);
    const ty = Math.min(Math.max(fy - j0, 0), 1);
    const k = j0 * nx + i0;
    const z = s.z[k] * (1 - tx) * (1 - ty) + s.z[k + 1] * tx * (1 - ty) + s.z[k + nx] * (1 - tx) * ty + s.z[k + nx + 1] * tx * ty;
    return (z - uniforms.uZBase.value) * curExag;
  };

  return {
    terrain,
    water,
    skirt,
    uniforms,
    setExaggeration,
    heightAt,
    dispose() {
      geo.dispose();
      waterGeo.dispose();
      skirtGeo.dispose();
      terrainMat.dispose();
      waterMat.dispose();
      (skirt.material as THREE.Material).dispose();
    },
  };
}
