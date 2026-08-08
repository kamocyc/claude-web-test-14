/**
 * ダムが本当に効いているのかを確かめる。
 *
 * 1. ダムが町の水系上流にあるか (流下経路をたどって確認)
 * 2. 同じ洪水を「ダムあり / ダムなし」で流し、下流のピーク水位・氾濫面積を比較
 *
 *   npm run dam-effect
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDINGS } from '../src/sim/buildings';
import { findDamSite, reservoirFootprint } from './autoplay';
import { applySave, type SaveData } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { dayWeather } from '../src/sim/weather';
import type { World } from '../src/world/world';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, `../public/saves/${process.env.SAVE ?? 'sample'}.json`);
const data = JSON.parse(readFileSync(SAMPLE, 'utf8')) as SaveData;

console.log(`サンプル: ${data.label}`);

/** 流域面積の大きい低い方へたどる (実際の河道に沿う) */
function traceChannel(w: World, sx: number, sy: number, steps: number): { x: number; y: number } {
  let x = sx;
  let y = sy;
  const seen = new Set<number>();
  for (let s = 0; s < steps; s++) {
    const i = w.idx(x, y);
    seen.add(i);
    let best = -1;
    let bestAcc = -1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!w.inBounds(nx, ny)) return { x, y };
        const j = w.idx(nx, ny);
        if (seen.has(j) || w.height[j] >= w.height[i]) continue;
        if (w.flowAcc[j] > bestAcc) {
          bestAcc = w.flowAcc[j];
          best = j;
        }
      }
    }
    if (best < 0) return { x, y };
    x = best % w.w;
    y = (best / w.w) | 0;
  }
  return { x, y };
}

/** 水面の低い方へたどって流下経路を得る */
function traceDownstream(w: World, sx: number, sy: number, maxSteps = 400): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  let x = sx;
  let y = sy;
  const seen = new Set<number>();
  for (let s = 0; s < maxSteps; s++) {
    path.push({ x, y });
    seen.add(y * w.w + x);
    let best = -1;
    let bestLevel = w.level(w.idx(x, y));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!w.inBounds(nx, ny)) return path;
        const j = w.idx(nx, ny);
        if (seen.has(j)) continue;
        const lvl = w.level(j);
        if (lvl < bestLevel) {
          bestLevel = lvl;
          best = j;
        }
      }
    }
    if (best < 0) return path;
    x = best % w.w;
    y = (best / w.w) | 0;
  }
  return path;
}

/* ------------------------------------------------------------------ */
/* 1. 位置関係の確認                                                    */
/* ------------------------------------------------------------------ */

const probe = new Simulation(data.seed);
applySave(probe, data);
const world = probe.world;

/** セーブにダムが無ければ、町の上流に架けてから比較する */
function ensureDam(sim: Simulation): { x: number; y: number }[] {
  const w = sim.world;
  const existing = [...w.buildings.values()].filter((b) => b.kind === 'dam');
  if (existing.length > 0) return existing.map((b) => ({ x: b.x, y: b.y }));

  const intake = [...w.buildings.values()].find((b) => b.kind === 'intake');
  if (!intake) return [];
  const spot = findDamSite(w, intake);
  if (!spot) {
    console.log('  ダムを架けられる地点が見つかりません');
    return [];
  }
  sim.city.money = 1e7;
  const riverLevel = w.height[w.idx(spot.x, spot.y)];
  const built: { x: number; y: number }[] = [];
  for (const dir of [-1, 1]) {
    for (let d = dir < 0 ? 0 : 1; d < 30; d++) {
      const x = spot.x + dir * d;
      if (!w.inBounds(x, spot.y)) break;
      if (w.height[w.idx(x, spot.y)] > riverLevel + spot.abutment) break;
      if (sim.build('dam', x, spot.y).ok) built.push({ x, y: spot.y });
    }
  }
  return built;
}

const damCells = ensureDam(probe);
/** 貯水池として意図的に水を溜める範囲 (氾濫面積から除く) */
let reservoirMask: Uint8Array | null = null;
const dams = [...world.buildings.values()].filter((b) => b.kind === 'dam');
{
  const intake0 = [...world.buildings.values()].find((b) => b.kind === 'intake');
  const spot = intake0 ? findDamSite(world, intake0) : null;
  if (spot) reservoirMask = reservoirFootprint(world, spot);
}

