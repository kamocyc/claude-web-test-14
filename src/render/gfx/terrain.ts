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
import { CELL, MAP, VOXEL } from '../../config';
import { BLOCK_VERTEX_GLSL, buildBlockGeometry } from './blockgeo';
import { FIELD_GLSL, VOXEL_FRAG_GLSL, VOXEL_GLSL } from './glsl';
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

/* ------------------------------------------------------------------ */
/* ボクセル (ブロック) 表示                                             */
/* ------------------------------------------------------------------ */

/**
 * なめらか版との違い:
 *
 * - Y は「セルの標高をブロック格子へ丸めた値」。セル内は完全に平らになる。
 *   したがって標高は必ず `fieldTexel` (最近傍) で読む。`sampleH` の
 *   バイリニアで読むとセル内に補間由来の段ができてしまう。
 * - 面法線は軸平行なので、標高の差分から作る必要がない。ただし境界面は
 *   「どちら側のセルが高いか」で外向きが反転するため、頂点シェーダで符号を
 *   決め、マテリアルは両面描画にする (巻き順は頂点シェーダで変えられない)。
 * - vCell は**整数のセル番号**になる (なめらか版は連続座標)。`fieldTexel` /
 *   `sampleV` は整数を渡せばそのセルの値をそのまま返すので、既存の
 *   オーバーレイ・水・地表テクスチャの読みはそのまま動く。
 * - 画面空間パターン (格子線・等高線) を `fwidth(vCell)` から作ってはいけない。
 *   面の上で vCell が定数になるので微分が 0 になり、セル全体が点いたり消えたり
 *   する。ワールド座標 `vWPos.xz` から作ること。
 */
const V_VERTEX_HEAD = /* glsl */ `
uniform sampler2D uHeightTex;
uniform float uVScale;
varying vec2 vCell;
varying vec3 vWPos;
varying float vTerrainH;
varying float vTopY;
varying float vBotY;
varying float vIsTop;
varying vec3 vFaceN;
${FIELD_GLSL}
${VOXEL_GLSL}
${BLOCK_VERTEX_GLSL}
`;

const V_VERTEX_BODY = /* glsl */ `
  vec2 cA = aCells.xy;
  vec2 cB = aCells.zw;
  float isTop = all(equal(cA, cB)) ? 1.0 : 0.0;
  float hA = edgeH(uHeightTex, cA);
  float hB = edgeH(uHeightTex, cB);
  float hi = max(hA, hB);
  float lo = min(hA, hB);

  vIsTop = isTop;
  vTopY = hi;
  vBotY = lo;
  // 面の色は「高いほうのセル」のものを使う (崖の上の土質が側面に降りてくる)
  vCell = (hA >= hB) ? cA : cB;
  vTerrainH = hi;

  // position.y は役割フラグ (0 = 上辺, 1 = 下辺)
  float y = mix(mix(hi, lo, position.y), hA, isTop);

  vec2 d = cB - cA;
  float sgn = (hA >= hB) ? 1.0 : -1.0;
  vFaceN = mix(vec3(d.x, 0.0, d.y) * sgn, vec3(0.0, 1.0, 0.0), isTop);

  vec3 transformed = vec3(position.x, y * uVScale, position.z);
  vWPos = transformed;
`;

const V_FRAGMENT_HEAD = /* glsl */ `
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
varying float vTopY;
varying float vBotY;
varying float vIsTop;
varying vec3 vFaceN;
${FIELD_GLSL}
${VOXEL_GLSL}
${VOXEL_FRAG_GLSL}

vec3 triplanar(sampler2D tex, vec3 p, vec3 n, float scale) {
  vec3 bw = pow(abs(n), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  vec3 cx = texture2D(tex, p.zy * scale).rgb;
  vec3 cy = texture2D(tex, p.xz * scale).rgb;
  vec3 cz = texture2D(tex, p.xy * scale).rgb;
  return cx * bw.x + cy * bw.y + cz * bw.z;
}

/** 生の (丸めていない) 標高。地表の種類を決めるのには丸める前の値を使う */
float rawH(vec2 cell) { return fieldTexel(uHeightTex, cell).r; }
`;

