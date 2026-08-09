/**
 * シミュレーションのグリッド (標高・水深・流速…) を GPU へ渡すためのテクスチャ群。
 *
 * 地形も水面も頂点シェーダでこのテクスチャを読んで変位させる。こうすると
 * 掘削や水位変化のたびに 15 万頂点を CPU で作り直さずに済み、毎フレームの
 * 更新が「36k 要素のコピー」だけで終わる。
 *
 * 浮動小数テクスチャは WebGL2 では線形補間できない (OES_texture_float_linear が要る)
 * ので、NearestFilter で読み、シェーダ側で自前のバイリニア補間を行う。
 * 水面標高は cm 単位の精度が要るため half-float では足りない。
 */
import * as THREE from 'three';
import { clamp } from '../../core/rng';
import type { World } from '../../world/world';
import type { Overlay } from '../overlay';
import { fillOverlay } from '../overlay';

function floatTex(w: number, h: number, ch: 1 | 4): THREE.DataTexture {
  const data = new Float32Array(w * h * ch);
  const tex = new THREE.DataTexture(data, w, h, ch === 1 ? THREE.RedFormat : THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function byteTex(w: number, h: number, linear: boolean): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  tex.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class FieldTextures {
  /** R = 地形標高 (m, 構造物を含まない素の地面) */
  readonly height: THREE.DataTexture;
  /** R = 水面標高, G = 水深, B/A = 流速 (m/s) */
  readonly water: THREE.DataTexture;
  /** R = 河道, G = 流域面積(対数), B = 湿潤度, A = 浸水履歴 */
  readonly surface: THREE.DataTexture;
  /** オーバーレイ (RGBA) */
  readonly overlay: THREE.DataTexture;

  private terrainVersion = -1;
  private surfaceAge = 999;
  private overlayAge = 999;
  private lastOverlay: Overlay | null = null;
  private maxFlowLog = 1;

  constructor(private world: World) {
    const { w, h } = world;
    this.height = floatTex(w, h, 1);
    this.water = floatTex(w, h, 4);
    this.surface = byteTex(w, h, true);
    this.overlay = byteTex(w, h, true);

    let mx = 1;
    for (let i = 0; i < world.flowAcc.length; i++) {
      const v = Math.log(1 + world.flowAcc[i]);
      if (v > mx) mx = v;
    }
    this.maxFlowLog = mx;
    this.syncHeight(true);
    this.syncSurface();
  }

  /** 地形が変わったときだけ標高テクスチャを更新する */
  syncHeight(force = false): boolean {
    if (!force && this.terrainVersion === this.world.terrainVersion) return false;
    this.terrainVersion = this.world.terrainVersion;
    const dst = this.height.image.data as Float32Array;
    dst.set(this.world.height);
    this.height.needsUpdate = true;
    this.surfaceAge = 999;
    return true;
  }

  /** 毎フレーム: 水面・流速 */
  syncWater(): void {
    const w = this.world;
    const dst = this.water.image.data as Float32Array;
    const n = w.w * w.h;
    const solid = w.solid;
    const water = w.water;
    const vx = w.vx;
    const vy = w.vy;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const d = water[i];
      dst[o] = solid[i] + d;
      dst[o + 1] = d;
      dst[o + 2] = vx[i];
      dst[o + 3] = vy[i];
    }
    this.water.needsUpdate = true;
  }

  /** 湿潤・浸水履歴はゆっくりしか変わらないので間引いて更新する */
  syncSurface(): void {
    const w = this.world;
    const dst = this.surface.image.data as Uint8Array;
    const n = w.w * w.h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      dst[o] = w.riverMask[i] ? 255 : 0;
      dst[o + 1] = clamp((Math.log(1 + w.flowAcc[i]) / this.maxFlowLog) * 255, 0, 255);
      dst[o + 2] = clamp(w.moisture[i] * 255, 0, 255);
      dst[o + 3] = clamp((w.floodMax[i] / 2.5) * 255, 0, 255);
    }
    this.surface.needsUpdate = true;
    this.surfaceAge = 0;
  }

  syncOverlay(mode: Overlay): void {
    if (mode === 'none') return;
    this.overlayAge++;
    if (mode === this.lastOverlay && this.overlayAge < 12) return;
    fillOverlay(this.world, mode, this.overlay.image.data as Uint8Array);
    this.overlay.needsUpdate = true;
    this.lastOverlay = mode;
    this.overlayAge = 0;
  }

  /** 毎フレームの定期更新 */
  tick(overlay: Overlay): void {
    this.syncHeight();
    this.syncWater();
    if (++this.surfaceAge > 20) this.syncSurface();
    this.syncOverlay(overlay);
  }

  dispose(): void {
    this.height.dispose();
    this.water.dispose();
    this.surface.dispose();
    this.overlay.dispose();
  }
}
