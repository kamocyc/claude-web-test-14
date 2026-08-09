import { clamp } from '../core/rng';
import type { World } from '../world/world';

export type Overlay = 'none' | 'moisture' | 'hazard' | 'elevation' | 'network';

/**
 * オーバーレイ1枚ぶんの RGBA を書き込む。
 * 3D では地形シェーダへ渡すテクスチャに、ミニマップでは 2D の ImageData に使う。
 */
export function fillOverlay(world: World, mode: Overlay, px: Uint8Array | Uint8ClampedArray): void {
  const n = world.w * world.h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    switch (mode) {
      case 'moisture': {
        // 「どこに何が作れるか」が分かるよう、作物の要求値で色分けする
        const m = world.moisture[i];
        if (m >= 0.8) {
          r = 46;
          g = 200;
          b = 120;
          a = 190;
        } else if (m >= 0.35) {
          r = 190;
          g = 205;
          b = 70;
          a = 125;
        } else if (m >= 0.15) {
          r = 205;
          g = 130;
          b = 60;
          a = 70;
        }
        break;
      }
      case 'hazard': {
        const d = world.floodMax[i];
        if (d > 0.12) {
          const t = clamp(d / 2.2, 0, 1);
          r = 120 + 135 * t;
          g = 210 - 170 * t;
          b = 60;
          a = 70 + t * 165;
        }
        break;
      }
      case 'elevation': {
        const h = world.height[i];
        const t = clamp(h / Math.max(1, world.maxHeight), 0, 1);
        r = 30 + 225 * t;
        g = 60 + 120 * (1 - Math.abs(t - 0.5) * 2);
        b = 220 - 190 * t;
        a = 170;
        break;
      }
      case 'network': {
        const id = world.structure[i];
        if (id >= 0) {
          const bl = world.buildings.get(id);
          if (bl && bl.net >= 0) {
            const hue = (bl.net * 2654435761) % 360;
            const [rr, gg, bb] = hslToRgb(hue / 360, 0.7, 0.55);
            r = rr;
            g = gg;
            b = bb;
            a = 220;
          }
        }
        break;
      }
      default:
        break;
    }
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = a;
  }
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
