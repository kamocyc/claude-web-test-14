import { describe, expect, it } from 'vitest';
import { CITY } from '../src/config';
import { BUILDINGS, type Building } from '../src/sim/buildings';
import { DamageSystem } from '../src/sim/damage';
import { Hydrology } from '../src/sim/hydrology';
import { Moisture } from '../src/sim/moisture';
import { Simulation } from '../src/sim/simulation';
import type { TerrainData } from '../src/world/terrain';
import { World } from '../src/world/world';

function flatTerrain(w: number, h: number, fn: (x: number, y: number) => number): TerrainData {
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) height[y * w + x] = fn(x, y);
  return {
    height,
    flowAcc: new Float32Array(w * h).fill(1),
    riverMask: new Uint8Array(w * h),
    sources: [{ x: 1, y: 1, weight: 1 }],
    maxHeight: 100,
    width: w,
    heightMap: h,
  };
}

/**
 * 川の近くで、指定した施設を建てられるセルを探す。
 * `alsoFits` を渡すと「隣にその施設も建てられる」場所だけを返す。
 * (山あいの峡谷は取水はできても浄水場を置く平地がないので、上水道一式を
 *  組む試験では、まとめて置ける場所を選ぶ必要がある)
 */
function findSpot(
  sim: Simulation,
  kind: Parameters<Simulation['build']>[0],
  near?: { x: number; y: number; r: number },
  alsoFits?: Parameters<Simulation['build']>[0],
): { x: number; y: number } | null {
  const w = sim.world;
  const x0 = near ? Math.max(1, near.x - near.r) : 1;
  const x1 = near ? Math.min(w.w - 2, near.x + near.r) : w.w - 2;
  const y0 = near ? Math.max(1, near.y - near.r) : 1;
  const y1 = near ? Math.min(w.h - 2, near.y + near.r) : w.h - 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!w.canPlace(kind, x, y).ok) continue;
      if (alsoFits) {
        // まわりが開けている (4 近傍のうち 3 方向以上に置ける) 場所だけを選ぶ。
        // 峡谷の岸のように 1 方向しか空いていないと、この先の連鎖が続かない。
        const room = [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ].filter(([dx, dy]) => w.canPlace(alsoFits, x + dx, y + dy).ok).length;
        if (room < 3) continue;
      }
      return { x, y };
    }
  }
  return null;
}

describe('上水道のチェーン', () => {
  it('取水 → 浄水 → 配水池 → 水道管 → 住宅 がつながると給水され、人口が増える', () => {
    const sim = new Simulation(4242, 0.12);
    sim.city.money = 500000;

    // 川に隣接し、かつ隣に浄水場を置ける (急斜面でない) 取水地点を探す
    const intake = findSpot(sim, 'intake', undefined, 'treatment');
    expect(intake).not.toBeNull();
    if (!intake) return;
    expect(sim.build('intake', intake.x, intake.y).ok).toBe(true);

    // 取水施設の隣に浄水場・配水池・水道管・住宅を並べる
    const placed: { kind: Parameters<Simulation['build']>[0]; x: number; y: number }[] = [];
    let cursor = { x: intake.x, y: intake.y };
    const chain: Parameters<Simulation['build']>[0][] = [
      'treatment',
      'tower',
      'pipe',
      'house',
      'house',
      'house',
    ];
    for (const kind of chain) {
      let done = false;
      // 直前に置いたセルの隣接 4 方向に置く (水道網としてつながる)
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        const x = cursor.x + dx;
        const y = cursor.y + dy;
        if (sim.world.buildingAt(x, y)) continue;
        if (sim.build(kind, x, y).ok) {
          placed.push({ kind, x, y });
          cursor = { x, y };
          done = true;
          break;
        }
      }
      expect(done, `${kind} を配置できなかった`).toBe(true);
    }

    for (let i = 0; i < 240; i++) sim.stepHour();

    const stats = sim.snapshot;
    expect(stats.net.demand).toBeGreaterThan(0);
    expect(stats.net.served).toBeGreaterThan(0);
    expect(stats.net.served / stats.net.demand).toBeGreaterThan(0.8);
    expect(stats.city.population).toBeGreaterThan(3);

    // 取水施設を撤去すると、まず配水池の貯留を取り崩す
    const storedBefore = sim.snapshot.net.stored;
    expect(storedBefore).toBeGreaterThan(0);
    sim.bulldoze(intake.x, intake.y);
    for (let i = 0; i < 40; i++) sim.stepHour();
    expect(sim.snapshot.net.stored).toBeLessThan(storedBefore);

    // 配水池も失うと給水は止まり、人口が減る
    const tower = placed.find((p) => p.kind === 'tower');
    expect(tower).toBeDefined();
    if (tower) sim.bulldoze(tower.x, tower.y);
    for (let i = 0; i < 80; i++) sim.stepHour();
    expect(sim.snapshot.net.served / Math.max(sim.snapshot.net.demand, 1e-9)).toBeLessThan(0.5);
    expect(sim.snapshot.city.population).toBeLessThan(stats.city.population);
  }, 120000);

  it('水道網につながっていない住宅には給水されない', () => {
    const sim = new Simulation(24, 0.12);
    sim.city.money = 500000;
    const spot = findSpot(sim, 'house');
    expect(spot).not.toBeNull();
    if (!spot) return;
    sim.build('house', spot.x, spot.y);
    for (let i = 0; i < 60; i++) sim.stepHour();
    const house = sim.world.buildingAt(spot.x, spot.y);
    expect(house?.rate).toBe(0);
    expect((house?.occupancy ?? 1) * CITY.HOUSE_CAPACITY).toBeLessThan(1.5);
  }, 120000);
});

