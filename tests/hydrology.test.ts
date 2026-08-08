import { describe, expect, it } from 'vitest';
import { CELL_AREA, HYDRO } from '../src/config';
import { Hydrology } from '../src/sim/hydrology';
import { Moisture } from '../src/sim/moisture';
import { generateTerrain, type TerrainData } from '../src/world/terrain';
import { World } from '../src/world/world';

/** テスト用の平坦な地形 */
function flatTerrain(w: number, h: number, fn: (x: number, y: number) => number): TerrainData {
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) height[y * w + x] = fn(x, y);
  return {
    height,
    flowAcc: new Float32Array(w * h).fill(1),
    riverMask: new Uint8Array(w * h),
    sources: [{ x: (w / 2) | 0, y: 1, weight: 1 }],
    maxHeight: 100,
    width: w,
    heightMap: h,
  };
}

describe('Hydrology', () => {
  it('水は必ず低い方へ動き、水位は平らに落ち着く', () => {
    const w = 24;
    // 周囲 40m の壁に囲まれた盆地 (境界からの排水を防ぐ)
    const world = new World(
      flatTerrain(w, w, (x, y) => (x < 3 || y < 3 || x > w - 4 || y > w - 4 ? 60 : 10)),
    );
    const hyd = new Hydrology(world);

    // 盆地の一角にだけ水を入れる
    world.water[6 * w + 6] = 8;
    const initial = world.totalWater();

    for (let i = 0; i < 400; i++) hyd.step();

    expect(hyd.sanityCheck()).toBe(true);
    // 質量保存 (蒸発なし、境界へも逃げない)
    expect(world.totalWater()).toBeCloseTo(initial, 1);

    // 水面が平らになっているか (濡れているセルの水位のばらつきが小さい)
    let min = Infinity;
    let max = -Infinity;
    for (let y = 4; y < w - 4; y++) {
      for (let x = 4; x < w - 4; x++) {
        const i = y * w + x;
        if (world.water[i] < 0.02) continue;
        const lv = world.level(i);
        min = Math.min(min, lv);
        max = Math.max(max, lv);
      }
    }
    expect(max - min).toBeLessThan(0.35);
  });

  it('水深が負や NaN にならない (急斜面でも安定)', () => {
    const w = 32;
    const world = new World(flatTerrain(w, w, (_x, y) => 80 - y * 2.4));
    const hyd = new Hydrology(world);
    for (let i = 0; i < 300; i++) {
      hyd.addSourceInflow(40, HYDRO.DT);
      hyd.step();
      if (i % 50 === 0) expect(hyd.sanityCheck()).toBe(true);
    }
    expect(hyd.sanityCheck()).toBe(true);
    for (let i = 0; i < world.water.length; i++) {
      expect(Number.isFinite(world.water[i])).toBe(true);
      expect(world.water[i]).toBeLessThan(1e4);
    }
  });

  it('堤防 (壁) は水を堰き止める', () => {
    const w = 20;
    const world = new World(flatTerrain(w, w, (x, y) => (y < 2 || y > w - 3 || x < 2 || x > w - 3 ? 60 : 10)));
    // 中央に壁を立てる
    for (let x = 2; x < w - 2; x++) {
      world.height[10 * w + x] = 14;
      world.refreshSolid(10 * w + x);
    }
    const hyd = new Hydrology(world);
    for (let x = 3; x < w - 3; x++) world.water[6 * w + x] = 2.0;

    for (let i = 0; i < 200; i++) hyd.step();

    let upstream = 0;
    let downstream = 0;
    for (let y = 2; y < 10; y++) for (let x = 2; x < w - 2; x++) upstream += world.water[y * w + x];
    for (let y = 11; y < w - 2; y++) for (let x = 2; x < w - 2; x++) downstream += world.water[y * w + x];
    expect(upstream).toBeGreaterThan(downstream * 5);
  });

  it('壁より高い水位になると越流する', () => {
    const w = 20;
    const world = new World(flatTerrain(w, w, (x, y) => (y < 2 || y > w - 3 || x < 2 || x > w - 3 ? 60 : 10)));
    for (let x = 2; x < w - 2; x++) {
      world.height[10 * w + x] = 12;
      world.refreshSolid(10 * w + x);
    }
    const hyd = new Hydrology(world);
    for (let y = 3; y < 10; y++) for (let x = 3; x < w - 3; x++) world.water[y * w + x] = 6;

    for (let i = 0; i < 400; i++) hyd.step();

    let downstream = 0;
    for (let y = 11; y < w - 2; y++) for (let x = 2; x < w - 2; x++) downstream += world.water[y * w + x];
    expect(downstream).toBeGreaterThan(1);
  });

  it('生成した流域では川が海まで抜け、水が溜まり続けない', () => {
    const terrain = generateTerrain(9182, 64, 64, 0.25);
    const world = new World(terrain);
    const hyd = new Hydrology(world);

    for (let i = 0; i < 200; i++) {
      hyd.addSourceInflow(12, HYDRO.DT);
      hyd.step();
    }
    const mid = world.totalWater();
    let outflow = 0;
    for (let i = 0; i < 400; i++) {
      hyd.addSourceInflow(12, HYDRO.DT);
      hyd.step();
      outflow += hyd.lastOutflow;
    }
    const end = world.totalWater();

    expect(outflow).toBeGreaterThan(0);
    // 流入と流出が釣り合い、総水量が発散しない
    expect(end).toBeLessThan(mid * 2.5 + 1000);
    expect(hyd.sanityCheck()).toBe(true);
  });

  it('蒸発と浸透で水が減り、土壌に貯まる', () => {
    const w = 16;
    const world = new World(flatTerrain(w, w, () => 20));
    const hyd = new Hydrology(world);
    for (let i = 0; i < world.water.length; i++) world.water[i] = 0.5;
    for (let i = 0; i < world.soil.length; i++) world.soil[i] = 0;
    const before = world.totalWater();
    const base = hyd.hourlyExchange(5, 1);
    expect(world.totalWater()).toBeLessThan(before);
    expect(world.soil[0]).toBeGreaterThan(0);
    expect(base).toBeGreaterThanOrEqual(0);
  });

  it('排水機場は半径内の水を汲み出す', () => {
    const w = 20;
    const world = new World(flatTerrain(w, w, () => 20));
    const hyd = new Hydrology(world);
    for (let i = 0; i < world.water.length; i++) world.water[i] = 0.4;
    const removed = hyd.drain(10, 10, 4, 0.2);
    expect(removed).toBeGreaterThan(0);
    expect(world.water[10 * w + 10]).toBeCloseTo(0.2, 5);
    expect(world.water[0]).toBeCloseTo(0.4, 5);
    // 半径4の円内 (中心含む) のセル数ぶんだけ 0.2m 汲み出されている
    let cells = 0;
    for (const _i of world.cellsInRadius(10, 10, 4)) cells++;
    expect(removed).toBeCloseTo(cells * 0.2 * CELL_AREA, 3);
  });
});

