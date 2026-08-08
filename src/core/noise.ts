import { RNG } from './rng';

/** 勾配ノイズ (Perlin 2D)。地形生成の土台。 */
export class Perlin {
  private perm = new Uint8Array(512);

  constructor(rng: RNG) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private grad(hash: number, x: number, y: number): number {
    // 8方向の勾配ベクトル
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  /** [-1, 1] */
  noise(x: number, y: number): number {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = Perlin.fade(xf);
    const v = Perlin.fade(yf);
    const p = this.perm;
    const aa = p[p[xi] + yi];
    const ab = p[p[xi] + yi + 1];
    const ba = p[p[xi + 1] + yi];
    const bb = p[p[xi + 1] + yi + 1];
    const x1 = lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u);
    const x2 = lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 1.4;
  }

  /**
   * フラクタルブラウン運動 — 自然な起伏。
   *
   * 格子ノイズは軸に沿った縞を生みやすいので、オクテーブルごとに座標系を回転させて
   * アーティファクトの向きを揃わなくする (回転させないと、格子状に並んだ谷ができて
   * 支流が不自然な平行線になる)。
   */
  fbm(x: number, y: number, octaves = 6, lacunarity = 2.02, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(px * freq + o * 17.3, py * freq - o * 9.1);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
      [px, py] = rotate(px, py);
    }
    return sum / norm;
  }

  /** リッジノイズ — 尾根の立った山岳地形 */
  ridged(x: number, y: number, octaves = 5, lacunarity = 2.05, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    let px = x;
    let py = y;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(px * freq + o * 23.7, py * freq + o * 5.9));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
      [px, py] = rotate(px, py);
    }
    return sum / norm;
  }
}

/** オクターブごとの座標回転 (約 37°) */
const ROT_COS = Math.cos(0.6523);
const ROT_SIN = Math.sin(0.6523);

function rotate(x: number, y: number): [number, number] {
  return [x * ROT_COS - y * ROT_SIN, x * ROT_SIN + y * ROT_COS];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
