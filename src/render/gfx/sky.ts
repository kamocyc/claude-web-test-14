/**
 * 空・太陽・環境光・雲・降水。
 *
 * ゲーム内時刻から太陽の方向を決め、その高度で空の色 (天頂/地平/太陽) を
 * 作る。同じ色を水面の反射にも渡しているので、夕焼けは川面にも映る。
 * 空から PMREM で環境マップを作って scene.environment に入れているため、
 * 地形も建物も「空の色で」照らされる。
 */
import * as THREE from 'three';
import { WEATHER } from '../../config';
import { clamp } from '../../core/rng';
import type { SkyKind } from '../../sim/weather';
import { SKY_GLSL } from './glsl';
import { createTextures } from './textures';
import type { SharedUniforms } from './uniforms';

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // 常に最遠面
}
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGroundCol;
uniform float uTime;
uniform float uCloud;      // 雲量 0..1
uniform float uCloudDark;  // 雲の暗さ 0..1
uniform sampler2D uDetailTex;
varying vec3 vDir;

#include <common>
${SKY_GLSL}

float cloudFbm(vec2 p) {
  float s = 0.0;
  s += texture2D(uDetailTex, p * 0.06).g * 0.5;
  s += texture2D(uDetailTex, p * 0.14 + vec2(0.31, 0.17)).g * 0.28;
  s += texture2D(uDetailTex, p * 0.34 + vec2(0.77, 0.41)).r * 0.14;
  s += texture2D(uDetailTex, p * 0.9).r * 0.08;
  return s;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyRadiance(dir, uSunDir, uZenith, uHorizon, uGroundCol, uSunColor);

  // 雲: 高度 1 の平面へ投影して流す
  if (uCloud > 0.001 && dir.y > 0.005) {
    vec2 cp = dir.xz / max(dir.y, 0.02) * 0.55 + vec2(uTime * 0.0035, uTime * 0.0016);
    float n = cloudFbm(cp);
    float cover = smoothstep(0.62 - uCloud * 0.42, 0.92 - uCloud * 0.30, n);
    cover *= smoothstep(0.0, 0.16, dir.y);
    float lit = clamp(dot(dir, uSunDir) * 0.5 + 0.6, 0.0, 1.0);
    vec3 cloudCol = mix(vec3(0.30, 0.33, 0.38), vec3(1.05, 1.02, 0.98), lit);
    cloudCol = mix(cloudCol, cloudCol * 0.35, uCloudDark);
    cloudCol *= mix(0.25, 1.0, clamp(uSunDir.y * 2.2 + 0.35, 0.0, 1.0));
    col = mix(col, cloudCol, cover * clamp(uCloud * 1.25, 0.0, 0.96));
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RAIN_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uOrigin;
uniform float uFall;
uniform float uArea;
uniform float uHeight;
uniform float uSize;
attribute vec3 seed;
varying float vAlpha;
void main() {
  // 粒は注視点まわりの箱の中を落ち続ける (箱ごと追従させ、はみ出したら反対側へ回す)
  float span = uArea;
  float x0 = uOrigin.x - span * 0.5;
  float z0 = uOrigin.z - span * 0.5;
  vec3 p;
  p.x = x0 + mod(seed.x * span - x0, span);
  p.z = z0 + mod(seed.z * span - z0, span);
  float t = fract(seed.y + uTime * uFall * (0.7 + seed.x * 0.6));
  p.y = uOrigin.y + uHeight * (1.0 - t) - uHeight * 0.25;
  p.x += t * uHeight * 0.10; // 斜めに降る
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (300.0 / max(-mv.z, 1.0));
  vAlpha = clamp(1.0 - length(mv.xyz) / (span * 0.75), 0.0, 1.0);
}
`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.0, length(vec2(d.x * 3.0, d.y)));
  gl_FragColor = vec4(uColor, m * vAlpha * uOpacity);
}
`;

interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  ground: THREE.Color;
  sunIntensity: number;
  ambient: number;
  fog: THREE.Color;
}

function mixColor(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return a.clone().lerp(b, t);
}

const C = (hex: number): THREE.Color => new THREE.Color(hex).convertSRGBToLinear();

const NIGHT: SkyPalette = {
  zenith: C(0x0a1120),
  horizon: C(0x1b2a42),
  sun: C(0xb8caea),
  ground: C(0x0b1018),
  sunIntensity: 0.35,
  ambient: 0.46,
  fog: C(0x16233a),
};
const DUSK: SkyPalette = {
  zenith: C(0x3d5da0),
  horizon: C(0xf0a878),
  sun: C(0xffb070),
  ground: C(0x2a2118),
  sunIntensity: 1.6,
  ambient: 0.8,
  fog: C(0x9a7a72),
};
const DAY: SkyPalette = {
  zenith: C(0x2f6bc0),
  horizon: C(0xbdd6ea),
  sun: C(0xfff3df),
  ground: C(0x3a3d38),
  sunIntensity: 3.6,
  ambient: 1.0,
  fog: C(0xa9c2d6),
};

function lerpPalette(a: SkyPalette, b: SkyPalette, t: number): SkyPalette {
  return {
    zenith: mixColor(a.zenith, b.zenith, t),
    horizon: mixColor(a.horizon, b.horizon, t),
    sun: mixColor(a.sun, b.sun, t),
    ground: mixColor(a.ground, b.ground, t),
    sunIntensity: a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t,
    ambient: a.ambient + (b.ambient - a.ambient) * t,
    fog: mixColor(a.fog, b.fog, t),
  };
}

export interface SkyState {
  /** 太陽 (夜は月) の高度 -1..1 */
  elevation: number;
  /** 昼夜 0..1 (1 = 昼) */
  daylight: number;
  ambient: number;
  fogColor: THREE.Color;
}

export class SkyEnv {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  readonly dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastEnvElev = -99;
  private rain: THREE.Points;
  private rainMat: THREE.ShaderMaterial;
  state: SkyState = {
    elevation: 0.5,
    daylight: 1,
    ambient: 1,
    fogColor: DAY.fog.clone(),
  };

  constructor(private uniforms: SharedUniforms) {
    const tex = createTextures();
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: uniforms.uSunDir,
        uSunColor: uniforms.uSunColor,
        uZenith: uniforms.uZenith,
        uHorizon: uniforms.uHorizon,
        uGroundCol: uniforms.uGroundCol,
        uTime: uniforms.uTime,
        uCloud: { value: 0.25 },
        uCloudDark: { value: 0 },
        uDetailTex: { value: tex.detail },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const domeGeo = new THREE.SphereGeometry(1, 40, 24);
    this.dome = new THREE.Mesh(domeGeo, this.domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.group.add(this.dome);

    // 環境マップ生成用 (同じマテリアルを共有した別メッシュ)
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.domeMat);
    envDome.frustumCulled = false;
    this.envScene.add(envDome);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.8;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 3000;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbcd4ee, 0x39321f, 0.35);
    this.group.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.08);
    this.group.add(this.ambient);

    // --- 降水 ---
    const COUNT = 9000;
    const geo = new THREE.BufferGeometry();
    const seeds = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) seeds[i] = Math.random();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uOrigin: { value: new THREE.Vector3() },
        uFall: { value: 0.55 },
        uArea: { value: 260 },
        uHeight: { value: 190 },
        uSize: { value: 1.6 },
        uColor: { value: new THREE.Color(0xdce9f5) },
        uOpacity: { value: 0 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.rain = new THREE.Points(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    this.group.add(this.rain);
  }

  /** 時刻 (0..24) と天気から光を決める */
  update(opt: {
    hour: number;
    day: number;
    kind: SkyKind;
    rainRate: number;
    scene: THREE.Scene;
    renderer: THREE.WebGLRenderer;
    focus: THREE.Vector3;
    cameraPos: THREE.Vector3;
    viewRadius: number;
    /** マップ中心 (影のカメラをここに固定する) */
    mapCenter: THREE.Vector3;
    /** マップ全体を覆う半径 (m) */
    mapRadius: number;
    shadows: boolean;
  }): void {
    const u = this.uniforms;
    // 太陽: 6時に東、12時に南中、18時に西
    const t = ((opt.hour - 6) / 12) * Math.PI;
    // 季節でわずかに南中高度を変える
    const seasonT = (opt.day % WEATHER.DAYS_PER_YEAR) / WEATHER.DAYS_PER_YEAR;
    const tilt = 0.22 + 0.14 * Math.sin((seasonT - 0.25) * Math.PI * 2);
    const elev = Math.sin(t);
    const dir = new THREE.Vector3(Math.cos(t), Math.sin(t), -tilt * 1.6).normalize();

    const night = elev < 0;
    // 夜は月 (太陽の反対側) を光源にする
    const lightDir = night ? dir.clone().multiplyScalar(-1).setY(Math.max(0.28, -elev * 0.7)).normalize() : dir;

    let pal: SkyPalette;
    if (elev > 0.3) pal = DAY;
    else if (elev > 0.02) pal = lerpPalette(DUSK, DAY, (elev - 0.02) / 0.28);
    else if (elev > -0.26) pal = lerpPalette(NIGHT, DUSK, (elev + 0.26) / 0.28);
    else pal = NIGHT;

    // 天気で減光・彩度低下
    const overcast =
      opt.kind === 'storm' ? 0.95 : opt.kind === 'heavy' ? 0.85 : opt.kind === 'rain' || opt.kind === 'snow' ? 0.7 : opt.kind === 'cloudy' ? 0.45 : 0.14;
    const gray = C(0x6b7684);
    const dim = 1 - overcast * 0.62;
    pal = {
      zenith: mixColor(pal.zenith, gray.clone().multiplyScalar(0.5), overcast * 0.72),
      horizon: mixColor(pal.horizon, gray, overcast * 0.7),
      sun: pal.sun,
      ground: pal.ground,
      sunIntensity: pal.sunIntensity * dim,
      ambient: pal.ambient * (1 - overcast * 0.35),
      fog: mixColor(pal.fog, gray.clone().multiplyScalar(0.75), overcast * 0.75),
    };

    u.uSunDir.value.copy(lightDir);
    u.uSunColor.value.copy(pal.sun);
    u.uZenith.value.copy(pal.zenith);
    u.uHorizon.value.copy(pal.horizon);
    u.uGroundCol.value.copy(pal.ground);

    this.domeMat.uniforms.uCloud.value = clamp(overcast * 1.15, 0.05, 0.98);
    this.domeMat.uniforms.uCloudDark.value = clamp(overcast * 1.1 - 0.35, 0, 1);

    // 光源。影のカメラはマップ全体を覆う位置に固定する。
    // (視点に追従させて範囲を絞ると、シャドウマップの外側が「常に影」と判定され、
    //  遠景が一様に暗くなってしまう)
    const dist = Math.max(900, opt.viewRadius * 2);
    this.sun.position.copy(opt.mapCenter).addScaledVector(lightDir, dist);
    this.sun.target.position.copy(opt.mapCenter);
    this.sun.target.updateMatrixWorld();
    this.sun.color.copy(night ? C(0x9db7e0) : pal.sun);
    this.sun.intensity = night ? 0.75 * (1 - overcast * 0.5) : pal.sunIntensity;
    this.sun.castShadow = opt.shadows && !night && pal.sunIntensity > 0.35;

    const shadowSpan = opt.mapRadius;
    const cam = this.sun.shadow.camera;
    if (cam.right !== shadowSpan || cam.far !== dist * 2.2) {
      cam.left = -shadowSpan;
      cam.right = shadowSpan;
      cam.top = shadowSpan;
      cam.bottom = -shadowSpan;
      cam.near = Math.max(1, dist - shadowSpan * 2.5);
      cam.far = dist * 2.2;
      cam.updateProjectionMatrix();
    }

    this.hemi.color.copy(pal.horizon);
    this.hemi.groundColor.copy(pal.ground);
    this.hemi.intensity = 0.5 + pal.ambient * 0.75;
    this.ambient.intensity = 0.12 + pal.ambient * 0.1;

    // 天球はカメラに追従させる
    this.dome.position.copy(opt.cameraPos);
    this.dome.scale.setScalar(Math.max(400, opt.viewRadius * 6));

    // 霧。雨で濃くしすぎると遠景が一様に霞んで、川筋も地形も読めなくなる
    const fogDensity = 0.00012 + overcast * 0.00025 + Math.min(opt.rainRate, 40) * 0.000012;
    const fog = opt.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(pal.fog);
      fog.density = fogDensity;
    }
    opt.renderer.toneMappingExposure = night ? 1.7 : 1.15 + overcast * 0.2;

    // 降水
    const isSnow = opt.kind === 'snow';
    const amount = clamp(opt.rainRate / 22, 0, 1);
    // 雨粒は画面全体に重なるので、濃く青いと地表が青いベールで覆われてしまう。
    // 粒は薄め・色は中間色にして、雨だと分かる程度にとどめる。
    this.rainMat.uniforms.uOpacity.value = amount * (isSnow ? 0.85 : 0.4);
    const area = clamp(opt.viewRadius * 0.9, 150, 700);
    this.rainMat.uniforms.uArea.value = area;
    this.rainMat.uniforms.uHeight.value = area * 0.8;
    this.rainMat.uniforms.uOrigin.value
      .copy(opt.focus)
      .lerp(opt.cameraPos, 0.45)
      .setY(Math.max(opt.focus.y, opt.cameraPos.y * 0.5) + area * 0.25);
    this.rainMat.uniforms.uFall.value = isSnow ? 0.1 : 0.85;
    this.rainMat.uniforms.uSize.value = isSnow ? 3.4 : 1.5;
    this.rainMat.uniforms.uColor.value.set(isSnow ? 0xffffff : 0xdfe5ea);
    this.rain.visible = amount > 0.01;

    this.state = {
      elevation: elev,
      daylight: clamp(elev * 4 + 0.35, 0, 1),
      ambient: pal.ambient,
      fogColor: pal.fog,
    };

    this.updateEnvironment(opt.renderer, opt.scene, elev, overcast);
  }

  /** 空から環境マップを焼く。太陽が動いたときだけやり直す。 */
  private updateEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, elev: number, overcast: number): void {
    const key = elev * 10 + overcast;
    if (Math.abs(key - this.lastEnvElev) < 0.02) return;
    this.lastEnvElev = key;
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(renderer);
      this.pmrem.compileEquirectangularShader();
    }
    const prev = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene);
    scene.environment = this.envTarget.texture;
    scene.environmentIntensity = 0.85;
    prev?.dispose();
  }

  dispose(): void {
    this.domeMat.dispose();
    this.dome.geometry.dispose();
    this.rainMat.dispose();
    this.rain.geometry.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
  }
}
