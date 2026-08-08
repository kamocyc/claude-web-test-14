import {
  HOURS_PER_REAL_SEC,
  HOUR_HYDRO_SECONDS,
  HYDRO,
  SPEEDS,
  TIME_COMPRESSION,
  WEATHER,
} from '../config';
import { clamp } from '../core/rng';
import { generateTerrain } from '../world/terrain';
import { World } from '../world/world';
import { Agriculture } from './agriculture';
import { BUILDINGS, type BuildingKind, type Building } from './buildings';
import { City, type CityStats } from './city';
import { DamageSystem, type DamageReport } from './damage';
import { Hydrology } from './hydrology';
import { Moisture } from './moisture';
import { WaterNetwork, type NetworkStats } from './network';
import { Weather } from './weather';

export { HOUR_HYDRO_SECONDS };

export interface SimSnapshot {
  city: CityStats;
  net: NetworkStats;
  damage: DamageReport;
  inflow: number;
  outflow: number;
  moistureCells: number;
  fields: number;
  cropGrowth: number;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export class Simulation {
  readonly world: World;
  readonly hydro: Hydrology;
  readonly moisture: Moisture;
  readonly weather: Weather;
  readonly network: WaterNetwork;
  readonly agriculture: Agriculture;
  readonly city: City;
  readonly damage: DamageSystem;

  speedIndex = 1;
  private hourAcc = 0;
  private hoursSinceMoisture = 99;
  private outflowPerHour = 0;
  private pendingBaseflow = 0;

  snapshot: SimSnapshot;

  constructor(readonly seed: number, quality = 1) {
    const terrain = generateTerrain(seed, undefined, undefined, quality);
    this.world = new World(terrain);
    this.hydro = new Hydrology(this.world);
    this.moisture = new Moisture(this.world);
    this.weather = new Weather(seed);
    this.network = new WaterNetwork(this.world);
    this.agriculture = new Agriculture(this.world);
    this.city = new City(this.world);
    this.damage = new DamageSystem(this.world, this.hydro);

    // 初期状態を落ち着かせる。初期水は多めに撒いてあるので、定常状態
    // (源流からの流入と海への流出が釣り合う状態) になるまで十分に回す。
    // ここが短いと、始めた直後は水があるのに数日で細い支流が涸れてしまう。
    this.warmup(HYDRO.STEPS_PER_HOUR * 30);
    this.world.captureBaselineWet();
    this.moisture.compute();
    this.moisture.apply(24);

    this.snapshot = this.refresh();
    this.damage.info('新しい流域に着任しました。まずは川沿いに取水施設と浄水場を。', 0, 6, 'good');
  }

  /** 起動時に水を落ち着かせる */
  private warmup(steps: number): void {
    for (let s = 0; s < steps; s++) {
      this.hydro.addSourceInflow(this.weather.inflow, HYDRO.DT);
      this.hydro.step();
    }
  }

  get speed(): number {
    return SPEEDS[this.speedIndex] ?? 1;
  }

  get paused(): boolean {
    return this.speed === 0;
  }

  setSpeed(index: number): void {
    this.speedIndex = clamp(index, 0, SPEEDS.length - 1) | 0;
  }

  /** 実時間 dt(秒) ぶん進める */
  advance(realDt: number): void {
    if (this.paused) return;
    const hours = Math.min(realDt, 0.25) * HOURS_PER_REAL_SEC * this.speed;
    this.hourAcc += hours;
    // 1フレームで処理する時間の上限 (処理落ち時に雪だるま式に増えないように)
    let budget = 6;
    while (this.hourAcc >= 1 && budget-- > 0) {
      this.hourAcc -= 1;
      this.stepHour();
    }
    if (budget <= 0) this.hourAcc = 0;
  }

  /**
   * 時間を進めずに集計だけ作り直す。
   * セーブデータを読み込んだ直後や起動時に、HUD へ正しい値を出すために使う。
   * (各サブシステムを極小の dt で呼ぶので、状態はほとんど変化しない)
   */
  refresh(): SimSnapshot {
    const dt = 1e-3;
    const w = this.weather;
    const net = this.network.update(dt, w.drought ? 0.55 : 1);
    const harvested = this.agriculture.update(dt, w.tempC);
    const damage = this.damage.update(dt, w.day, w.hour);
    const city = this.city.update(dt, net, harvested, damage.hydroRevenue);
    this.snapshot = {
      city,
      net,
      damage,
      inflow: w.inflow,
      outflow: this.outflowPerHour,
      moistureCells: this.moisture.irrigatedCells(),
      fields: this.agriculture.stats.fields,
      cropGrowth: this.agriculture.stats.avgGrowth,
    };
    return this.snapshot;
  }

  /** 1ゲーム時間ぶんのシミュレーション */
  stepHour(): void {
    const w = this.weather;
    w.advanceHour();

    // --- 降雨 (地表流出ぶん) ---
    // mm/h → m/h に直し、流出率と時間圧縮率をかけて「この1時間に地表へ乗る深さ」に
    const surfaceRain = (w.rainRate / 1000) * WEATHER.RUNOFF_RATIO * TIME_COMPRESSION;
    if (surfaceRain > 0) this.hydro.addRain(surfaceRain, w.day * 0.7 + w.hour * 0.13);

    // --- 上流からの流入 + 前ステップの基底流出 ---
    // pendingBaseflow は「1ゲーム時間あたりの m^3」なので、3600 で割って m^3/s にする
    const baseQ = this.pendingBaseflow / 3600;
    this.pendingBaseflow = 0;
    const inflowQ = w.inflow + baseQ;

    // --- 水理ステップ ---
    let outflow = 0;
    for (let s = 0; s < HYDRO.STEPS_PER_HOUR; s++) {
      this.hydro.addSourceInflow(inflowQ, HYDRO.DT);
      this.hydro.step();
      outflow += this.hydro.lastOutflow;
    }
    this.outflowPerHour = outflow;

    // --- 蒸発・浸透・地下水 ---
    this.pendingBaseflow = this.hydro.hourlyExchange(1, w.evapScale(), w.rainRate);

    // --- 灌漑 ---
    this.hoursSinceMoisture += 1;
    if (this.hoursSinceMoisture >= 2) {
      this.moisture.compute();
      this.hoursSinceMoisture = 0;
    }
    this.moisture.apply(1);

    // --- 社会システム ---
    const droughtFactor = w.drought ? 0.55 : 1;
    const net = this.network.update(1, droughtFactor);
    const harvested = this.agriculture.update(1, w.tempC);
    const damage = this.damage.update(1, w.day, w.hour);
    const city = this.city.update(1, net, harvested, damage.hydroRevenue);

    if (w.hour === 6) {
      this.damage.checkAlerts(w.day, w.hour, w.inflow, w.forecastPeakInflow(3), w.drought);
      if (harvested > 0) {
        // 収穫は毎時起きるので日次通知はしない
      }
    }
    if (city.money < 0 && w.hour === 0) {
      this.damage.info('財政が赤字です。維持費を見直してください。', w.day, w.hour, 'warn');
    }

    this.snapshot = {
      city,
      net,
      damage,
      inflow: inflowQ,
      outflow: this.outflowPerHour,
      moistureCells: this.moisture.irrigatedCells(),
      fields: this.agriculture.stats.fields,
      cropGrowth: this.agriculture.stats.avgGrowth,
    };
  }

  /* --------------------------------------------------------------- */
  /* プレイヤー操作                                                    */
  /* --------------------------------------------------------------- */

  build(kind: BuildingKind, x: number, y: number): ActionResult {
    const def = BUILDINGS[kind];
    const check = this.world.canPlace(kind, x, y);
    if (!check.ok) return { ok: false, message: check.reason ?? '建設できません' };
    if (!this.city.canAfford(def.cost)) return { ok: false, message: '資金が足りません' };
    this.city.spend(def.cost);
    this.world.addBuilding(kind, x, y, this.weather.day);
    if (def.network) this.network.markDirty();
    return { ok: true, message: `${def.name}を建設 (￥${def.cost})` };
  }

  bulldoze(x: number, y: number): ActionResult {
    const b = this.world.buildingAt(x, y);
    if (!b) return { ok: false, message: '撤去するものがありません' };
    const def = BUILDINGS[b.kind];
    const refund = Math.round(def.cost * 0.25 * b.hp);
    this.world.removeBuilding(x, y);
    this.city.money += refund;
    if (def.network) this.network.markDirty();
    return { ok: true, message: `${def.name}を撤去 (+￥${refund})` };
  }

  /** 掘削 (delta<0) / 盛土 (delta>0) */
  terraform(x: number, y: number, delta: number): ActionResult {
    const costPerM3 = delta < 0 ? 0.42 : 0.34;
    const volume = Math.abs(delta) * 144;
    const cost = Math.round(volume * costPerM3);
    if (!this.city.canAfford(cost)) return { ok: false, message: '資金が足りません' };
    const moved = this.world.modifyTerrain(x, y, delta);
    if (moved <= 0) return { ok: false, message: 'ここは改変できません' };
    this.city.money -= cost;
    return { ok: true, message: delta < 0 ? `掘削 (￥${cost})` : `盛土 (￥${cost})` };
  }

  setGate(b: Building, value: number): void {
    if (!BUILDINGS[b.kind].hasGate) return;
    b.gate = clamp(value, 0, 1);
    this.world.refreshSolid(this.world.idx(b.x, b.y));
  }

  /** すべてのダムのゲートを一括操作 (事前放流など) */
  setAllDamGates(value: number): number {
    let n = 0;
    for (const b of this.world.buildings.values()) {
      if (b.kind !== 'dam') continue;
      this.setGate(b, value);
      n++;
    }
    return n;
  }

  /** 現在の日時ラベル */
  get clock(): { date: string; time: string } {
    return { date: this.weather.dateLabel(), time: this.weather.timeLabel() };
  }

  /** 進捗率 (1年のうち) */
  get yearProgress(): number {
    return this.weather.dayOfYear / WEATHER.DAYS_PER_YEAR;
  }
}
