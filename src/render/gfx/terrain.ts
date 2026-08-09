/**
 * 地形メッシュ。
 *
 * 頂点は等間隔の格子で、標高はすべて頂点シェーダで標高テクスチャから読む。
 * 法線もフラグメントシェーダで標高テクスチャの差分から作るので、ポリゴンの
 * 分割数より細かい陰影が出る (遠景でも尾根と谷が潰れない)。
 *
 * 色は「標高・傾斜・河道・湿り」から手続き的に決める。砂利 → 草地 → 森 →
 * 岩 → 雪 を斜面と高さで混ぜ、マクロノイズで境界を崩している。
 */
import * as THREE from 'three';
import { CELL, MAP } from '../../config';
import { FIELD_GLSL } from './glsl';
import type { SharedUniforms } from './uniforms';

/** 1セルあたりの分割数 */
export type TerrainDetail = 1 | 2 | 3;

function srgb(hex: number): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear();
}

/** XZ 平面の格子。Y は頂点シェーダで持ち上げる。 */
function buildGridGeometry(sub: TerrainDetail): THREE.BufferGeometry {
  const n = MAP * sub; // 分割数
  const verts = n + 1;
  const pos = new Float32Array(verts * verts * 3);
  const uv = new Float32Array(verts * verts * 2);
  const nrm = new Float32Array(verts * verts * 3);
  const span = MAP * CELL;
  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const k = j * verts + i;
      pos[k * 3] = (i / n) * span;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = (j / n) * span;
      uv[k * 2] = i / n;
      uv[k * 2 + 1] = j / n;
      nrm[k * 3 + 1] = 1;
    }
  }
  const idx = verts * verts > 65535 ? new Uint32Array(n * n * 6) : new Uint16Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * verts + i;
      const b = a + 1;
      const c = a + verts;
      const d = c + 1;
      idx[o++] = a;
      idx[o++] = c;
      idx[o++] = b;
      idx[o++] = b;
      idx[o++] = c;
      idx[o++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // 標高で上下するので、境界球は十分大きく固定しておく (カリングで消えないように)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(span / 2, 0, span / 2), span);
  return g;
}

const VERTEX_HEAD = /* glsl */ `
uniform sampler2D uHeightTex;
uniform float uVScale;
varying vec2 vCell;
varying vec3 vWPos;
varying float vTerrainH;
${FIELD_GLSL}
`;

const VERTEX_BODY = /* glsl */ `
  vCell = uv * uMapSize - 0.5;
  float terrainH = sampleH(uHeightTex, vCell);
  vTerrainH = terrainH;
  vec3 transformed = vec3(position.x, terrainH * uVScale, position.z);
  vWPos = transformed;
`;

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uHeightTex;
uniform sampler2D uWaterTex;
uniform sampler2D uSurfTex;
uniform sampler2D uOverlayTex;
uniform sampler2D uDetailTex;
uniform sampler2D uDetailNormal;
uniform float uOverlayAmt;
uniform float uVScale;
uniform float uCell;
uniform float uGrid;
uniform float uContour;
uniform float uSnowLine;
uniform float uSeasonGreen;
uniform float uSnowFall;
uniform float uWetness;
uniform vec3 uColSand;
uniform vec3 uColSoil;
uniform vec3 uColGrass;
uniform vec3 uColForest;
uniform vec3 uColRockLow;
uniform vec3 uColRockHigh;
uniform vec3 uColSnow;
varying vec2 vCell;
varying vec3 vWPos;
varying float vTerrainH;
${FIELD_GLSL}

