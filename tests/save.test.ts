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
    // 同じ地形・同じ気象なので、その後の展開もほぼ一致する。
    // 流入量には土壌water由来の基底流出が乗り、土壌もセーブ時に量子化されるので、
    // 絶対値ではなく相対で見る (絶対 0.005 だと流入が大きい流域で落ちる)。
    const inflow = sim.snapshot.inflow;
    expect(Math.abs(sim2.snapshot.inflow - inflow) / inflow).toBeLessThan(2e-3);
    // 水深はセーブ時に Uint16 (m×3000) へ量子化されるので、総量はぴったりには戻らない。
    // 誤差は「量子化幅 × セル数」で決まるため、絶対値ではなく相対で見る。
    const water = sim.world.totalWater();
    expect(Math.abs(sim2.world.totalWater() - water) / water).toBeLessThan(1e-4);
    expect(sim2.hydro.sanityCheck()).toBe(true);
  }, 120000);

  it('資金無制限モードの設定も保存・復元される', () => {
    const sim = makeSim(7777);
    sim.city.unlimited = true;
    const data = serialize(sim);
    expect(data.city.unlimited).toBe(true);

    const sim2 = makeSim(7777);
    applySave(sim2, data);
    expect(sim2.city.unlimited).toBe(true);

    // 設定のないデータ (旧セーブ) を読んだら通常モードに戻す
    const legacy: SaveData = { ...data, city: { money: data.city.money, food: data.city.food } };
    applySave(sim2, legacy);
    expect(sim2.city.unlimited).toBe(false);
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

  it('ダムが町の上流の本流に、隙間なく架かっている', () => {
    const sim = new Simulation(data.seed);
    applySave(sim, data);
    const w = sim.world;
    const dams = [...w.buildings.values()].filter((b) => b.kind === 'dam');
    const intake = [...w.buildings.values()].find((b) => b.kind === 'intake');
    // 径間数は地形しだい (狭窄部なら 1 セルで谷が閉じる) なので、数では判定しない
    expect(dams.length).toBeGreaterThan(0);
    expect(intake).toBeDefined();
    if (!intake) return;

    // (1) 堤体が一列に、隙間なく並んでいること。
    //     途中で資金が尽きて径間が欠けると、そこから水が抜けて堰にならない。
    const row = dams[0].y;
    expect(dams.every((d) => d.y === row)).toBe(true);
    const xs = dams.map((d) => d.x).sort((a, b) => a - b);
    expect(xs[xs.length - 1] - xs[0] + 1).toBe(dams.length);

    // (2) 町が取水している本流の上流にあること。
    //     別水系に架けると洪水調節にまったく効かない。
    //
    //     閾値が 0.25 なのは、ダムを山地の出口 (マップの北 1/3 の境) に置くように
    //     地形を変えたため。町のすぐ隣に架ければ支配率は 50% を超えるが、それでは
    //     上流域と下流域を分ける設計にならない。実測では 31% で、これは支流が
    //     合わさる前の本流を押さえている状態にあたる。
    let intakeAcc = 0;
    for (const j of w.cellsInRadius(intake.x, intake.y, 6)) {
      intakeAcc = Math.max(intakeAcc, w.flowAcc[j]);
    }
    const damAcc = Math.max(...dams.map((d) => w.flowAcc[w.idx(d.x, d.y)]));
    expect(damAcc / intakeAcc).toBeGreaterThan(0.25);
    //     ダムが町より上流にあること。方角では判定しない (川は北へも東西へも流れる)。
    //     水は低い方へ流れるので、「ダムの河床の方が町より高い」ことで見る。
    const houses = [...w.buildings.values()].filter((b) => b.kind === 'house');
    const townH = houses.reduce((s, b) => s + w.height[w.idx(b.x, b.y)], 0) / houses.length;
    const damH = Math.min(...dams.map((d) => w.height[w.idx(d.x, d.y)]));
    expect(damH).toBeGreaterThan(townH);

    // (3) 実際に水を貯めていること。
    //     上流が北とは限らない (川は東西にも北へも流れる) ので、
    //     堰のまわりを見て湛水しているかで判定する。
    const center = dams.reduce((a, b) =>
      w.flowAcc[w.idx(b.x, b.y)] > w.flowAcc[w.idx(a.x, a.y)] ? b : a,
    );
    let pool = 0;
    for (const j of w.cellsInRadius(center.x, center.y, 4)) pool = Math.max(pool, w.water[j]);
    expect(pool).toBeGreaterThan(1.5);
  }, 180000);

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