describe('灌漑と農業', () => {
  it('川沿いの水田は育ち、水から遠い畑は育たない', () => {
    const sim = new Simulation(8888, 0.12);
    sim.city.money = 500000;
    const w = sim.world;

    // 川の水位が落ち着いてから場所を選ぶ
    for (let i = 0; i < 48; i++) sim.stepHour();

    // 水際の水田と、水から遠い畑を探す
    let wet: { x: number; y: number } | null = null;
    let dry: { x: number; y: number } | null = null;
    sim.moisture.compute();
    for (let y = 2; y < w.h - 2 && (!wet || !dry); y++) {
      for (let x = 2; x < w.w - 2; x++) {
        const i = w.idx(x, y);
        if (!wet && sim.moisture.target[i] > 0.95 && w.canPlace('paddy', x, y).ok) wet = { x, y };
        // 川から離れたセル (土壌水分ぶんのわずかな湿りしかない)
        if (!dry && sim.moisture.target[i] < 0.25 && w.canPlace('farm', x, y).ok) dry = { x, y };
      }
    }
    expect(wet, '湿った場所が見つからない').not.toBeNull();
    expect(dry, '乾いた場所が見つからない').not.toBeNull();
    if (!wet || !dry) return;

    expect(sim.build('paddy', wet.x, wet.y).ok).toBe(true);
    expect(sim.build('farm', dry.x, dry.y).ok).toBe(true);

    const foodBefore = sim.city.food;
    for (let i = 0; i < 24 * 30; i++) sim.stepHour();

    const paddy = sim.world.buildingAt(wet.x, wet.y);
    const farm = sim.world.buildingAt(dry.x, dry.y);
    expect(w.moisture[w.idx(wet.x, wet.y)]).toBeGreaterThan(0.7);
    expect(w.moisture[w.idx(dry.x, dry.y)]).toBeLessThan(0.35);
    expect(farm?.growth ?? 1).toBeLessThan(0.15);
    // 水田は生育中か、すでに収穫されている
    expect((paddy?.growth ?? 0) > 0.1 || sim.city.food > foodBefore).toBe(true);
  }, 180000);

  it('掘削で水路を引くと、離れた土地まで潤う', () => {
    // 平坦な土地の左端に水を置き、右へ水路を掘る
    const W = 40;
    const world = new World(flatTerrain(W, W, () => 6));
    for (let i = 0; i < world.soil.length; i++) world.soil[i] = 0;
    const hyd = new Hydrology(world);

    const y = 20;
    const far = world.idx(30, y);
    // 水路なしでは届かない
    for (let yy = 0; yy < W; yy++) world.water[yy * W + 2] = 1.2;
    world.refreshAllSolid();
    const before = new Moisture(world);
    before.compute();
    expect(before.target[far]).toBe(0);

    // 水路 (深さ 3m) を掘って水を通す
    for (let x = 2; x <= 32; x++) {
      const i = world.idx(x, y);
      world.height[i] = 3;
      world.refreshSolid(i);
    }
    for (let s = 0; s < 200; s++) {
      hyd.addSourceInflow(0, 0);
      for (let yy = 0; yy < W; yy++) world.water[yy * W + 2] = 1.2;
      hyd.step();
    }
    const m2 = new Moisture(world);
    m2.compute();
    expect(world.water[world.idx(28, y)]).toBeGreaterThan(0.05);
    expect(m2.target[far]).toBeGreaterThan(0.5);
  });
});

