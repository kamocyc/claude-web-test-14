import { HYDRO, IRRIGATION } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';

/**
 * Timberborn 方式の灌漑モデル。
 *
 * 水面 (川・水路・湛水) を水源として、そこから最大 RANGE セルまで湿潤が広がる。
 * ただし水面より CLIMB[m] 以上高い土地へは登れないので、段丘の上を潤すには
 * 水路を掘って水を引き上げる必要がある。
 */
export class Moisture {
  /** 目標湿潤度 (0..1) */
  readonly target: Float32Array;
  private dist: Int16Array;
  private srcLevel: Float32Array;
  private buckets: number[][];

  constructor(private world: World) {
    const n = world.w * world.h;
    this.target = new Float32Array(n);
    this.dist = new Int16Array(n);
    this.srcLevel = new Float32Array(n);
    this.buckets = Array.from({ length: IRRIGATION.RANGE + 1 }, () => []);
  }

  /** 目標湿潤度を再計算する (数ゲーム時間に一度でよい) */
  compute(): void {
    const w = this.world;
    const W = w.w;
    const H = w.h;
    const R = IRRIGATION.RANGE;
    const dist = this.dist;
    const srcLevel = this.srcLevel;

    dist.fill(R + 1);
    for (const b of this.buckets) b.length = 0;

    // 水源の登録
    for (let i = 0; i < w.water.length; i++) {
      if (w.water[i] >= IRRIGATION.SOURCE_DEPTH) {
        dist[i] = 0;
        srcLevel[i] = w.solid[i] + w.water[i];
        this.buckets[0].push(i);
      }
    }

    // 距離順 BFS (バケットキュー)
    for (let d = 0; d < R; d++) {
      const bucket = this.buckets[d];
      for (let bi = 0; bi < bucket.length; bi++) {
        const i = bucket[bi];
        if (dist[i] !== d) continue;
        const x = i % W;
        const y = (i / W) | 0;
        const lvl = srcLevel[i];
        const limit = lvl + IRRIGATION.CLIMB;

        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (dist[j] <= d + 1) continue;
          // 水面より高すぎる土地へは水は染み出さない
          if (w.height[j] > limit) continue;
          dist[j] = d + 1;
          srcLevel[j] = lvl;
          this.buckets[d + 1].push(j);
        }
      }
    }

    // 距離 → 目標湿潤度
    const soilCap = HYDRO.SOIL_CAPACITY;
    for (let i = 0; i < this.target.length; i++) {
      const d = dist[i];
      let t = 0;
      if (d <= R) {
        const f = d / R;
        t = 1 - f * f * 0.92;
      }
      // 土壌に残った水分も最低限の潤いを与える (雨上がりの畑)
      const ground = clamp(w.soil[i] / soilCap, 0, 1) * 0.42;
      this.target[i] = Math.max(t, ground);
    }
  }

  /** 実際の湿潤度を目標値へ近づける (乾く方が遅い = 保水) */
  apply(hours: number): void {
    const m = this.world.moisture;
    const t = this.target;
    const wet = clamp(IRRIGATION.WET_RATE * hours, 0, 1);
    const dry = clamp(IRRIGATION.DRY_RATE * hours, 0, 1);
    for (let i = 0; i < m.length; i++) {
      const d = t[i] - m[i];
      m[i] += d > 0 ? d * wet : d * dry;
    }
  }

  /** 灌漑されている面積 (セル数) */
  irrigatedCells(threshold = 0.35): number {
    const m = this.world.moisture;
    let c = 0;
    for (let i = 0; i < m.length; i++) if (m[i] >= threshold) c++;
    return c;
  }
}
