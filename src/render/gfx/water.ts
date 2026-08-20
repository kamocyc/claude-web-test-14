/**
 * 水面。
 *
 * 頂点は地形と同じ格子で、Y を水面標高テクスチャから持ち上げる。乾いたセルでは
 * 水面標高 = 地面標高なので、水際では自然に水面が地面へ潜り込む。
 *
 * 法線は「水面そのものの傾き (急流では水面が傾く)」に「流速方向へ流れる波の
 * 法線マップ2枚」を重ねて作る。したがって川では波が下流へ流れ、湖では
 * ゆっくり揺れるだけ、という差が出る。
 */
import * as THREE from 'three';
import { CELL, MAP, VOXEL } from '../../config';
import { BLOCK_VERTEX_GLSL, buildBlockGeometry } from './blockgeo';
import { FIELD_GLSL, FLOW_GLSL, SKY_GLSL, VOXEL_FRAG_GLSL, VOXEL_GLSL } from './glsl';
import type { SharedUniforms } from './uniforms';

function buildWaterGeometry(sub: number): THREE.BufferGeometry {
  const n = MAP * sub;
  const verts = n + 1;
  const pos = new Float32Array(verts * verts * 3);
  const uv = new Float32Array(verts * verts * 2);
  const span = MAP * CELL;
  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const k = j * verts + i;
      pos[k * 3] = (i / n) * span;
      pos[k * 3 + 2] = (j / n) * span;
      uv[k * 2] = i / n;
      uv[k * 2 + 1] = j / n;
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
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(span / 2, 0, span / 2), span);
  return g;
}