vec3 triplanar(sampler2D tex, vec3 p, vec3 n, float scale) {
  vec3 bw = pow(abs(n), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  vec3 cx = texture2D(tex, p.zy * scale).rgb;
  vec3 cy = texture2D(tex, p.xz * scale).rgb;
  vec3 cz = texture2D(tex, p.xy * scale).rgb;
  return cx * bw.x + cy * bw.y + cz * bw.z;
}
`;

/** 標高テクスチャから法線を作る (ポリゴン分割より細かい起伏が出る) */
const NORMAL_BODY = /* glsl */ `
  float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
  float hL = sampleH(uHeightTex, vCell + vec2(-1.0, 0.0));
  float hR = sampleH(uHeightTex, vCell + vec2(1.0, 0.0));
  float hD = sampleH(uHeightTex, vCell + vec2(0.0, -1.0));
  float hU = sampleH(uHeightTex, vCell + vec2(0.0, 1.0));
  vec3 geoN = normalize(vec3((hL - hR) * uVScale, 2.0 * uCell, (hD - hU) * uVScale));

  // マイクロ凹凸 (近景でのみ効かせる: 遠景でざらつくとちらつく)
  float dist = length(vWPos - cameraPosition);
  float micro = 1.0 - smoothstep(160.0, 700.0, dist);
  vec3 dn = triplanar(uDetailNormal, vWPos, geoN, 0.09) * 2.0 - 1.0;
  vec3 dn2 = triplanar(uDetailNormal, vWPos, geoN, 0.015) * 2.0 - 1.0;
  vec3 perturb = vec3(dn.x * 0.55 + dn2.x * 0.5, 0.0, dn.y * 0.55 + dn2.y * 0.5);
  // 地形メッシュは変換なし (単位行列) なので、ワールド法線をそのままビュー空間へ移せる
  vec3 normal = normalize((viewMatrix * vec4(normalize(geoN + perturb * micro * 0.75), 0.0)).xyz);
  vec3 nonPerturbedNormal = normalize((viewMatrix * vec4(geoN, 0.0)).xyz);
`;

/** 地表色 */
const COLOR_BODY = /* glsl */ `
  float h = vTerrainH;
  float hL2 = sampleH(uHeightTex, vCell + vec2(-1.0, 0.0));
  float hR2 = sampleH(uHeightTex, vCell + vec2(1.0, 0.0));
  float hD2 = sampleH(uHeightTex, vCell + vec2(0.0, -1.0));
  float hU2 = sampleH(uHeightTex, vCell + vec2(0.0, 1.0));
  vec3 gN = normalize(vec3((hL2 - hR2) * uVScale, 2.0 * uCell, (hD2 - hU2) * uVScale));
  float slope = 1.0 - clamp(gN.y, 0.0, 1.0);

  // 谷 (凹) は暗く、尾根 (凸) は明るく — 起伏の読み取りやすさが上がる
  float curv = h - (hL2 + hR2 + hD2 + hU2) * 0.25;
  float cavity = clamp(1.0 + curv * 0.16, 0.72, 1.22);

  vec4 detA = texture2D(uDetailTex, vWPos.xz * 0.10);
  vec4 detB = texture2D(uDetailTex, vWPos.xz * 0.012);
  vec4 detC = texture2D(uDetailTex, vWPos.xz * 0.55);
  float nearFade = 1.0 - smoothstep(40.0, 260.0, length(vWPos - cameraPosition));
  vec4 surf = sampleV(uSurfTex, vCell);
  vec4 wat = sampleV(uWaterTex, vCell);
  float depth = max(wat.g, 0.0);

  float macro = detB.g;
  float grain = detA.r;

  // --- 各層の重み ---
  float rockW = smoothstep(0.30, 0.62, slope + (macro - 0.5) * 0.18);
  float snowW = smoothstep(uSnowLine, uSnowLine + 22.0, h + (macro - 0.5) * 16.0 - uSnowFall * 45.0);
  snowW *= 1.0 - rockW * 0.55;
  float beachW = (1.0 - smoothstep(0.2, 2.6, h)) * (1.0 - rockW);
  float riverW = max(surf.r * 0.85, smoothstep(0.80, 0.97, surf.g));
  float gravelW = clamp(max(beachW, riverW * (1.0 - smoothstep(0.05, 0.5, depth))), 0.0, 1.0);
  float forestW = smoothstep(6.0, 26.0, h) * (1.0 - smoothstep(uSnowLine - 18.0, uSnowLine + 6.0, h));

  // --- 混色 ---
  vec3 grass = mix(uColGrass, uColForest, forestW * (0.35 + 0.65 * macro));
  grass = mix(grass * vec3(1.06, 0.99, 0.86), grass, uSeasonGreen);
  grass *= 0.86 + 0.28 * detA.a;
  vec3 soil = mix(uColSoil, grass, 0.35);
  vec3 base = mix(grass, soil, smoothstep(0.12, 0.34, slope) * 0.75);
  // 数百 m スケールの色ムラ (植生の違い・土質の違い)
  base *= mix(vec3(0.93, 0.97, 0.88), vec3(1.10, 1.04, 0.98), detB.a);
  base = mix(base, uColSand, gravelW);
  vec3 rock = mix(uColRockLow, uColRockHigh, clamp(detB.b * 1.2 + (h / 140.0), 0.0, 1.0));
  rock *= 0.78 + 0.42 * detA.b;
  base = mix(base, rock, rockW);
  base = mix(base, uColSnow, snowW);
  // 近景では細かい斑を、遠景ではマクロな斑を効かせる (遠くでちらつかせない)
  base *= 0.86 + 0.28 * grain;
  base *= mix(1.0, 0.82 + 0.36 * detC.r, nearFade * 0.85);
  // 草地に土がのぞく斑
  float bare = smoothstep(0.62, 0.95, 1.0 - detA.a) * (1.0 - rockW) * (1.0 - snowW) * (1.0 - gravelW);
  base = mix(base, mix(uColSoil, base, 0.35), bare * 0.55);
  base *= cavity;

  // --- 濡れ ---
  // 実際に水があるところ (水たまり・潤った土) と、降っているあいだの湿りは分ける。
  // 雨のたびに地表が青くなると地形が読めなくなるので、青みは水がある所だけに限り、
  // 雨は「わずかに落ち着いた色になる」程度にとどめる。
  float wetNear = clamp(max(depth * 6.0, surf.b * 0.55), 0.0, 1.0);
  float rainWet = clamp(uWetness, 0.0, 1.0) * 0.3;
  float wet = max(wetNear, rainWet);
  base *= mix(1.0, 0.74, wet);
  base = mix(base, base * vec3(0.93, 0.97, 1.0), wetNear * 0.3);

  vec3 albedo = base;

  // --- 等高線 / 格子 ---
  if (uContour > 0.0) {
    float step10 = h / 10.0;
    float lw = fwidth(step10) * 1.1;
    float line = 1.0 - smoothstep(0.0, lw, abs(fract(step10) - 0.5) - 0.5 + lw);
    albedo = mix(albedo, albedo * 0.45 + vec3(0.02), line * 0.55 * uContour);
  }
  if (uGrid > 0.0) {
    vec2 gf = abs(fract(vCell + 0.5) - 0.5);
    vec2 gw = fwidth(vCell) * 0.9;
    float gl = 1.0 - min(smoothstep(0.0, gw.x, gf.x), smoothstep(0.0, gw.y, gf.y));
    albedo = mix(albedo, vec3(0.9), gl * 0.16 * uGrid);
  }

  diffuseColor.rgb = albedo;

  // --- オーバーレイ ---
  vec4 ov = texture2D(uOverlayTex, (vCell + 0.5) / uMapSize);
  float oa = ov.a * uOverlayAmt;
  diffuseColor.rgb = mix(diffuseColor.rgb, pow(ov.rgb, vec3(2.2)), oa * 0.75);
`;

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private geometry: THREE.BufferGeometry;

  constructor(
    private uniforms: SharedUniforms,
    detail: TerrainDetail,
  ) {
    this.geometry = buildGridGeometry(detail);
    this.material = this.makeMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = this.makeDepthMaterial();
    this.mesh.frustumCulled = false;
    this.mesh.name = 'terrain';
  }

  private palette(): Record<string, { value: THREE.Color }> {
    return {
      uColSand: { value: srgb(0xc6b48f) },
      uColSoil: { value: srgb(0x8a7050) },
      uColGrass: { value: srgb(0x87a355) },
      uColForest: { value: srgb(0x4f6b3a) },
      uColRockLow: { value: srgb(0x7e7668) },
      uColRockHigh: { value: srgb(0xaaa49b) },
      uColSnow: { value: srgb(0xf2f6fa) },
    };
  }

  private makeMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.0,
      dithering: true,
    });
    const extra = this.palette();
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, extra);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
        .replace('#include <normal_fragment_begin>', NORMAL_BODY)
        .replace('#include <map_fragment>', COLOR_BODY)
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
            float roughnessFactor = roughness;
            {
              vec4 wq = sampleV(uWaterTex, vCell);
              float wetR = clamp(max(wq.g * 8.0, sampleV(uSurfTex, vCell).b * 0.5), 0.0, 1.0);
              // 濡れた地面をあまり鏡面にすると、遠景で一面が光ってしまう
              roughnessFactor = mix(0.95, 0.62, wetR) - texture2D(uDetailTex, vWPos.xz * 0.10).r * 0.10;
              roughnessFactor = clamp(roughnessFactor, 0.34, 1.0);
            }
          `,
        );
    };
    // onBeforeCompile を書き換えたときに再コンパイルさせるためのキー
    mat.customProgramCacheKey = () => 'hydro-terrain-v1';
    return mat;
  }

  private makeDepthMaterial(): THREE.MeshDepthMaterial {
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', VERTEX_BODY);
    };
    dm.customProgramCacheKey = () => 'hydro-terrain-depth-v1';
    return dm;
  }

  setDetail(detail: TerrainDetail): void {
    this.geometry.dispose();
    this.geometry = buildGridGeometry(detail);
    this.mesh.geometry = this.geometry;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