/** 河道の中心にあたるダム径間 (両翼は山腹なので流量を測っても意味がない) */
const damCenter =
  dams.length > 0
    ? dams.reduce((a, b) => (world.flowAcc[world.idx(b.x, b.y)] > world.flowAcc[world.idx(a.x, a.y)] ? b : a))
    : null;
void damCells;
const houses = [...world.buildings.values()].filter((b) => b.kind === 'house');
const intakes = [...world.buildings.values()].filter((b) => b.kind === 'intake');
const townX = houses.reduce((a, b) => a + b.x, 0) / houses.length;
const townY = houses.reduce((a, b) => a + b.y, 0) / houses.length;

console.log(`\nダム ${dams.length} 径間 @ (${damCenter?.x}, ${damCenter?.y})`);
console.log(
  `町の中心 (${townX.toFixed(0)}, ${townY.toFixed(0)}) / 取水施設 ${intakes.map((b) => `(${b.x},${b.y})`).join(' ')}`,
);

if (damCenter && intakes.length > 0) {
  const d = damCenter;
  // 取水点まわりの本流の流域面積と、ダム地点の流域面積を比べる
  let intakeAcc = 0;
  for (const j of world.cellsInRadius(intakes[0].x, intakes[0].y, 6)) {
    intakeAcc = Math.max(intakeAcc, world.flowAcc[j]);
  }
  const damAcc = world.flowAcc[world.idx(d.x, d.y)];
  const ratio = intakeAcc > 0 ? damAcc / intakeAcc : 0;
  const path = traceDownstream(world, d.x, d.y + 1);
  let minTown = Infinity;
  for (const p of path) minTown = Math.min(minTown, Math.hypot(p.x - townX, p.y - townY));

  console.log(`  ダム地点の流域面積   ${damAcc.toFixed(0)} セル`);
  console.log(`  取水点の流域面積     ${intakeAcc.toFixed(0)} セル`);
  console.log(`  ダムが支配する割合   ${(ratio * 100).toFixed(0)}%`);
  console.log(`  ダム上流の水深       ${world.water[world.idx(d.x, Math.max(0, d.y - 2))].toFixed(2)} m`);
  console.log(`  流下経路から町まで   ${minTown.toFixed(1)} セル`);
  console.log(
    ratio > 0.3
      ? '  → ダムは町の上流の本流にあり、洪水調節に効く位置'
      : '  → ⚠ ダムは支流の細い所にあり、調節できる水量が小さい',
  );
}

/* ------------------------------------------------------------------ */
/* 2. 次の大出水を探す                                                  */
/* ------------------------------------------------------------------ */

const startDay = data.weather.day;
// 今後1年で最も雨の多い日を「試験洪水」に使う
let floodDay = startDay + 3;
let maxRain = -1;
for (let d = startDay + 3; d < startDay + 96; d++) {
  const r = dayWeather(data.seed, d).rainMm;
  if (r > maxRain) {
    maxRain = r;
    floodDay = d;
  }
}
const dw = dayWeather(data.seed, floodDay);
console.log(
  `\n次の大出水: ${floodDay}日目 (${dw.season.name}${dw.typhoon ? '・台風' : ''}) 日雨量 ${dw.rainMm.toFixed(0)}mm`,
);

/* ------------------------------------------------------------------ */
/* 3. ダムあり / なし で同じ洪水を流す                                   */
/* ------------------------------------------------------------------ */

interface Trial {
  peakInflow: number;
  peakFloodedCells: number;
  peakDepthAtTown: number;
  peakLevelBelowDam: number;
  floodedBuildings: number;
  lost: number;
}

/** 予報を見た事前放流 + 満水時の全開 (autoplay と同じ考え方) */
function operateGatesForFlood(sim: Simulation): void {
  const w = sim.world;
  const peak = sim.weather.forecastPeakInflow(3);
  const now = sim.snapshot.inflow;
  for (const b of w.buildings.values()) {
    if (b.kind !== 'dam') continue;
    const i = w.idx(b.x, b.y);
    const crest = w.height[i] + BUILDINGS.dam.wallHeight * (0.35 + 0.65 * b.hp);
    let upstream = -Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = b.x + dx;
      const ny = b.y - 1;
      if (!w.inBounds(nx, ny)) continue;
      upstream = Math.max(upstream, w.level(w.idx(nx, ny)));
    }
    const freeboard = crest - upstream;
    // 来る前に空け、来たら閉める (autoplay と同じ操作規則)
    const target = freeboard < 2.5 ? 1 : now > 25 ? 0.06 : peak > 150 ? 1 : 0.35;
    sim.setGate(b, target);
  }
}