const VERT = /* glsl */ `
uniform sampler2D uWaterTex;
uniform sampler2D uHeightTex;
uniform float uVScale;
varying vec2 vCell;
varying vec3 vWPos;
varying float vDepth;
varying vec2 vFlow;
${FIELD_GLSL}

#include <common>
#include <fog_pars_vertex>

void main() {
  vCell = uv * uMapSize - 0.5;
  vec4 w = sampleV(uWaterTex, vCell);
  vDepth = max(w.g, 0.0);
  vFlow = w.ba;
  // 水際の Z ファイティングを避けるため、ごくわずかに持ち上げる
  float y = w.r * uVScale + 0.02;
  vec3 p = vec3(position.x, y, position.z);
  vWPos = p;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uWaterTex;
uniform sampler2D uWaveNormal;
uniform sampler2D uFoamTex;
uniform sampler2D uOverlayTex;
uniform float uOverlayAmt;
uniform float uVScale;
uniform float uCell;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundCol;
uniform vec3 uShallowCol;
uniform vec3 uDeepCol;
uniform float uAmbient;
varying vec2 vCell;
varying vec3 vWPos;
varying float vDepth;
varying vec2 vFlow;

${FIELD_GLSL}
${FLOW_GLSL}
${SKY_GLSL}

#include <common>
#include <fog_pars_fragment>

vec3 waveNormal(vec2 p, vec2 flow, float scale, float speed, float t) {
  vec2 uvw = p * scale - flow * speed * t;
  vec3 n = texture2D(uWaveNormal, uvw).rgb * 2.0 - 1.0;
  return n;
}

void main() {
  if (vDepth < 0.006) discard;

  // --- 水面そのものの傾き (急流・段差) ---
  float lL = sampleV(uWaterTex, vCell + vec2(-1.0, 0.0)).r;
  float lR = sampleV(uWaterTex, vCell + vec2(1.0, 0.0)).r;
  float lD = sampleV(uWaterTex, vCell + vec2(0.0, -1.0)).r;
  float lU = sampleV(uWaterTex, vCell + vec2(0.0, 1.0)).r;
  vec3 surfN = normalize(vec3((lL - lR) * uVScale, 2.0 * uCell, (lD - lU) * uVScale));

  // --- 流れ ---
  // 波は**実際の流速で流す**。ここを定数にすると、静水の湖でも急流でも同じ
  // 速さで波が動いてしまい、どこがどちらへ流れているのか読み取れない。
  vec2 dir;
  float speed;
  float vis;
  flowVis(uWaterTex, vWPos.xz, uCell, dir, speed, vis);
  // 流れに沿う座標 / 直交する座標。ここから筋も横波も作る
  float along = dot(vWPos.xz, dir);
  float across = dot(vWPos.xz, vec2(-dir.y, dir.x));
  // 流れ方向へ引き伸ばした筋 (along は細かく across は粗く = 異方性)
  float streak = texture2D(uFoamTex, vec2(along * 0.020 - uTime * vis * 0.85, across * 0.115)).a;
  // 下流へ進む横波。「どちらへ流れているか」をいちばん強く伝える
  float crest = sin(along * 0.42 - uTime * (0.8 + 7.0 * vis));

  // --- 波 ---
  vec3 w1 = waveNormal(vWPos.xz, dir * vis, 0.055, 4.0, uTime);
  vec3 w2 = waveNormal(vWPos.xz + vec2(37.0, 11.0), dir * vis, 0.145, 6.5, uTime);
  // 向きを持たないゆっくりした揺れ (静水がガラス板に見えないように常に少し足す)
  vec3 w3 = waveNormal(vWPos.xz, vec2(0.13, -0.09), 0.021, 1.0, uTime);
  vec2 wave = (w1.xy * 0.50 + w2.xy * 0.30) * (0.25 + 1.5 * vis) + w3.xy * 0.35;
  // 横波と筋を法線へ。ハイライトが下流へ流れるので静止画でも向きが分かる
  wave += dir * crest * vis * 0.55;
  wave += dir * (streak - 0.5) * vis * 0.70;
  // 浅いところは波を抑える (水たまりがぎらつかないように)
  wave *= smoothstep(0.02, 0.5, vDepth) * 0.55 + 0.12;
  vec3 N = normalize(surfN + vec3(wave.x, 0.0, wave.y));

  vec3 V = normalize(cameraPosition - vWPos);
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 5.0);

  // 引いて見ると視線が水面をかすめるため、フレネルがどこも 1 に近づいて
  // 川面が一様な「空の鏡」になり、地形も水の広がりも読めなくなる。
  // 遠景ほど反射を抑え、水そのものの色を残す。
  float viewDist = length(cameraPosition - vWPos);
  float far = smoothstep(260.0, 1100.0, viewDist);
  float fresMax = mix(0.78, 0.34, far);

  // --- 反射 ---
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.85 + 0.02;
  vec3 sky = skyRadiance(normalize(R), uSunDir, uZenith, uHorizon, uGroundCol, uSunColor);

  // --- 透過色 (深さで吸収) ---
  float absorb = 1.0 - exp(-vDepth * 1.1);
  vec3 body = mix(uShallowCol, uDeepCol, absorb);
  // 流れの速いところは気泡を巻き込んで明るく濁る。淵と瀬の差が付く
  body = mix(body, mix(body, vec3(0.62, 0.74, 0.78), 0.35), vis * (0.35 + 0.5 * streak));
  body *= (0.35 + 0.65 * uAmbient);

  // --- 太陽のハイライト ---
  // 遠景では 1 ピクセルに波が何本も入ってギラつく (ブルームで増幅されて白飛びする)
  // ので、距離に応じて弱める。
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 380.0) * 3.0 + pow(max(dot(N, H), 0.0), 32.0) * 0.18;
  spec *= mix(1.0, 0.22, far);
  vec3 color = mix(body, sky, clamp(fres, 0.02, fresMax)) + uSunColor * spec * clamp(uSunDir.y * 3.0, 0.0, 1.0);

  // --- 泡 ---
  float foamTexA = texture2D(uFoamTex, vWPos.xz * 0.16 - dir * uTime * 0.55).a;
  float foamTexB = texture2D(uFoamTex, vWPos.xz * 0.07 + dir * uTime * 0.2).a;
  // 水際 (ごく浅いところ)・早瀬・流れの筋を白くする。
  // 早瀬の閾値は実測に合わせてある (以前は 1.4 m/s からで、ほぼ発火しなかった)
  float shore = (1.0 - smoothstep(0.015, 0.12, vDepth)) * smoothstep(0.05, 0.45, speed);
  float rapids = smoothstep(uRapids.x, uRapids.y, speed) * (0.3 + 0.7 * foamTexA);
  float streakFoam = vis * smoothstep(0.60, 0.95, streak) * 0.5;
  float foam = clamp(max(shore * foamTexB * 0.7, max(rapids, streakFoam)), 0.0, 1.0);
  color = mix(color, vec3(0.92, 0.96, 1.0) * (0.45 + 0.55 * uAmbient), foam * 0.8);

  float alpha = clamp(1.0 - exp(-vDepth * 3.4), 0.12, 0.95);
  alpha = mix(alpha, 1.0, min(fres, fresMax) * 0.7);
  alpha = clamp(alpha + foam * 0.45, 0.0, 1.0);

  // オーバーレイは水の上にも出す (氾濫域が水面下に隠れないように)
  vec4 ov = texture2D(uOverlayTex, (vCell + 0.5) / uMapSize);
  float oa = ov.a * uOverlayAmt * 0.6;
  color = mix(color, pow(ov.rgb, vec3(2.2)), oa);
  alpha = max(alpha, oa);

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* ボクセル (段差) 表示                                                 */
/* ------------------------------------------------------------------ */

/**
 * Timberborn 風の「水ブロック」。地形と同じトポロジで、
 * セルごとに平らな水面 + 水際に垂直な壁を立てる。
 *
 * **水深そのものは連続値のまま**で、垂直方向に量子化はしない。
 * 量子化するのは地形だけ。0.2m の水たまりは 0.2m の高さで描かれる。
 */
const V_WATER_VERT = /* glsl */ `
uniform sampler2D uWaterTex;
uniform sampler2D uHeightTex;
uniform float uVScale;
varying vec2 vCell;
varying vec3 vWPos;
varying float vDepth;
varying vec2 vFlow;
varying float vIsTop;
varying vec3 vFaceN;
varying float vTopY;
varying float vBotY;
${FIELD_GLSL}
${VOXEL_GLSL}
${BLOCK_VERTEX_GLSL}

