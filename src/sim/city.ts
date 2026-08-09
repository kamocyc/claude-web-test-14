import { CITY } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';
import { BUILDINGS } from './buildings';
import type { NetworkStats } from './network';

export interface CityStats {
  population: number;
  capacity: number;
  money: number;
  food: number;
  /** 満足度 0..1 */
  satisfaction: number;
  waterScore: number;
  foodScore: number;
  safetyScore: number;
  income: number;
  expense: number;
  homeless: number;
}

/** 都市の人口・経済。 */
export class City {
  money = CITY.START_MONEY;
  /**
   * 資金無制限モード。建設費・維持費で資金が減らず、いくらでも建てられる。
   * (地形や水の挙動は変えないので、治水そのものは通常どおり難しい)
   */
  unlimited = false;
  food = 260;
  population = 0;
  satisfaction = 1;
  income = 0;
  expense = 0;
  waterScore = 1;
  foodScore = 1;
  safetyScore = 1;

  constructor(private world: World) {}

  /** 施設の維持費合計 (￥/h) */
  upkeep(): number {
    let sum = 0;
    for (const b of this.world.buildings.values()) {
      if (b.hp <= 0.02) continue;
      sum += BUILDINGS[b.kind].upkeep;
    }
    return sum;
  }

  update(hours: number, net: NetworkStats, harvested: number, hydroRevenue: number): CityStats {
    const w = this.world;

    // --- 食料 ---
    this.food += harvested;
    const foodNeed = this.population * CITY.FOOD_PER_CAPITA * hours;
    const foodEaten = Math.min(this.food, foodNeed);
    this.food -= foodEaten;
    this.foodScore = foodNeed > 0 ? clamp(foodEaten / foodNeed, 0, 1) : 1;

    // --- 給水 ---
    const waterRatio = net.demand > 0 ? clamp(net.served / net.demand, 0, 1) : 1;
    // 未処理水は健康被害として満足度を下げる
    this.waterScore = waterRatio * (0.55 + 0.45 * net.quality);

    // --- 住宅ごとの入居率 ---
    let population = 0;
    let capacity = 0;
    let safetySum = 0;
    let houses = 0;
    let homeless = 0;

    for (const b of w.buildings.values()) {
      if (b.kind !== 'house') continue;
      houses++;
      capacity += CITY.HOUSE_CAPACITY;
      const i = w.idx(b.x, b.y);
      const depth = w.water[i];
      const safety = clamp(1 - depth / 0.6, 0, 1) * b.hp;
      safetySum += safety;

      const attract = Math.min(b.rate <= 0 ? 0.05 : b.rate, this.foodScore, safety) * (0.35 + 0.65 * b.hp);
      const target = clamp(attract, 0, 1);
      const rate = target > b.occupancy ? CITY.GROWTH_RATE : CITY.GROWTH_RATE * 2.2;
      b.occupancy += (target - b.occupancy) * clamp(rate * hours, 0, 1);
      b.occupancy = clamp(b.occupancy, 0, 1);
      population += b.occupancy * CITY.HOUSE_CAPACITY;
      if (b.rate < 0.15) homeless += b.occupancy * CITY.HOUSE_CAPACITY;
    }

    this.population = population;
    this.safetyScore = houses > 0 ? safetySum / houses : 1;
    this.satisfaction = clamp(
      this.waterScore * 0.4 + this.foodScore * 0.3 + this.safetyScore * 0.3,
      0,
      1,
    );

    // --- 収支 ---
    const tax = population * CITY.TAX_PER_CAPITA * this.satisfaction * hours;
    // 備蓄を超えた食料は出荷して現金にする (出荷能力には上限がある)
    const buffer = population * 3 + 80;
    const sold = Math.min(Math.max(0, this.food - buffer), CITY.FOOD_SHIP_RATE * hours);
    this.food -= sold;
    const income = tax + sold * CITY.FOOD_PRICE + hydroRevenue;
    const expense = this.upkeep() * hours;
    // 無制限モードでも収支の内訳は出す (残高だけ動かさない)
    if (!this.unlimited) this.money += income - expense;
    this.income = income / Math.max(hours, 1e-6);
    this.expense = expense / Math.max(hours, 1e-6);

    return {
      population,
      capacity,
      money: this.money,
      food: this.food,
      satisfaction: this.satisfaction,
      waterScore: this.waterScore,
      foodScore: this.foodScore,
      safetyScore: this.safetyScore,
      income: this.income,
      expense: this.expense,
      homeless,
    };
  }

  canAfford(cost: number): boolean {
    return this.unlimited || this.money >= cost;
  }

  spend(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    if (!this.unlimited) this.money -= cost;
    return true;
  }

  /** 撤去の返金など、臨時の収入 */
  earn(amount: number): void {
    if (!this.unlimited) this.money += amount;
  }
}