function run(withDam: boolean, gateOperation: boolean): Trial {
  const sim = new Simulation(data.seed);
  applySave(sim, data);
  const w = sim.world;

  if (withDam) ensureDam(sim);
  if (!withDam) {
    for (const b of [...w.buildings.values()]) {
      if (b.kind === 'dam') w.removeBuilding(b.x, b.y);
    }
  }

  // 観測点: ダムから河道を 15 セル下った地点 (ダム直下の本川)
  const dam = damCenter;
  const gauge = dam ? traceChannel(w, dam.x, dam.y, 15) : { x: townX | 0, y: townY | 0 };
  const gaugeX = gauge.x;
  const gaugeY = gauge.y;

  const t: Trial = {
    peakInflow: 0,
    peakFloodedCells: 0,
    peakDepthAtTown: 0,
    peakLevelBelowDam: 0,
    floodedBuildings: 0,
    lost: 0,
  };

  const days = floodDay - startDay + 6;
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      sim.stepHour();
      const s = sim.snapshot;
      t.peakInflow = Math.max(t.peakInflow, s.inflow);
      // 貯水池の湛水は「氾濫」ではないので除いて数える
      let flooded = 0;
      for (let i = 0; i < w.water.length; i++) {
        if (w.water[i] > 0.3 && w.baselineWet[i] === 0 && w.height[i] > 1 && !reservoirMask?.[i]) flooded++;
      }
      t.peakFloodedCells = Math.max(t.peakFloodedCells, flooded);
      t.floodedBuildings = Math.max(t.floodedBuildings, s.damage.flooded);
      t.lost += s.damage.destroyed;
      t.peakLevelBelowDam = Math.max(t.peakLevelBelowDam, w.level(w.idx(gaugeX, gaugeY)));
      let deepest = 0;
      for (const i of w.cellsInRadius(townX | 0, townY | 0, 12)) {
        if (w.water[i] > deepest) deepest = w.water[i];
      }
      t.peakDepthAtTown = Math.max(t.peakDepthAtTown, deepest);
    }
    if (withDam && gateOperation) operateGatesForFlood(sim);
  }
  return t;
}

console.log('\n同じ洪水を3通りで流します…');
const withDam = run(true, true);
console.log('  [1] ダムあり (事前放流あり) 完了');
const withDamNoOp = run(true, false);
console.log('  [2] ダムあり (ゲート操作なし) 完了');
const noDam = run(false, false);
console.log('  [3] ダムなし 完了');

const fmt = (t: Trial): string =>
  `${t.peakInflow.toFixed(0).padStart(6)} ${t.peakLevelBelowDam.toFixed(2).padStart(9)} ` +
  `${t.peakDepthAtTown.toFixed(2).padStart(9)} ${String(t.peakFloodedCells).padStart(8)} ` +
  `${String(t.floodedBuildings).padStart(8)} ${String(t.lost).padStart(5)}`;

console.log('\n── 比較 ──────────────────────────────────────────────');
console.log('                        流入   直下水位   町の水深   氾濫面積  浸水建物  損失');
console.log('  ダムあり(操作あり)  ' + fmt(withDam));
console.log('  ダムあり(操作なし)  ' + fmt(withDamNoOp));
console.log('  ダムなし            ' + fmt(noDam));

// ダムありの2通りのうち、下流のピークを最も下げられた方を「ダムの実力」とみなす
const best = withDam.peakLevelBelowDam <= withDamNoOp.peakLevelBelowDam ? withDam : withDamNoOp;
const cut = noDam.peakLevelBelowDam - best.peakLevelBelowDam;
const rate = noDam.peakLevelBelowDam > 0 ? (cut / noDam.peakLevelBelowDam) * 100 : 0;
const cells = noDam.peakFloodedCells - best.peakFloodedCells;
console.log('\n── ダムの効果 ────────────────────────────────────────');
console.log(`  ダム直下のピーク水位  ${noDam.peakLevelBelowDam.toFixed(2)}m → ${best.peakLevelBelowDam.toFixed(2)}m ` +
  `(${cut >= 0 ? '-' : '+'}${Math.abs(cut).toFixed(2)}m / ${rate.toFixed(0)}%)`);
console.log(`  氾濫面積 (貯水池を除く) ${noDam.peakFloodedCells} → ${best.peakFloodedCells} セル`);
console.log(
  `  判定: ${cut > 0.15 || cells > 10 ? '✔ ダムは下流のピークを下げている' : '有意な差が出ていない'}`,
);
