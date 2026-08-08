import { CITY, HYDRO } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';
import { BUILDINGS, DRAINPUMP_RADIUS, DRAINPUMP_RATE, type Building } from './buildings';
import type { Hydrology } from './hydrology';

export type EventLevel = 'info' | 'warn' | 'danger' | 'good';

export interface GameEvent {
  id: number;
  level: EventLevel;
  text: string;
  day: number;
  hour: number;
}

export interface DamageReport {
  /** 越流している堤防・ダムの数 */
  overtopping: number;
  /** 決壊した構造物 */
  breached: number;
  /** 浸水している建物 */
  flooded: number;
  /** 失われた建物 */
  destroyed: number;
  /** ダムの売電収入 */
  hydroRevenue: number;
  /** 排水機場が汲み出した水量 (m^3) */
  pumped: number;
  /** 浸水セル数 */
  floodedCells: number;
  maxDepth: number;
}

/**
 * 越流・決壊・浸水被害の処理。
 * 「堤防は越流すると壊れる」ため、ただ高くするだけでは守れない。
 */
export class DamageSystem {
  private nextEventId = 1;
  readonly events: GameEvent[] = [];
  /** 同じ警告を連発しないためのクールダウン */
  private cooldown = new Map<string, number>();

  constructor(
    private world: World,
    private hydro: Hydrology,
  ) {}

  private emit(level: EventLevel, text: string, day: number, hour: number, key?: string): void {
    if (key) {
      const until = this.cooldown.get(key) ?? -1;
      const now = day * 24 + hour;
      if (now < until) return;
      this.cooldown.set(key, now + 12);
    }
    this.events.unshift({ id: this.nextEventId++, level, text, day, hour });
    if (this.events.length > 60) this.events.length = 60;
  }

  update(hours: number, day: number, hour: number): DamageReport {
    const w = this.world;
    const report: DamageReport = {
      overtopping: 0,
      breached: 0,
      flooded: 0,
      destroyed: 0,
      hydroRevenue: 0,
      pumped: 0,
      floodedCells: 0,
      maxDepth: 0,
    };

    const doomed: Building[] = [];

    for (const b of w.buildings.values()) {
      const def = BUILDINGS[b.kind];
      const i = w.idx(b.x, b.y);
      const depth = w.water[i];

      if (def.wallHeight > 0) {
        // --- 堰上げ構造物: 越流 → 損傷 → 決壊 -----------------------
        const speed = Math.hypot(w.vx[i], w.vy[i]);
        if (depth > 0.08) {
          report.overtopping++;
          const stress = (depth - 0.08) * (0.35 + speed * 0.5);
          b.hp -= stress * 0.16 * hours;
          if (b.hp <= 0) {
            doomed.push(b);
            report.breached++;
          } else if (b.hp < 0.45) {
            this.emit(
              'danger',
              `${def.name}が越流で損傷しています (${b.x},${b.y}) — 健全度 ${(b.hp * 100) | 0}%`,
              day,
              hour,
              `ot-${b.id}`,
            );
          }
        } else if (b.hp < 1) {
          b.hp = Math.min(1, b.hp + CITY.REPAIR_RATE * hours);
        }
        w.refreshSolid(i);

        // --- ダムの発電 -------------------------------------------
        if (b.kind === 'dam' && b.gate > 0.02) {
          const q = this.hydro.fluxMagnitude(b.x, b.y);
          const head = 16 * (1 - b.gate) + 4;
          const power = Math.min(q, 90) * head * 0.02;
          b.rate = power;
          report.hydroRevenue += power * hours * b.hp;
        }
        continue;
      }

      // --- 一般の建物: 浸水被害 ----------------------------------
      // 取水施設のように水際で使う施設は深い水にも耐える
      const tolerance = def.floodTolerance || CITY.FLOOD_DAMAGE_DEPTH;
      if (depth > tolerance) {
        report.flooded++;
        b.hp -= (depth - tolerance) * CITY.FLOOD_DAMAGE_RATE * hours;
        if (b.hp <= 0) doomed.push(b);
      } else if (b.hp < 1) {
        b.hp = Math.min(1, b.hp + CITY.REPAIR_RATE * hours);
      }

      // --- 排水機場 ----------------------------------------------
      if (b.kind === 'drainpump' && b.active && b.hp > 0.2) {
        const amount = DRAINPUMP_RATE * hours * b.hp;
        const v = this.hydro.drain(b.x, b.y, DRAINPUMP_RADIUS, amount);
        b.rate = v / Math.max(hours, 1e-6);
        report.pumped += v;
      }
    }

    for (const b of doomed) {
      const def = BUILDINGS[b.kind];
      w.removeBuilding(b.x, b.y);
      report.destroyed++;
      if (def.wallHeight > 0) {
        this.emit('danger', `${def.name}が決壊しました！ (${b.x},${b.y})`, day, hour);
      } else {
        this.emit('warn', `${def.name}が浸水で失われました (${b.x},${b.y})`, day, hour);
      }
    }

    // --- 浸水状況の集計 ------------------------------------------
    let cells = 0;
    let maxDepth = 0;
    const water = w.water;
    for (let i = 0; i < water.length; i++) {
      const d = water[i];
      // 平常時の水域と海面下は数えず、「普段は乾いている陸地が浸かった」面積だけを測る
      if (d > 0.3 && w.baselineWet[i] === 0 && w.height[i] > 1) cells++;
      if (d > maxDepth) maxDepth = d;
      if (d > w.floodMax[i]) w.floodMax[i] = d;
    }
    report.floodedCells = cells;
    report.maxDepth = maxDepth;
    return report;
  }

  /** 気象・水位から警報を出す */
  checkAlerts(day: number, hour: number, inflow: number, forecastPeak: number, drought: boolean): void {
    if (forecastPeak > 70 && inflow < forecastPeak * 0.6) {
      this.emit(
        'warn',
        `洪水予測: 数日以内に流入量が ${forecastPeak.toFixed(0)} m³/s に達する見込み。ダムを事前放流して容量を空けましょう。`,
        day,
        hour,
        'forecast-flood',
      );
    }
    if (inflow > 95) {
      this.emit('danger', `氾濫危険水位! 流入量 ${inflow.toFixed(0)} m³/s`, day, hour, 'flood-now');
    }
    if (drought) {
      this.emit(
        'warn',
        '渇水が続いています。ダムの放流量を絞り、貯水を確保してください。',
        day,
        hour,
        'drought',
      );
    }
  }

  info(text: string, day: number, hour: number, level: EventLevel = 'info'): void {
    this.emit(level, text, day, hour);
  }
}

/** 浸水深から危険度の色を返す */
export function depthColor(depth: number): string {
  const t = clamp(depth / 2.5, 0, 1);
  if (depth < HYDRO.EPS_DEPTH) return 'transparent';
  const r = Math.round(60 - 30 * t);
  const g = Math.round(150 - 90 * t);
  const b = Math.round(220 - 60 * t);
  return `rgb(${r},${g},${b})`;
}
