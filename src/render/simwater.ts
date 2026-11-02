import * as THREE from 'three';
import { cellX, cellY, type Grid } from '../core/grid';
import type { TerrainUniforms } from './terrain';

/**
 * Water surface driven by precomputed depth frames (manifest v2 `simulation` scenarios).
 * The vertex shader interpolates between frame A and B with `uMix`, so scrubbing between
 * solver snapshots costs only a uniform update. Interpolated states are a visual
 * convenience, not physical model output.
 */

const VS = /* glsl */ `
  attribute float aElev;
  attribute float aDepthA;
  attribute float aDepthB;
  uniform float uMix;
  uniform float uExag;
  uniform float uZBase;
  varying float vDepth;
  varying vec3 vWorld;
  void main() {
    float depth = mix(aDepthA, aDepthB, uMix);
    float wse = aElev + depth;
    vDepth = depth;
    vec3 p = vec3(position.x, (wse - uZBase) * uExag + 0.15, position.z);
    vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const FS = /* glsl */ `
  uniform float uTime;
  uniform vec3 uLightDir;
  uniform float uMaxDepth;
  varying float vDepth;
  varying vec3 vWorld;
  void main() {
    if (vDepth <= 0.005) discard;
    float t = clamp(vDepth / max(uMaxDepth, 0.1), 0.0, 1.0);
    vec3 col = mix(vec3(0.55,0.85,0.95), vec3(0.05,0.22,0.50), t);
    vec3 n = normalize(vec3(sin(vWorld.x * 0.05 + uTime) * 0.04, 1.0, cos(vWorld.z * 0.05 + uTime * 0.8) * 0.04));
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 h = normalize(normalize(uLightDir) + v);
    float spec = pow(max(dot(n, h), 0.0), 80.0) * 0.6;
    float edge = smoothstep(0.0, 0.05, vDepth);
    gl_FragColor = vec4(col + spec, mix(0.30, 0.85, edge));
    #include <colorspace_fragment>
  }
`;

export interface SimWater {
  mesh: THREE.Mesh;
  /** Swap the two frame buffers and the interpolation factor (0..1). */
  setFrames(a: Float32Array, b: Float32Array, mix: number): void;
  /** (x-east, y-north local coords) -> lerped depth, for picking/stats. */
  depthAt(x: number, y: number): number;
  dispose(): void;
}

export function buildSimWater(
  g: Grid,
  z: Float32Array,
  uniforms: TerrainUniforms,
  maxDepth: number,
): SimWater {
  const { nx, ny } = g;
  const n = nx * ny;
  const pos = new Float32Array(n * 3);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[3 * k] = cellX(g, i);
      pos[3 * k + 2] = -cellY(g, j);
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
  const geo = new THREE.BufferGeometry();
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aElev', new THREE.BufferAttribute(z, 1));
  geo.setAttribute('aDepthA', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aDepthB', new THREE.BufferAttribute(new Float32Array(n), 1));

  const uMix = { value: 0 };
  const uMaxDepth = { value: Math.max(maxDepth, 0.1) };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uMix, uMaxDepth },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;

  let a: Float32Array = geo.getAttribute('aDepthA').array as Float32Array;
  let b: Float32Array = a;

  return {
    mesh,
    setFrames(fa, fb, mix) {
      a = fa;
      b = fb;
      geo.setAttribute('aDepthA', new THREE.BufferAttribute(fa, 1));
      geo.setAttribute('aDepthB', new THREE.BufferAttribute(fb, 1));
      uMix.value = mix;
    },
    depthAt(x, y) {
      const i = Math.floor((x + nx * g.cell * 0.5) / g.cell);
      const j = Math.floor((ny * g.cell * 0.5 - y) / g.cell);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return 0;
      const k = j * nx + i;
      return a[k] * (1 - uMix.value) + b[k] * uMix.value;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