describe('治水: 堤防とダム', () => {
  function leveeWorld(): { world: World; hyd: Hydrology; dmg: DamageSystem; levee: Building } {
    const W = 24;
    const world = new World(flatTerrain(W, W, (x, y) => (x < 2 || y < 2 || x > W - 3 || y > W - 3 ? 60 : 8)));
    const hyd = new Hydrology(world);
    const dmg = new DamageSystem(world, hyd);
    for (let x = 2; x < W - 2; x++) world.addBuilding('levee', x, 12, 0);
    const levee = world.buildingAt(12, 12);
    if (!levee) throw new Error('levee');
    return { world, hyd, dmg, levee };
  }

  it('越流していない堤防は損傷しない', () => {
    const { world, hyd, dmg, levee } = leveeWorld();
    const W = world.w;
    // 堤防 (高さ5m) の天端 13m に対し、水位 11m まで
    for (let y = 3; y < 12; y++) for (let x = 3; x < W - 3; x++) world.water[y * W + x] = 3;
    for (let i = 0; i < 100; i++) hyd.step();
    for (let i = 0; i < 24; i++) dmg.update(1, 0, i);
    expect(levee.hp).toBe(1);
    expect(world.water[world.idx(12, 12)]).toBeLessThan(0.08);
  });

  it('越流すると損傷し、やがて決壊して下流が浸水する', () => {
    const { world, hyd, dmg, levee } = leveeWorld();
    const W = world.w;
    const id = levee.id;
    for (let day = 0; day < 40 && world.buildings.has(id); day++) {
      // 上流側にどんどん水を足す (洪水)
      for (let y = 3; y < 12; y++) for (let x = 3; x < W - 3; x++) world.water[y * W + x] += 1.2;
      for (let i = 0; i < 40; i++) hyd.step();
      dmg.update(1, day, 12);
    }
    expect(world.buildings.has(id)).toBe(false);
    const breach = dmg.events.find((e) => e.text.includes('決壊'));
    expect(breach).toBeDefined();
    expect(breach?.level).toBe('danger');
  });

  it('ダムのゲートを閉じると上流に貯まり、開けると下流へ放流される', () => {
    const W = 24;
    // 左右は壁、上から下へ緩やかに下る谷。下端はマップ外 (海) へ抜ける
    const make = (gate: number): { stored: number; released: number } => {
      const world = new World(flatTerrain(W, W, (x, y) => (x < 2 || x > W - 3 ? 60 : 34 - y * 0.9)));
      const hyd = new Hydrology(world);
      for (let x = 2; x < W - 2; x++) {
        const b = world.addBuilding('dam', x, 12, 0);
        b.gate = gate;
        world.refreshSolid(world.idx(x, 12));
      }
      let released = 0;
      for (let s = 0; s < 500; s++) {
        // 上流端から一定の流量を与える
        for (let x = 3; x < W - 3; x++) world.water[2 * W + x] += 0.05;
        hyd.step();
        released += hyd.lastOutflow;
      }
      let stored = 0;
      for (let y = 2; y < 12; y++) for (let x = 2; x < W - 2; x++) stored += world.water[y * W + x];
      return { stored, released };
    };

    const closed = make(0);
    const open = make(1);

    // 閉じている方が上流に貯まり、開いている方が下流へ多く流れる
    expect(closed.stored).toBeGreaterThan(open.stored * 2);
    expect(open.released).toBeGreaterThan(closed.released * 1.5);
  });

  it('浸水した住宅は損傷し、やがて失われる', () => {
    const W = 16;
    const world = new World(flatTerrain(W, W, () => 20));
    const hyd = new Hydrology(world);
    const dmg = new DamageSystem(world, hyd);
    const house = world.addBuilding('house', 8, 8, 0);
    world.water[world.idx(8, 8)] = 1.5;
    for (let i = 0; i < 30 && world.buildings.has(house.id); i++) {
      world.water[world.idx(8, 8)] = 1.5;
      dmg.update(3, 0, i);
    }
    expect(world.buildings.has(house.id)).toBe(false);
    expect(dmg.events.some((e) => e.text.includes('浸水'))).toBe(true);
  });

  it('排水機場は堤防の内側の水を汲み出す', () => {
    const W = 20;
    const world = new World(flatTerrain(W, W, () => 10));
    const hyd = new Hydrology(world);
    const dmg = new DamageSystem(world, hyd);
    world.addBuilding('drainpump', 10, 10, 0);
    for (const i of world.cellsInRadius(10, 10, 5)) world.water[i] = 0.5;
    const before = world.totalWater();
    const rep = dmg.update(6, 0, 0);
    expect(rep.pumped).toBeGreaterThan(0);
    expect(world.totalWater()).toBeLessThan(before);
  });

  it('建造物の定義がすべて妥当な値を持つ', () => {
    for (const def of Object.values(BUILDINGS)) {
      expect(def.cost).toBeGreaterThan(0);
      expect(def.upkeep).toBeGreaterThanOrEqual(0);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
      if (def.hasGate) expect(def.wallHeight).toBeGreaterThan(0);
    }
  });
});