const V_NORMAL_BODY = /* glsl */ `
  float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
  vec3 geoN = normalize(vFaceN);
  float dist = length(vWPos - cameraPosition);
  float micro = 1.0 - smoothstep(160.0, 700.0, dist);
  vec3 dn = triplanar(uDetailNormal, vWPos, geoN, 0.09) * 2.0 - 1.0;
  // 上面は XZ に、側面は「面内の水平方向」に摂動を入れる
  vec3 tangent = vec3(geoN.z, 0.0, -geoN.x);
  vec3 perturb = mix(tangent * dn.x * 0.35 + vec3(0.0, dn.y * 0.25, 0.0), vec3(dn.x, 0.0, dn.y) * 0.5, vIsTop);
  // 地形メッシュは変換なし (単位行列) なので、ワールド法線をそのままビュー空間へ移せる
  vec3 normal = normalize((viewMatrix * vec4(normalize(geoN + perturb * micro), 0.0)).xyz);
  vec3 nonPerturbedNormal = normalize((viewMatrix * vec4(geoN, 0.0)).xyz);
`;

const V_COLOR_BODY = /* glsl */ `
  // --- 地表の種類は「丸める前の標高」で決める ---
  // 丸めた標高で判定すると、段差の隣り合うブロックで傾斜が 0 と 3 を往復し、
  // 岩と草が1ブロックごとにちらつく。生の標高で見れば、なめらか版と同じ
  // 色分けのままブロックの形だけが変わる。
  float h = rawH(vCell);
  float hL2 = rawH(vCell + vec2(-1.0, 0.0));
  float hR2 = rawH(vCell + vec2(1.0, 0.0));
  float hD2 = rawH(vCell + vec2(0.0, -1.0));
  float hU2 = rawH(vCell + vec2(0.0, 1.0));
  vec3 gN = normalize(vec3((hL2 - hR2) * uVScale, 2.0 * uCell, (hD2 - hU2) * uVScale));
  float slope = 1.0 - clamp(gN.y, 0.0, 1.0);

  float curv = h - (hL2 + hR2 + hD2 + hU2) * 0.25;
  float cavity = clamp(1.0 + curv * 0.16, 0.72, 1.22);

  float elev = vWPos.y / uVScale;                 // 強調前の標高 (地層の目盛りに使う)
  float depthBelowTop = vTopY - elev;             // 側面の上端からの深さ

  vec4 detA = texture2D(uDetailTex, vWPos.xz * 0.10);
  vec4 detB = texture2D(uDetailTex, vWPos.xz * 0.012);
  float camDist = length(vWPos - cameraPosition);
  float nearFade = 1.0 - smoothstep(40.0, 260.0, camDist);
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

  // --- 上面の色 (なめらか版と同じ配合) ---
  vec3 grass = mix(uColGrass, uColForest, forestW * (0.35 + 0.65 * macro));
  grass = mix(grass * vec3(1.06, 0.99, 0.86), grass, uSeasonGreen);
  grass *= 0.86 + 0.28 * detA.a;
  vec3 soil = mix(uColSoil, grass, 0.35);
  vec3 top = mix(grass, soil, smoothstep(0.12, 0.34, slope) * 0.75);
  top *= mix(vec3(0.93, 0.97, 0.88), vec3(1.10, 1.04, 0.98), detB.a);
  top = mix(top, uColSand, gravelW);
  vec3 rock = mix(uColRockLow, uColRockHigh, clamp(detB.b * 1.2 + (h / 140.0), 0.0, 1.0));
  rock *= 0.78 + 0.42 * detA.b;
  top = mix(top, rock, rockW);
  top = mix(top, uColSnow, snowW);
  float bare = smoothstep(0.62, 0.95, 1.0 - detA.a) * (1.0 - rockW) * (1.0 - snowW) * (1.0 - gravelW);
  top = mix(top, mix(uColSoil, top, 0.35), bare * 0.55);

  // --- 側面 = 崖。露出した地層 ---
  // 帯の位置は「絶対標高」で決めるので、隣り合う柱で地層が水平につながる。
  // 帯の位置は「絶対標高」なので、隣り合う柱で地層が水平につながる
  float bandT = fract(elev / (uVoxel * 2.0));
  vec3 strata = mix(uColRockLow, uColSoil, 0.30 + 0.55 * smoothstep(0.35, 0.65, bandT));
  strata = mix(strata, rock, 0.40) * 1.12;
  strata *= 0.80 + 0.30 * voxelHash(vec2(floor(elev / uVoxel), floor((vWPos.x + vWPos.z) / uBlockXZ)));
  // 崖の天端だけ上面の土をかぶせる (草が縁からのぞく)
  strata = mix(strata, top * 0.86, (1.0 - smoothstep(0.0, uVoxel * 0.55, depthBelowTop)) * 0.65);

  vec3 base = mix(strata, top, vIsTop);
  base *= 0.86 + 0.28 * grain;
  base *= cavity;

  // --- ブロックの目地 ---
  // uBlockXZ は「1段の見かけの高さ」に合わせてあるので、目地を引くと
  // 高さ強調をどこに設定しても立方体に見える。
  float seam = 0.0;
  float bevel = 0.0;
  if (vIsTop > 0.5) {
    seam = max(voxelSeam(vWPos.x, uBlockXZ), voxelSeam(vWPos.z, uBlockXZ));
    bevel = voxelBevel(vWPos.xz, uBlockXZ);
    // ブロックごとの色ムラ — これが「4×4の立方体」に見せる決め手
    vec2 bxz = floor(vWPos.xz / uBlockXZ);
    base *= 1.0 + (voxelHash(bxz) * 0.14 - 0.07);
  } else {
    float run = mix(vWPos.z, vWPos.x, step(0.5, abs(vFaceN.z)));
    seam = max(voxelSeam(elev, uVoxel), voxelSeam(run, uBlockXZ));
    bevel = voxelBevel(vec2(run, elev), uVoxel);
    base *= 1.0 + (voxelHash(vec2(floor(run / uBlockXZ), floor(elev / uVoxel))) * 0.12 - 0.06);
  }
  // 遠景では目地がモアレになるので消していく
  float seamFade = 1.0 - smoothstep(420.0, 1100.0, camDist);
  // 縁に向かってわずかに落とす (面取りの陰)。目地の線だけだと平板に見える
  base *= mix(1.0, 1.0 - 0.13 * smoothstep(0.5, 1.0, bevel), seamFade);
  base *= mix(1.0, 0.70, seam * seamFade);

  // --- 擬似 AO ---
  // 側面は下ほど暗く、上面は「隣が高い辺」の際を暗くする。
  // ボクセル地形はこれが有るか無いかで立体の読みやすさが段違いに変わる。
  float ao = 1.0;
  if (vIsTop > 0.5) {
    vec2 lc = clamp(vWPos.xz / uCell - vCell, 0.0, 1.0);
    float me = voxelH(h);
    ao -= 0.34 * step(me + 0.5, voxelH(rawH(vCell + vec2(-1.0, 0.0)))) * (1.0 - smoothstep(0.0, 0.3, lc.x));
    ao -= 0.34 * step(me + 0.5, voxelH(rawH(vCell + vec2(1.0, 0.0)))) * smoothstep(0.7, 1.0, lc.x);
    ao -= 0.34 * step(me + 0.5, voxelH(rawH(vCell + vec2(0.0, -1.0)))) * (1.0 - smoothstep(0.0, 0.3, lc.y));
    ao -= 0.34 * step(me + 0.5, voxelH(rawH(vCell + vec2(0.0, 1.0)))) * smoothstep(0.7, 1.0, lc.y);
  } else {
    // 壁の足元だけ軽く落とす。ここを効かせすぎると崖が真っ黒になり、
    // せっかくの地層も目地も見えなくなる (側面はもともと日が当たりにくい)。
    ao = 0.78 + 0.22 * smoothstep(0.0, uVoxel * 1.1, elev - vBotY);
  }
  base *= clamp(ao, 0.5, 1.0);

  base *= mix(1.0, 0.82 + 0.36 * texture2D(uDetailTex, vWPos.xz * 0.55).r, nearFade * 0.7);

  // --- 濡れ ---
  float wetNear = clamp(max(depth * 6.0, surf.b * 0.55), 0.0, 1.0) * vIsTop;
  float rainWet = clamp(uWetness, 0.0, 1.0) * 0.3;
  float wet = max(wetNear, rainWet);
  base *= mix(1.0, 0.74, wet);
  base = mix(base, base * vec3(0.93, 0.97, 1.0), wetNear * 0.3);

  vec3 albedo = base;

  // --- 段の目盛り / 建設グリッド ---
  // どちらもワールド座標から作る。vCell は面の上で定数なので fwidth が 0 になり、
  // そこから線を引くとセル全体が点滅してしまう。
  if (uContour > 0.0 && vIsTop < 0.5) {
    // 等高線はブロックの段そのものなので、側面で「4段ごと」を明るく示す
    float band = voxelSeam(elev, uVoxel * 4.0);
    albedo = mix(albedo, albedo * 1.35 + vec3(0.03), band * 0.5 * uContour);
  }
  if (uGrid > 0.0 && vIsTop > 0.5) {
    float gl = max(voxelSeam(vWPos.x, uCell), voxelSeam(vWPos.z, uCell));
    albedo = mix(albedo, vec3(0.9), gl * 0.18 * uGrid);
  }

  diffuseColor.rgb = albedo;

  // --- オーバーレイ ---
  vec4 ov = texture2D(uOverlayTex, (vCell + 0.5) / uMapSize);
  float oa = ov.a * uOverlayAmt;
  diffuseColor.rgb = mix(diffuseColor.rgb, pow(ov.rgb, vec3(2.2)), oa * 0.75);
`;

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  private geometry: THREE.BufferGeometry;
  private voxel: boolean;

  constructor(
    private uniforms: SharedUniforms,
    private detail: TerrainDetail,
    voxel = VOXEL.enabled,
  ) {
    this.voxel = voxel;
    this.geometry = voxel ? buildBlockGeometry() : buildGridGeometry(detail);
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
    const voxel = this.voxel;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.0,
      dithering: true,
      // ボクセルでは境界面1枚をどちらのセルからも使い回すので、外向きが
      // 面ごとに反転する。巻き順は頂点シェーダで変えられないため両面描画にし、
      // 法線の符号だけ頂点シェーダで合わせている。裏面は必ず地形に隠れる。
      side: voxel ? THREE.DoubleSide : THREE.FrontSide,
    });
    const extra = this.palette();
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, extra);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${voxel ? V_VERTEX_HEAD : VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', voxel ? V_VERTEX_BODY : VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${voxel ? V_FRAGMENT_HEAD : FRAGMENT_HEAD}`)
        .replace('#include <normal_fragment_begin>', voxel ? V_NORMAL_BODY : NORMAL_BODY)
        .replace('#include <map_fragment>', voxel ? V_COLOR_BODY : COLOR_BODY)
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
    // onBeforeCompile を書き換えたときに再コンパイルさせるためのキー。
    // **モードを含めること** — 含めないと切り替えても古いシェーダが使い回される。
    mat.customProgramCacheKey = () => `hydro-terrain-v2-${voxel ? 'voxel' : 'smooth'}`;
    return mat;
  }

  private makeDepthMaterial(): THREE.MeshDepthMaterial {
    const voxel = this.voxel;
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dm.side = voxel ? THREE.DoubleSide : THREE.FrontSide;
    dm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${voxel ? V_VERTEX_HEAD : VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', voxel ? V_VERTEX_BODY : VERTEX_BODY);
    };
    dm.customProgramCacheKey = () => `hydro-terrain-depth-v2-${voxel ? 'voxel' : 'smooth'}`;
    return dm;
  }

  setDetail(detail: TerrainDetail): void {
    this.detail = detail;
    // ボクセル表示では分割数に意味がない (常にセル単位のブロック)
    if (this.voxel) return;
    this.geometry.dispose();
    this.geometry = buildGridGeometry(detail);
    this.mesh.geometry = this.geometry;
  }

  /** なめらか表示 ⇔ ブロック表示。ジオメトリもシェーダも別物なので作り直す */
  setVoxel(voxel: boolean): void {
    if (voxel === this.voxel) return;
    this.voxel = voxel;
    this.geometry.dispose();
    this.material.dispose();
    this.geometry = voxel ? buildBlockGeometry() : buildGridGeometry(this.detail);
    this.material = this.makeMaterial();
    this.mesh.geometry = this.geometry;
    this.mesh.material = this.material;
    this.mesh.customDepthMaterial?.dispose();
    this.mesh.customDepthMaterial = this.makeDepthMaterial();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
