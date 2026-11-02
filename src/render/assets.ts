import * as THREE from 'three';
import type { Scenario } from '../core/scenario';

/**
 * Buildings (extruded footprints) and roads (draped line segments).
 * Flood state is evaluated in the shaders from per-vertex "rise needed" attributes and the shared
 * uniform uRise; the CPU only rebuilds geometry when the scenario or the exaggeration changes.
 */

export const BUILDING_DEFAULT_HEIGHT = 4; // m, Google Open Buildings has no heights here
export const BUILDING_VSCALE = 2; // buildings drawn 2x taller than true scale for legibility

const BUILDING_VS = /* glsl */ `
  attribute float aRise;
  attribute float aHMin;
  varying float vRise;
  varying float vHMin;
  varying vec3 vWorld;
  void main() {
    vRise = aRise; vHMin = aHMin;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;
const BUILDING_FS = /* glsl */ `
  uniform float uRise;
  uniform vec3 uLightDir;
  varying float vRise;
  varying float vHMin;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec3 col = vec3(0.93, 0.91, 0.86);
    if (uRise > vRise) {
      float d = clamp((uRise - vHMin) / 2.0, 0.0, 1.0);   // approx. water depth at the building
      col = mix(vec3(1.0, 0.55, 0.45), vec3(0.80, 0.08, 0.15), d);
    }
    float diff = abs(dot(n, normalize(uLightDir)));
    col *= 0.55 + 0.5 * diff;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const ROAD_VS = /* glsl */ `
  attribute float aWet;
  attribute float aCut;
  attribute float aBridge;
  varying float vWet;
  varying float vCut;
  varying float vBridge;
  void main() {
    vWet = aWet; vCut = aCut; vBridge = aBridge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ROAD_FS = /* glsl */ `
  uniform float uRise;
  varying float vWet;
  varying float vCut;
  varying float vBridge;
  void main() {
    vec3 col = vec3(0.98, 0.97, 0.92);
    if (vBridge > 0.5) col = vec3(0.55, 0.95, 1.0);
    else if (uRise > vCut) col = vec3(0.95, 0.10, 0.20);        // impassable (> cut threshold)
    else if (uRise > vWet) col = vec3(1.0, 0.65, 0.10);         // shallow water on the road
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface AssetsBundle {
  buildings: THREE.Mesh;
  roads: THREE.LineSegments;
  setExaggeration(exag: number, heightAt: (x: number, y: number) => number): void;
  dispose(): void;
}

const finite = (v: number) => (Number.isFinite(v) ? v : 1e6);

export function buildAssets(s: Scenario, uniforms: Record<string, THREE.IUniform>): AssetsBundle {
  const b = s.buildings;
  const e = s.exposure;
  // ---- buildings: triangulate once (local x/y), positions recomputed per exaggeration
  type Piece = { tri: number[]; ring: number[] };
  const pieces: Piece[] = [];
  let vCount = 0;
  for (let i = 0; i < b.count; i++) {
    const pts: THREE.Vector2[] = [];
    for (let p = b.offsets[i]; p < b.offsets[i + 1]; p++) pts.push(new THREE.Vector2(b.coords[2 * p], b.coords[2 * p + 1]));
    if (pts.length < 3) {
      pieces.push({ tri: [], ring: [] });
      continue;
    }
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
    const tri = THREE.ShapeUtils.triangulateShape(pts, []).flat();
    const ring = pts.flatMap((v) => [v.x, v.y]);
    pieces.push({ tri, ring });
    vCount += tri.length + pts.length * 6;
  }
  const bPos = new Float32Array(vCount * 3);
  const bRise = new Float32Array(vCount);
  const bHMin = new Float32Array(vCount);
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
  bGeo.setAttribute('aRise', new THREE.BufferAttribute(bRise, 1));
  bGeo.setAttribute('aHMin', new THREE.BufferAttribute(bHMin, 1));
  {
    let v = 0;
    pieces.forEach((pc, i) => {
      const n = pc.tri.length + (pc.ring.length / 2) * 6;
      bRise.fill(finite(e.buildingRise[i]), v, v + n);
      bHMin.fill(e.buildingHMin[i], v, v + n);
      v += n;
    });
  }
  const bMat = new THREE.ShaderMaterial({ uniforms, vertexShader: BUILDING_VS, fragmentShader: BUILDING_FS });
  const buildings = new THREE.Mesh(bGeo, bMat);

  // ---- roads
  const r = s.roads;
  const rPos = new Float32Array(r.count * 6);
  const rWet = new Float32Array(r.count * 2);
  const rCut = new Float32Array(r.count * 2);
  const rBr = new Float32Array(r.count * 2);
  for (let i = 0; i < r.count; i++) {
    rWet[2 * i] = rWet[2 * i + 1] = finite(e.roadWetRise[i]);
    rCut[2 * i] = rCut[2 * i + 1] = finite(e.roadCutRise[i]);
    rBr[2 * i] = rBr[2 * i + 1] = r.bridge[i];
  }
  const rGeo = new THREE.BufferGeometry();
  rGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
  rGeo.setAttribute('aWet', new THREE.BufferAttribute(rWet, 1));
  rGeo.setAttribute('aCut', new THREE.BufferAttribute(rCut, 1));
  rGeo.setAttribute('aBridge', new THREE.BufferAttribute(rBr, 1));
  const rMat = new THREE.ShaderMaterial({ uniforms, vertexShader: ROAD_VS, fragmentShader: ROAD_FS });
  const roads = new THREE.LineSegments(rGeo, rMat);
  roads.renderOrder = 3;

  const setExaggeration = (exag: number, heightAt: (x: number, y: number) => number) => {
    let v = 0;
    const push = (x: number, y: number, h: number) => {
      bPos[3 * v] = x;
      bPos[3 * v + 1] = h;
      bPos[3 * v + 2] = -y;
      v++;
    };
    pieces.forEach((pc, i) => {
      if (!pc.tri.length) return;
      const m = pc.ring.length / 2;
      let base = Infinity;
      for (let p = 0; p < m; p++) base = Math.min(base, heightAt(pc.ring[2 * p], pc.ring[2 * p + 1]));
      base = Math.min(base, heightAt(b.cx[i], b.cy[i]));
      const hTrue = Number.isFinite(b.heights[i]) ? b.heights[i] : BUILDING_DEFAULT_HEIGHT;
      const top = base + hTrue * BUILDING_VSCALE;
      for (const t of pc.tri) push(pc.ring[2 * t], pc.ring[2 * t + 1], top);
      for (let p = 0; p < m; p++) {
        const q = (p + 1) % m;
        const [x0, y0, x1, y1] = [pc.ring[2 * p], pc.ring[2 * p + 1], pc.ring[2 * q], pc.ring[2 * q + 1]];
        push(x0, y0, base - 0.5);
        push(x1, y1, base - 0.5);
        push(x1, y1, top);
        push(x0, y0, base - 0.5);
        push(x1, y1, top);
        push(x0, y0, top);
      }
    });
    (bGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    bGeo.computeBoundingSphere();
    const lift = 1.5 + 0.3 * exag;
    for (let i = 0; i < r.count; i++) {
      const [x0, y0, x1, y1] = [r.xy[4 * i], r.xy[4 * i + 1], r.xy[4 * i + 2], r.xy[4 * i + 3]];
      const bridgeLift = r.bridge[i] ? 6 * exag : 0;
      rPos.set([x0, heightAt(x0, y0) + lift + bridgeLift, -y0, x1, heightAt(x1, y1) + lift + bridgeLift, -y1], 6 * i);
    }
    (rGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    rGeo.computeBoundingSphere();
  };

  return {
    buildings,
    roads,
    setExaggeration,
    dispose() {
      bGeo.dispose();
      rGeo.dispose();
      bMat.dispose();
      rMat.dispose();
    },
  };
}
