import { CITY, HYDRO } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';
import {
  BUILDINGS,
  INTAKE_CAPACITY,
  TOWER_CAPACITY,
  TREATMENT_CAPACITY,
  WELL_CAPACITY,
  type Building,
} from './buildings';

export interface NetworkStats {
  /** 総需要 (m^3/h) */
  demand: number;
  /** 実際に給水できた量 (m^3/h) */
  served: number;
  /** うち浄水済みの割合 0..1 */
  quality: number;
  /** 配水池の貯留量と容量 */
  stored: number;
  capacity: number;
  /** 給水されている住宅の割合 */
  connected: number;
  netCount: number;
}

/** 連結成分ごとの要約 (UI で「この水道網に供給源があるか」を示すため) */
export interface NetInfo {
  supply: number;
  demand: number;
  stored: number;
  hasSource: boolean;
}

interface NetAgg {
  raw: number;
  well: number;
  treat: number;
  demand: number;
  towers: Building[];
  houses: Building[];
}

/**
 * 水道網。上水道の施設と住宅を「直交隣接」でつなぎ、連結成分ごとに
 * 取水 → 浄水 → 配水池 → 住宅 の水収支を解く。
 */
export class WaterNetwork {
  private parent = new Int32Array(0);
  private dirty = true;
  /** 連結成分 ID → 要約 */
  readonly netInfo = new Map<number, NetInfo>();
  stats: NetworkStats = {
    demand: 0,
    served: 0,
    quality: 1,
    stored: 0,
    capacity: 0,
    connected: 0,
    netCount: 0,
  };

  constructor(private world: World) {}

  markDirty(): void {
    this.dirty = true;
  }

  private find(a: number): number {
    let x = a;
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  private union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }

  /** 連結成分を再計算して各施設に net ID を振る */
  rebuild(): void {
    const w = this.world;
    const n = w.w * w.h;
    if (this.parent.length !== n) this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;

    for (const b of w.buildings.values()) {
      if (!BUILDINGS[b.kind].network) continue;
      const i = w.idx(b.x, b.y);
      // 右と下だけ見れば全ペアを網羅できる
      if (b.x + 1 < w.w) {
        const j = i + 1;
        const nb = w.buildingAt(b.x + 1, b.y);
        if (nb && BUILDINGS[nb.kind].network) this.union(i, j);
      }
      if (b.y + 1 < w.h) {
        const j = i + w.w;
        const nb = w.buildingAt(b.x, b.y + 1);
        if (nb && BUILDINGS[nb.kind].network) this.union(i, j);
      }
    }

    for (const b of w.buildings.values()) {
      b.net = BUILDINGS[b.kind].network ? this.find(w.idx(b.x, b.y)) : -1;
    }
    this.dirty = false;
  }

  /**
   * 1ゲーム時間ぶんの給水計算。
   * @param hours 経過ゲーム時間
   * @param droughtFactor 渇水度 (0..1, 1 = 平常)
   */
  update(hours: number, droughtFactor: number): NetworkStats {
    if (this.dirty) this.rebuild();
    const w = this.world;
    const nets = new Map<number, NetAgg>();

    const get = (id: number): NetAgg => {
      let a = nets.get(id);
      if (!a) {
        a = { raw: 0, well: 0, treat: 0, demand: 0, towers: [], houses: [] };
        nets.set(id, a);
      }
      return a;
    };

    let totalDemand = 0;
    let totalHouses = 0;

    for (const b of w.buildings.values()) {
      if (b.net < 0 || !b.active || b.hp <= 0.05) continue;
      const agg = get(b.net);
      switch (b.kind) {
        case 'intake': {
          // 近傍の水深に応じて取水量が決まる (川が涸れると取れない)
          const depth = w.maxWaterNear(b.x, b.y, 3);
          const factor = clamp(depth / 0.85, 0, 1);
          b.rate = INTAKE_CAPACITY * factor * b.hp;
          agg.raw += b.rate;
          break;
        }
        case 'well': {
          let soil = 0;
          let c = 0;
          for (const i of w.cellsInRadius(b.x, b.y, 3)) {
            soil += w.soil[i];
            c++;
          }
          const gw = clamp(soil / (c * HYDRO.SOIL_CAPACITY), 0, 1);
          b.rate = WELL_CAPACITY * (0.25 + 0.75 * gw) * droughtFactor * b.hp;
          agg.well += b.rate;
          break;
        }
        case 'treatment':
          b.rate = TREATMENT_CAPACITY * b.hp;
          agg.treat += b.rate;
          break;
        case 'tower':
          agg.towers.push(b);
          break;
        case 'house': {
          const pop = b.occupancy * CITY.HOUSE_CAPACITY;
          const d = pop * CITY.WATER_PER_CAPITA;
          agg.demand += d;
          totalDemand += d;
          totalHouses++;
          agg.houses.push(b);
          break;
        }
        default:
          break;
      }
    }

    this.netInfo.clear();
    let served = 0;
    let potableServed = 0;
    let stored = 0;
    let capacity = 0;
    let connectedHouses = 0;

    for (const [netId, agg] of nets) {
      const treated = Math.min(agg.raw, agg.treat);
      const untreated = agg.raw - treated;
      const potable = treated + agg.well;
      const supply = potable + untreated;
      const towerCap = agg.towers.length * TOWER_CAPACITY;
      let towerStore = agg.towers.reduce((s, t) => s + t.stored, 0);

      let deliver = Math.min(supply, agg.demand);
      let fromStore = 0;
      if (agg.demand > supply) {
        fromStore = Math.min(agg.demand - supply, towerStore / Math.max(hours, 1e-6));
        towerStore -= fromStore * hours;
        deliver += fromStore;
      } else {
        const surplus = (supply - agg.demand) * hours;
        towerStore = Math.min(towerCap, towerStore + surplus * 0.6);
      }

      // 配水池へ書き戻す
      if (agg.towers.length > 0) {
        const per = towerStore / agg.towers.length;
        for (const t of agg.towers) t.stored = clamp(per, 0, TOWER_CAPACITY);
      }

      const ratio = agg.demand > 0 ? clamp(deliver / agg.demand, 0, 1) : 1;
      const potableShare =
        deliver > 0 ? clamp((Math.min(potable, deliver) + fromStore * 0.9) / deliver, 0, 1) : 1;

      for (const hbld of agg.houses) {
        hbld.rate = ratio;
        if (ratio > 0.15) connectedHouses++;
      }

      this.netInfo.set(netId, {
        supply,
        demand: agg.demand,
        stored: towerStore,
        hasSource: agg.raw > 0 || agg.well > 0,
      });

      served += deliver;
      potableServed += deliver * potableShare;
      stored += towerStore;
      capacity += towerCap;
    }

    this.stats = {
      demand: totalDemand,
      served,
      quality: served > 0 ? potableServed / served : 1,
      stored,
      capacity,
      connected: totalHouses > 0 ? connectedHouses / totalHouses : 0,
      netCount: nets.size,
    };
    return this.stats;
  }
}