describe('Moisture (灌漑)', () => {
  it('水面から一定距離まで潤い、遠方は乾く', () => {
    const w = 40;
    const world = new World(flatTerrain(w, w, () => 5));
    for (let i = 0; i < world.soil.length; i++) world.soil[i] = 0;
    world.water[20 * w + 5] = 1.5;
    world.refreshAllSolid();

    const m = new Moisture(world);
    m.compute();

    expect(m.target[20 * w + 5]).toBeCloseTo(1, 2);
    expect(m.target[20 * w + 10]).toBeGreaterThan(0.2);
    // RANGE(11) より遠いセルは潤わない
    expect(m.target[20 * w + 25]).toBe(0);
  });

  it('水面より高い崖の上へは水が届かない', () => {
    const w = 30;
    const world = new World(
      flatTerrain(w, w, (x) => (x >= 15 ? 30 : 2)), // x=15 から先は高さ 30m の台地
    );
    for (let i = 0; i < world.soil.length; i++) world.soil[i] = 0;
    for (let y = 0; y < w; y++) world.water[y * w + 12] = 1;
    world.refreshAllSolid();

    const m = new Moisture(world);
    m.compute();

    expect(m.target[15 * w + 13]).toBeGreaterThan(0.5); // 低地側は潤う
    expect(m.target[15 * w + 16]).toBe(0); // 台地の上は届かない
  });

  it('湿潤度は時間をかけて目標値へ近づく', () => {
    const w = 12;
    const world = new World(flatTerrain(w, w, () => 5));
    for (let y = 0; y < w; y++) world.water[y * w + 5] = 1;
    world.refreshAllSolid();
    const m = new Moisture(world);
    m.compute();
    m.apply(1);
    const after1 = world.moisture[5 * w + 6];
    m.apply(20);
    const after20 = world.moisture[5 * w + 6];
    expect(after1).toBeGreaterThan(0);
    expect(after20).toBeGreaterThan(after1);
    expect(after20).toBeLessThanOrEqual(1.0001);
  });
});
