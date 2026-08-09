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
import { CELL, MAP } from '../../config';
import { FIELD_GLSL, SKY_GLSL } from './glsl';
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

  float speed = length(vFlow);
  vec2 dir = speed > 0.02 ? vFlow / speed : vec2(0.0, 1.0);
  float agitation = clamp(speed * 0.55, 0.0, 1.6) + 0.12;

  // --- 波 (流れに乗せて 2 枚重ねる) ---
  vec3 w1 = waveNormal(vWPos.xz, dir, 0.055, 5.0, uTime);
  vec3 w2 = waveNormal(vWPos.xz + vec2(37.0, 11.0), dir, 0.145, 8.5, uTime);
  vec3 w3 = waveNormal(vWPos.xz, vec2(dir.y, -dir.x), 0.021, 1.2, uTime);
  vec2 wave = (w1.xy * 0.55 + w2.xy * 0.35 + w3.xy * 0.45) * agitation;
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
  // 水際 (ごく浅いところ) と早瀬だけ白くする
  float shore = (1.0 - smoothstep(0.015, 0.12, vDepth)) * smoothstep(0.15, 0.8, speed);
  float rapids = smoothstep(1.4, 3.6, speed);
  float foam = clamp(shore * foamTexB * 0.5 + rapids * (0.3 + 0.7 * foamTexA), 0.0, 1.0);
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

export class WaterMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  constructor(uniforms: SharedUniforms, sub: number) {
    this.geometry = buildWaterGeometry(sub);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uShallowCol: { value: new THREE.Color(0x3f7f86).convertSRGBToLinear() },
          uDeepCol: { value: new THREE.Color(0x0d2f47).convertSRGBToLinear() },
          uAmbient: { value: 1 },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
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
