import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, SaveError, applySave, serialize, validate, type SaveData } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';

/** テストを速くするため、地形の品質を落として同じシードで作る */
function makeSim(seed = 9090): Simulation {
  return new Simulation(seed, 0.12);
}

describe('セーブ / ロード', () => {
  it('保存して読み込むと、施設・地形改変・資金・日時が復元される', () => {
    const sim = makeSim();
    sim.city.money = 100000;

    // 何か建てて、地形もいじって、時間も進めておく
    const built: { kind: 'house' | 'paddy' | 'levee'; x: number; y: number }[] = [];
    for (let y = 4; y < sim.world.h - 4 && built.length < 12; y += 5) {
      for (let x = 4; x < sim.world.w - 4 && built.length < 12; x += 5) {
        const kind = built.length % 3 === 0 ? 'levee' : built.length % 3 === 1 ? 'house' : 'paddy';
        if (sim.build(kind, x, y).ok) built.push({ kind, x, y });
      }
    }
    expect(built.length).toBeGreaterThan(5);
    sim.terraform(20, 20, -1);
    sim.terraform(21, 20, 2);
    for (let i = 0; i < 30; i++) sim.stepHour();

    const data = serialize(sim, 'テスト');
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.terrainEdits.length).toBe(4); // 2セル × [index, height]

    // まっさらな同じ流域へ読み込む
    const sim2 = makeSim();
    applySave(sim2, data);

    expect(sim2.world.buildings.size).toBe(sim.world.buildings.size);
    for (const b of built) {
      const restored = sim2.world.buildingAt(b.x, b.y);
      expect(restored, `(${b.x},${b.y}) の ${b.kind}`).toBeDefined();
      expect(restored?.kind).toBe(b.kind);
    }
    expect(sim2.city.money).toBeCloseTo(sim.city.money, 0);
    expect(sim2.city.food).toBeCloseTo(sim.city.food, 0);
    expect(sim2.weather.day).toBe(sim.weather.day);
    expect(sim2.weather.hour).toBe(sim.weather.hour);
    expect(sim2.weather.inflow).toBeCloseTo(sim.weather.inflow, 3);
    expect(sim2.world.height[sim2.world.idx(20, 20)]).toBeCloseTo(
      sim.world.height[sim.world.idx(20, 20)],
      3,
    );
    expect(sim2.world.height[sim2.world.idx(21, 20)]).toBeCloseTo(
      sim.world.height[sim.world.idx(21, 20)],
      3,
    );
  }, 120000);

  it('水の分布が誤差 1mm 以内で復元される', () => {
    const sim = makeSim(4321);
    for (let i = 0; i < 20; i++) sim.stepHour();
    const data = serialize(sim);

    const sim2 = makeSim(4321);
    applySave(sim2, data);

    let maxDiff = 0;
    let wet = 0;
    for (let i = 0; i < sim.world.water.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(sim.world.water[i] - sim2.world.water[i]));
      if (sim.world.water[i] > 0.05) wet++;
    }
    expect(wet).toBeGreaterThan(100);
    expect(maxDiff).toBeLessThan(0.001);
  }, 120000);

  it('読み込んだ直後から続きをシミュレートできる', () => {
    const sim = makeSim(555);
    sim.city.money = 50000;
    for (let i = 0; i < 10; i++) sim.stepHour();
    const data = serialize(sim);

    const sim2 = makeSim(555);
    applySave(sim2, data);
    // 読み込み直後は時間が進んでいない
    expect(sim2.weather.day * 24 + sim2.weather.hour).toBe(sim.weather.day * 24 + sim.weather.hour);

    for (let i = 0; i < 24; i++) {
      sim.stepHour();
      sim2.stepHour();
    }
    // 同じ地形・同じ気象なので、その後の展開もほぼ一致する
    expect(sim2.snapshot.inflow).toBeCloseTo(sim.snapshot.inflow, 2);
    expect(sim2.world.totalWater()).toBeCloseTo(sim.world.totalWater(), -2);
    expect(sim2.hydro.sanityCheck()).toBe(true);
  }, 120000);

  it('壊れたデータや形式違いは拒否する', () => {
    expect(() => validate(null)).toThrow(SaveError);
    expect(() => validate({ version: 999, seed: 1, buildings: [], mapSize: 192 })).toThrow(SaveError);
    expect(() => validate({ version: SAVE_VERSION, buildings: [], mapSize: 192 })).toThrow(SaveError);
    expect(() => validate({ version: SAVE_VERSION, seed: 1, buildings: [], mapSize: 64 })).toThrow(
      /マップサイズ/,
    );
  });

  it('別のシードのセーブデータは applySave では受け付けない', () => {
    const sim = makeSim(111);
    const data = serialize(sim);
    const other = makeSim(222);
    expect(() => applySave(other, data)).toThrow(/シード/);
  }, 120000);
});

describe('同梱のサンプルセーブ', () => {
  const raw = readFileSync(new URL('../public/saves/sample.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw) as SaveData;

  it('形式が正しく、育った町が入っている', () => {
    expect(() => validate(data)).not.toThrow();
    const kinds = new Set(data.buildings.map((b) => b.k));
    expect(data.buildings.length).toBeGreaterThan(80);
    // 上水道・農業・治水がひと通り揃っていること
    for (const k of ['intake', 'treatment', 'tower', 'pipe', 'house', 'paddy', 'levee'] as const) {
      expect(kinds.has(k), `${k} が含まれていない`).toBe(true);
    }
    expect(data.city.money).toBeGreaterThan(0);
    expect(data.weather.day).toBeGreaterThan(90);
  });

  it('実際に読み込めて、人口と給水が生きている', () => {
    // サンプルは製品品質の地形で作られているので、同じ条件で読み込む
    const sim = new Simulation(data.seed);
    applySave(sim, data);

    expect(sim.world.buildings.size).toBe(data.buildings.length);
    expect(sim.snapshot.city.population).toBeGreaterThan(300);
    expect(sim.snapshot.net.served / sim.snapshot.net.demand).toBeGreaterThan(0.85);
    expect(sim.city.money).toBeGreaterThan(0);

    // 続きを1日進めても破綻しない
    for (let i = 0; i < 24; i++) sim.stepHour();
    expect(sim.hydro.sanityCheck()).toBe(true);
    expect(sim.snapshot.city.population).toBeGreaterThan(300);
  }, 180000);
});
