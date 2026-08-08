import { clamp } from '../core/rng';
import type { World } from '../world/world';
import type { Building, BuildingKind } from './buildings';

interface CropSpec {
  /** 生育に必要な湿潤度 */
  need: number;
  /** 収穫までの日数 (最適条件) */
  growDays: number;
  /** 1回の収穫量 (food) */
  yieldAmount: number;
  /** 耐えられる湛水深 (m) */
  floodTolerance: number;
  /** 枯れる速さ */
  witherRate: number;
  name: string;
}

export const CROPS: Partial<Record<BuildingKind, CropSpec>> = {
  farm: { need: 0.35, growDays: 12, yieldAmount: 9, floodTolerance: 0.22, witherRate: 0.06, name: '畑作物' },
  paddy: { need: 0.8, growDays: 18, yieldAmount: 18, floodTolerance: 0.6, witherRate: 0.045, name: '稲' },
};

export interface AgriStats {
  fields: number;
  growing: number;
  withering: number;
  drowned: number;
  /** 直近に収穫された食料 */
  harvested: number;
  /** 平均生育度 */
  avgGrowth: number;
}

export class Agriculture {
  stats: AgriStats = { fields: 0, growing: 0, withering: 0, drowned: 0, harvested: 0, avgGrowth: 0 };

  constructor(private world: World) {}

  /**
   * @returns 収穫された食料量
   */
  update(hours: number, tempC: number): number {
    const w = this.world;
    let harvested = 0;
    let fields = 0;
    let growing = 0;
    let withering = 0;
    let drowned = 0;
    let sumGrowth = 0;

    // 気温による生育係数 (5℃以下は休眠、35℃超で失速)
    const temp = clamp((tempC - 4) / 16, 0, 1) * clamp((40 - tempC) / 8, 0, 1);

    for (const b of w.buildings.values()) {
      const spec = CROPS[b.kind];
      if (!spec) continue;
      fields++;
      const i = w.idx(b.x, b.y);
      const m = w.moisture[i];
      const depth = w.water[i];

      if (depth > spec.floodTolerance) {
        // 冠水: 作物が傷む
        drowned++;
        b.growth = Math.max(0, b.growth - (depth - spec.floodTolerance) * 0.5 * hours);
        sumGrowth += b.growth;
        continue;
      }

      if (m >= spec.need && temp > 0.02) {
        // 必要量を大きく超える湿りは多少ボーナス
        const vigor = clamp(0.55 + (m - spec.need) / (1 - spec.need) * 0.6, 0, 1.25);
        const rate = (1 / (spec.growDays * 24)) * vigor * temp * b.hp;
        b.growth += rate * hours;
        growing++;
        if (b.growth >= 1) {
          b.growth = 0;
          harvested += spec.yieldAmount;
        }
      } else {
        withering++;
        b.growth = Math.max(0, b.growth - spec.witherRate * hours * (1 - m));
      }
      sumGrowth += b.growth;
    }

    this.stats = {
      fields,
      growing,
      withering,
      drowned,
      harvested,
      avgGrowth: fields > 0 ? sumGrowth / fields : 0,
    };
    return harvested;
  }

  /** UI 用: この農地の状態を説明する */
  describe(b: Building): string {
    const spec = CROPS[b.kind];
    if (!spec) return '';
    const i = this.world.idx(b.x, b.y);
    const m = this.world.moisture[i];
    const depth = this.world.water[i];
    if (depth > spec.floodTolerance) return `冠水中 (${depth.toFixed(2)}m) — 作物が傷んでいる`;
    if (m < spec.need) return `水不足 (湿潤 ${(m * 100) | 0}% / 必要 ${(spec.need * 100) | 0}%)`;
    return `生育中 ${(b.growth * 100) | 0}% (湿潤 ${(m * 100) | 0}%)`;
  }
}
