/**
 * 描画に使うテクスチャは外部アセットを持たず、すべて起動時に手続き的に生成する。
 * (タイル可能なノイズ + そこから作った法線マップ)
 *
 * タイル可能にするため、格子ノイズは座標を size で剰余をとる「周期的値ノイズ」に
 * している。単純な hash ノイズを繰り返すと継ぎ目が出るため。
 */
import * as THREE from 'three';

function hash2(ix: number, iy: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 周期 period のタイル可能な値ノイズ */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, period, seed);
  const b = hash2(ix + 1, iy, period, seed);
  const c = hash2(ix, iy + 1, period, seed);
  const d = hash2(ix + 1, iy + 1, period, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** タイル可能な fBm。freq は「テクスチャ1枚あたりの格子数」 */
function fbm(u: number, v: number, freq: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * f, v * f, f, seed + o * 17);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** リッジノイズ (岩肌の筋に使う) */
function ridged(u: number, v: number, freq: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    const n = Math.abs(valueNoise(u * f, v * f, f, seed + o * 31) * 2 - 1);
    sum += amp * (1 - n);
    norm += amp;
    amp *= 0.55;
    f *= 2;
  }
  return sum / norm;
}

function makeTexture(size: number, fill: (i: number, u: number, v: number, px: Uint8Array) => void): THREE.DataTexture {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      fill(i, x / size, y / size, px);
    }
  }
  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** 高さ場 → 法線マップ (タイル可能) */
function normalFromHeight(size: number, height: Float32Array, strength: number): THREE.DataTexture {
  const px = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      px[i] = ((dx / len) * 0.5 + 0.5) * 255;
      px[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      px[i + 2] = (1 / len) * 0.5 * 255 + 127;
      px[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export interface GfxTextures {
  /** R=細かい粒 G=中スケールの斑 B=岩の筋 A=植生の疎密 */
  detail: THREE.DataTexture;
  /** 地表のマイクロ凹凸 */
  detailNormal: THREE.DataTexture;
  /** 波 (2枚重ねてスクロールさせる) */
  waveNormal: THREE.DataTexture;
  /** 泡 */
  foam: THREE.DataTexture;
}

let cached: GfxTextures | null = null;

export function createTextures(): GfxTextures {
  if (cached) return cached;

  const S = 256;
  const detail = makeTexture(S, (i, u, v, px) => {
    const fine = fbm(u, v, 32, 4, 11);
    const macro = fbm(u, v, 4, 4, 23);
    const rock = ridged(u, v, 12, 4, 37);
    const veg = fbm(u, v, 8, 3, 51, 0.6);
    px[i] = fine * 255;
    px[i + 1] = macro * 255;
    px[i + 2] = rock * 255;
    px[i + 3] = veg * 255;
  });

  // 地表の凹凸: 細かい粒 + 中スケールのうねり
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      h[y * S + x] = fbm(u, v, 24, 4, 71) * 0.7 + fbm(u, v, 6, 3, 91) * 0.3;
    }
  }
  const detailNormal = normalFromHeight(S, h, 2.6);

  // 波: 引き伸ばした 2 方向のうねりを合成する (等方的なノイズだと油膜に見える)
  const wh = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      wh[y * S + x] =
        fbm(u, v, 8, 3, 131) * 0.55 +
        fbm(u * 1, v, 16, 2, 151) * 0.3 +
        Math.sin((u * 6 + fbm(u, v, 4, 2, 171) * 2.2) * Math.PI * 2) * 0.08;
    }
  }
  const waveNormal = normalFromHeight(S, wh, 1.5);

  const foam = makeTexture(128, (i, u, v, px) => {
    const n = fbm(u, v, 10, 4, 191);
    const c = Math.pow(Math.max(0, n * 1.5 - 0.35), 1.4) * 255;
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = Math.min(255, c);
  });

  cached = { detail, detailNormal, waveNormal, foam };
  return cached;
}