#include <common>
#include <fog_pars_vertex>

/**
 * セル c の水面 (lvl)・河床 (bed)・水深。
 *
 * 標高を丸めていないので、水面はシミュレーションの値そのまま。
 * 乾いたセルでは lvl == bed == 地面なので、水際で壁が自然に潰れる。
 */
void cellWater(vec2 c, out float lvl, out float bed, out float depth) {
  if (c.x < -0.5 || c.y < -0.5 || c.x > uMapSize.x - 0.5 || c.y > uMapSize.y - 0.5) {
    // マップ外は海。河口が海面へきれいに続く
    lvl = 0.0;
    bed = uVoxelFloor;
    depth = 0.0;
    return;
  }
  vec4 w = fieldTexel(uWaterTex, c);
  depth = max(w.g, 0.0);
  lvl = w.r;
  bed = w.r - depth;
}

void main() {
  vec2 cA = aCells.xy;
  vec2 cB = aCells.zw;
  float isTop = all(equal(cA, cB)) ? 1.0 : 0.0;

  float lA, bA, dA, lB, bB, dB;
  cellWater(cA, lA, bA, dA);
  cellWater(cB, lB, bB, dB);

  float top = max(lA, lB);
  // 壁の下端。両セルの河床と「低いほうの水面」のうち最も高いところで止める:
  //   水中どうしの境界では bot == top になって壁が潰れる (湖の中に板が立たない)
  //   水際では自セルの河床で止まる (そこから下は地形が描く)
  float bot = min(top, max(max(bA, bB), min(lA, lB)));

  vIsTop = isTop;
  vTopY = top;
  vBotY = bot;
  vCell = (lA >= lB) ? cA : cB;
  vDepth = (lA >= lB) ? dA : dB;
  vFlow = fieldTexel(uWaterTex, vCell).ba;

  vec2 d = cB - cA;
  float sgn = (lA >= lB) ? 1.0 : -1.0;
  vFaceN = mix(vec3(d.x, 0.0, d.y) * sgn, vec3(0.0, 1.0, 0.0), isTop);

  float y = mix(mix(top, bot, position.y), lA, isTop);
  // 水際の Z ファイティングを避けるため、水面だけごくわずかに持ち上げる
  vec3 p = vec3(position.x, y * uVScale + isTop * 0.02, position.z);
  vWPos = p;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const V_WATER_FRAG = /* glsl */ `
uniform sampler2D uWaterTex;
uniform sampler2D uHeightTex;
uniform sampler2D uWaveNormal;
uniform sampler2D uFoamTex;
uniform sampler2D uOverlayTex;
uniform float uOverlayAmt;
uniform float uVScale;
uniform float uCell;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundCol;
uniform vec3 uShallowCol;
uniform vec3 uDeepCol;
uniform float uAmbient;
varying vec2 vCell;
varying vec3 vWPos;
varying float vDepth;
varying vec2 vFlow;
varying float vIsTop;
varying vec3 vFaceN;
varying float vTopY;
varying float vBotY;

${FIELD_GLSL}
${VOXEL_GLSL}
${VOXEL_FRAG_GLSL}
${FLOW_GLSL}
${SKY_GLSL}

#include <common>
#include <fog_pars_fragment>

vec3 waveNormal(vec2 p, vec2 flow, float scale, float speed, float t) {
  vec2 uvw = p * scale - flow * speed * t;
  return texture2D(uWaveNormal, uvw).rgb * 2.0 - 1.0;
}

/** 隣のセルの水深 (マップ外は 0) */
float neighborDepth(vec2 c) {
  if (c.x < -0.5 || c.y < -0.5 || c.x > uMapSize.x - 0.5 || c.y > uMapSize.y - 0.5) return 0.0;
  return max(fieldTexel(uWaterTex, c).g, 0.0);
}

void main() {
  if (vDepth < 0.006) discard;

  // --- 流れ ---
  // 波は**実際の流速で流す**。ここを定数にすると、静水の湖でも急流でも同じ
  // 速さで波が動いてしまい、どこがどちらへ流れているのか読み取れない。
  // 流速はバイリニアで拾う。水面の高さはセルごとに平らのままでよいが、
  // 流れの向きだけはセル境界でなめらかにつながないと筋が1セルごとに折れる。
  vec2 dir;
  float speed;
  float vis;
  flowVis(uWaterTex, vWPos.xz, uCell, dir, speed, vis);
  float elev = vWPos.y / uVScale;

  // 流れに沿う座標 / 直交する座標。ここから筋も横波も作る
  float along = dot(vWPos.xz, dir);
  float across = dot(vWPos.xz, vec2(-dir.y, dir.x));
  // 流れ方向へ引き伸ばした筋 (along は細かく across は粗く = 異方性)
  float streak = texture2D(uFoamTex, vec2(along * 0.020 - uTime * vis * 0.85, across * 0.115)).a;

  vec3 N;
  float foam;
  if (vIsTop > 0.5) {
    // --- 水面 ---
    // 下流へ進む横波。「どちらへ流れているか」をいちばん強く伝える
    float crest = sin(along * 0.42 - uTime * (0.8 + 7.0 * vis));

    vec3 w1 = waveNormal(vWPos.xz, dir * vis, 0.055, 4.0, uTime);
    vec3 w2 = waveNormal(vWPos.xz + vec2(37.0, 11.0), dir * vis, 0.145, 6.5, uTime);
    // 向きを持たないゆっくりした揺れ (静水がガラス板に見えないように常に少し足す)
    vec3 w3 = waveNormal(vWPos.xz, vec2(0.13, -0.09), 0.021, 1.0, uTime);

    vec2 wave = (w1.xy * 0.50 + w2.xy * 0.30) * (0.25 + 1.5 * vis) + w3.xy * 0.35;
    // 横波と筋を法線へ。ハイライトが下流へ流れるので静止画でも向きが分かる
    wave += dir * crest * vis * 0.55;
    wave += dir * (streak - 0.5) * vis * 0.70;
    wave *= smoothstep(0.02, 0.5, vDepth) * 0.6 + 0.15;
    // セルごとに平らなので、なめらか版の「水面の傾きから作る法線」は使えない
    N = normalize(vec3(0.0, 1.0, 0.0) + vec3(wave.x, 0.0, wave.y));

    // 泡は「乾いた隣セルに接するブロックの縁」に寄せる。
    // vDepth はセル内で定数なので、なめらか版のように水深から出すと
    // セルまるごとが白くなってしまう。
    vec2 lc = clamp(vWPos.xz / uCell - vCell, 0.0, 1.0);
    float edge = 0.0;
    edge = max(edge, step(neighborDepth(vCell + vec2(-1.0, 0.0)), 0.02) * (1.0 - smoothstep(0.0, 0.35, lc.x)));
    edge = max(edge, step(neighborDepth(vCell + vec2(1.0, 0.0)), 0.02) * smoothstep(0.65, 1.0, lc.x));
    edge = max(edge, step(neighborDepth(vCell + vec2(0.0, -1.0)), 0.02) * (1.0 - smoothstep(0.0, 0.35, lc.y)));
    edge = max(edge, step(neighborDepth(vCell + vec2(0.0, 1.0)), 0.02) * smoothstep(0.65, 1.0, lc.y));
    float foamTexB = texture2D(uFoamTex, vWPos.xz * 0.07 + dir * uTime * 0.2).a;
    float shore = edge * (1.0 - smoothstep(0.05, 0.9, vDepth)) * foamTexB;
    // 早瀬の閾値は実測に合わせてある (以前は 1.4 m/s からで、ほぼ発火しなかった)
    float rapids = smoothstep(uRapids.x, uRapids.y, speed) * (0.35 + 0.65 * streak);
    // 流れの筋そのものを薄く白く出す。これで流路が一目で追える
    float streakFoam = vis * smoothstep(0.60, 0.95, streak) * 0.5;
    foam = clamp(max(max(shore * 0.85, rapids), streakFoam), 0.0, 1.0);
  } else {
    // --- 水の壁 (滝・堰の落ち口) ---
    // 波を下向きにスクロールさせると、段差から水が落ちているように見える。
    float run = mix(vWPos.z, vWPos.x, step(0.5, abs(vFaceN.z)));
    vec2 fall = vec2(run, -elev) * 0.09 + vec2(0.0, uTime * (0.9 + 1.4 * vis));
    vec3 wf = texture2D(uWaveNormal, fall).rgb * 2.0 - 1.0;
    vec3 tangent = vec3(vFaceN.z, 0.0, -vFaceN.x);
    N = normalize(normalize(vFaceN) + tangent * wf.x * 0.28 + vec3(0.0, wf.y * 0.1, 0.0));
    // 落ち口 (壁の上端) がいちばん白い
    float lip = 1.0 - smoothstep(0.0, max(0.4, (vTopY - vBotY) * 0.55), vTopY - elev);
    float ft = texture2D(uFoamTex, fall * 1.6).a;
    foam = clamp(lip * (0.35 + 0.65 * ft) + smoothstep(uRapids.x, uRapids.y, speed) * 0.35, 0.0, 1.0);
  }

  vec3 V = normalize(cameraPosition - vWPos);
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - max(dot(N, V), 0.0), 0.0, 1.0), 5.0);

  float viewDist = length(cameraPosition - vWPos);
  float far = smoothstep(260.0, 1100.0, viewDist);
  float fresMax = mix(0.78, 0.34, far);

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) * 0.85 + 0.02;
  vec3 sky = skyRadiance(normalize(R), uSunDir, uZenith, uHorizon, uGroundCol, uSunColor);

  float absorb = 1.0 - exp(-vDepth * 1.1);
  vec3 body = mix(uShallowCol, uDeepCol, absorb);
  // 流れの速いところは気泡を巻き込んで明るく濁る。淵と瀬の差が付く
  body = mix(body, mix(body, vec3(0.62, 0.74, 0.78), 0.35), vis * (0.35 + 0.5 * streak));
  body *= (0.35 + 0.65 * uAmbient);

  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 380.0) * 3.0 + pow(max(dot(N, H), 0.0), 32.0) * 0.18;
  spec *= mix(1.0, 0.22, far);
  vec3 color = mix(body, sky, clamp(fres, 0.02, fresMax)) + uSunColor * spec * clamp(uSunDir.y * 3.0, 0.0, 1.0);

  color = mix(color, vec3(0.92, 0.96, 1.0) * (0.45 + 0.55 * uAmbient), foam * 0.8);

  float alpha = clamp(1.0 - exp(-vDepth * 3.4), 0.12, 0.95);
  alpha = mix(alpha, 1.0, min(fres, fresMax) * 0.7);
  alpha = clamp(alpha + foam * 0.45, 0.0, 1.0);
  // 壁はうすいと段差が読めないので、少し濃いめにする
  alpha = mix(alpha, clamp(alpha + 0.22, 0.0, 1.0), 1.0 - vIsTop);

  vec4 ov = texture2D(uOverlayTex, (vCell + 0.5) / uMapSize);
  float oa = ov.a * uOverlayAmt * 0.6;
  color = mix(color, pow(ov.rgb, vec3(2.2)), oa);
  alpha = max(alpha, oa);

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class WaterMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  constructor(uniforms: SharedUniforms, sub: number, voxel = VOXEL.enabled) {
    this.geometry = voxel ? buildBlockGeometry() : buildWaterGeometry(sub);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uShallowCol: { value: new THREE.Color(0x3f7f86).convertSRGBToLinear() },
          uDeepCol: { value: new THREE.Color(0x0d2f47).convertSRGBToLinear() },
          uAmbient: { value: 1 },
        },
      ]),
      vertexShader: voxel ? V_WATER_VERT : VERT,
      fragmentShader: voxel ? V_WATER_FRAG : FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      // 地形と同じ理由 (境界面1枚を共有し、外向きが面ごとに反転する)
      side: THREE.DoubleSide,
    });
    // 共有ユニフォームは参照をそのまま持たせる (merge するとコピーされてしまう)
    Object.assign(this.material.uniforms, uniforms);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'water';
  }

  setAmbient(v: number): void {
    this.material.uniforms.uAmbient.value = v;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
