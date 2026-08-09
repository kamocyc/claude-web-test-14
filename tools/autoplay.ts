/**
 * 自動プレイヤー。
 *
 * 何もない流域に着任し、上水道を引き、田畑を拓き、堤防とダムで町を守りながら
 * 財政を黒字に保って人口を伸ばす — というプレイを機械的に行う。
 *
 * ゲームのバランスが「実際に達成可能か」を検証するために使い、
 * その結果をサンプルセーブデータとして書き出す。
 */

import { CITY } from '../src/config';
import { CROPS } from '../src/sim/agriculture';
import {
  BUILDINGS,
  INTAKE_CAPACITY,
  TREATMENT_CAPACITY,
  type BuildingKind,
} from '../src/sim/buildings';
import type { Simulation } from '../src/sim/simulation';
import type { World } from '../src/world/world';

export interface AutoplayOptions {
  /** プレイする日数 */
  days: number;
  /** これを下回る建設はしない (運転資金) */
  reserve?: number;
  /** 住宅数の上限 (無限に増やさないための安全弁) */
  maxHouses?: number;
  log?: (line: string) => void;
}

export interface DayRecord {
  day: number;
  season: string;
  population: number;
  money: number;
  waterRatio: number;
  food: number;
  inflow: number;
  floodedCells: number;
  floodedBuildings: number;
  buildings: number;
  /** 収入・支出 (￥/h) */
  income: number;
  expense: number;
}

export interface CampaignReport {
  days: number;
  history: DayRecord[];
  population: number;
  money: number;
  minMoney: number;
  /** 破産せず、かつ最終的に収入が支出を上回っているか */
  financiallyStable: boolean;
  /** 直近30日の平均収支 (￥/h) */
  operatingBalance: number;
  /** 氾濫した最大面積 (セル) */
  peakFloodedCells: number;
  /** 失った建物の内訳 */
  lostByKind: Record<string, number>;
  /** 住宅・上水道など、守るべき施設を失った数 */
  criticalLost: number;
  maxFloodedBuildings: number;
  buildingsLost: number;
  leveeBreaches: number;
  minWaterRatio: number;
  minFood: number;
  peakInflow: number;
  counts: Record<string, number>;
}

interface Site {
  x: number;
  y: number;
  /** 川から離れる方向 (町を広げる向き) */
  dx: number;
  dy: number;
}

/* ------------------------------------------------------------------ */
/* 立地の選定                                                          */
/* ------------------------------------------------------------------ */

/** 町を構える川に求める最低流域面積 (セル) */
const MIN_RIVER_ACC = 1500;

/** 取水でき、周りに平地が広がっていて、浸水しにくい町の起点を探す */
function pickTownSite(sim: Simulation): Site | null {
  const w = sim.world;
  let best: Site | null = null;
  let bestScore = -Infinity;

  for (let y = Math.floor(w.h * 0.4); y < w.h - 16; y += 2) {
    for (let x = 8; x < w.w - 8; x += 2) {
      if (!w.canPlace('intake', x, y).ok) continue;
      const i = w.idx(x, y);
      if (w.height[i] < 2) continue; // 河口の低湿地は避ける

      // 近くを流れているのが本流かどうか (流域面積で見る)。
      // ここを見ないと、水はあるが集水域のない小さな枝沢に町を作ってしまい、
      // 上流にダムを架けても貯める水が無い、ということが起きる。
      let acc = 0;
      for (const j of w.cellsInRadius(x, y, 3)) acc = Math.max(acc, w.flowAcc[j]);
      if (acc < MIN_RIVER_ACC) continue;

      // 周囲に住宅を建てられる平地がどれだけあるか
      let flat = 0;
      for (const j of w.cellsInRadius(x, y, 7)) {
        const cx = j % w.w;
        const cy = (j / w.w) | 0;
        if (w.canPlace('house', cx, cy).ok) flat++;
      }
      if (flat < 40) continue;

      const depth = w.maxWaterNear(x, y, 3);
      const score = flat + depth * 25 + w.height[i] * 0.5 + Math.log(acc) * 22;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y, dx: 0, dy: 0 };
      }
    }
  }
  if (!best) return null;

  // 川から離れる方向 = 住宅が建てられるセルが最も続く向き
  let bestDir = { dx: 1, dy: 0 };
  let bestRun = -1;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    let run = 0;
    for (let k = 1; k <= 14; k++) {
      const nx = best.x + dx * k;
      const ny = best.y + dy * k;
      if (!w.inBounds(nx, ny)) break;
      if (w.canPlace('house', nx, ny).ok || w.canPlace('pipe', nx, ny).ok) run++;
    }
    if (run > bestRun) {
      bestRun = run;
      bestDir = { dx, dy };
    }
  }
  best.dx = bestDir.dx;
  best.dy = bestDir.dy;
  return best;
}

/* ------------------------------------------------------------------ */
/* 判断のための小道具                                                   */
/* ------------------------------------------------------------------ */

function afford(sim: Simulation, kind: BuildingKind, reserve: number): boolean {
  return sim.city.money - BUILDINGS[kind].cost >= reserve;
}

/**
 * 浸水しにくい宅地か。
 * 「そのセルが浸かったことがない」だけでは足りない。近所が浸かった記録があるなら、
 * そのときの水面より余裕を持って高い土地でなければ、次の出水で沈む。
 */
function isSafeGround(w: World, x: number, y: number, baseHeight: number): boolean {
  const i = w.idx(x, y);
  if (w.water[i] > 0.02) return false;
  if (w.floodMax[i] > 0.1) return false;
  if (w.height[i] < baseHeight - 0.5) return false;

  // 近隣の浸水履歴の水面 + 0.8m より高いこと (既往最高水位からの余裕高)
  for (const j of w.cellsInRadius(x, y, 3)) {
    const flood = w.floodMax[j];
    if (flood <= 0.1) continue;
    if (w.height[i] < w.height[j] + flood + 0.8) return false;
  }
  return true;
}

/** 水道網につながっているセルの隣で、条件を満たす空きセルを集める */
function networkFrontier(
  w: World,
  kind: BuildingKind,
  accept: (x: number, y: number) => boolean,
): { x: number; y: number }[] {
  const seen = new Set<number>();
  const out: { x: number; y: number }[] = [];
  for (const b of w.buildings.values()) {
    if (!BUILDINGS[b.kind].network) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = b.x + dx;
      const y = b.y + dy;
      if (!w.inBounds(x, y)) continue;
      const i = w.idx(x, y);
      if (seen.has(i)) continue;
      seen.add(i);
      if (!w.canPlace(kind, x, y).ok) continue;
      if (!accept(x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/**
 * 農地が生み出せる食料 (units/h) の見積もり。
 * 冬は生育が止まるので、年間平均で効率 0.6 くらいとみなす。
 */
function foodProduction(w: World): number {
  let rate = 0;
  for (const b of w.buildings.values()) {
    const spec = CROPS[b.kind];
    if (!spec) continue;
    rate += (spec.yieldAmount / (spec.growDays * 24)) * 0.6;
  }
  return rate;
}

/** 現在の原水取水能力 (m^3/h) */
function rawCapacity(w: World): number {
  let raw = 0;
  for (const b of w.buildings.values()) {
    if (b.kind === 'intake') raw += INTAKE_CAPACITY * Math.min(1, w.maxWaterNear(b.x, b.y, 3) / 0.85);
  }
  return raw;
}

function countKind(w: World, kind: BuildingKind): number {
  let n = 0;
  for (const b of w.buildings.values()) if (b.kind === kind) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* 各フェーズの建設                                                     */
/* ------------------------------------------------------------------ */

/** 上水道の骨格: 取水 → 浄水 → 配水池 → 水道管の背骨 */
function buildWaterworks(sim: Simulation, site: Site, reserve: number): boolean {
  if (!sim.build('intake', site.x, site.y).ok) return false;

  const step = (k: number): { x: number; y: number } => ({
    x: site.x + site.dx * k,
    y: site.y + site.dy * k,
  });

  // 取水施設のすぐ隣に浄水場と配水池
  let placed = 0;
  for (let k = 1; k <= 6 && placed < 2; k++) {
    const p = step(k);
    const kind: BuildingKind = placed === 0 ? 'treatment' : 'tower';
    if (afford(sim, kind, reserve) && sim.build(kind, p.x, p.y).ok) placed++;
  }
  if (placed < 2) return false;

  // 内陸へ水道管を伸ばす
  for (let k = 3; k <= 13; k++) {
    const p = step(k);
    if (!afford(sim, 'pipe', reserve)) break;
    sim.build('pipe', p.x, p.y);
  }
  return true;
}

/** 水道網の縁に住宅を足す */
function addHouses(
  sim: Simulation,
  count: number,
  baseHeight: number,
  reserve: number,
  reserved: Uint8Array | null,
): number {
  const w = sim.world;
  const cand = networkFrontier(
    w,
    'house',
    (x, y) => isSafeGround(w, x, y, baseHeight) && !reserved?.[w.idx(x, y)],
  );
  // 高い (＝安全な) 土地から埋めていく
  cand.sort((a, b) => w.height[w.idx(b.x, b.y)] - w.height[w.idx(a.x, a.y)]);
  let built = 0;
  for (const c of cand) {
    if (built >= count) break;
    if (!afford(sim, 'house', reserve)) break;
    if (sim.build('house', c.x, c.y).ok) built++;
  }
  return built;
}

/** 水道網を延ばす (住宅を建てる余地を増やす) */
function extendPipes(
  sim: Simulation,
  count: number,
  baseHeight: number,
  reserve: number,
  reserved: Uint8Array | null,
): number {
  const w = sim.world;
  const cand = networkFrontier(
    w,
    'pipe',
    (x, y) => isSafeGround(w, x, y, baseHeight) && !reserved?.[w.idx(x, y)],
  );
  cand.sort((a, b) => w.height[w.idx(b.x, b.y)] - w.height[w.idx(a.x, a.y)]);
  let built = 0;
  for (const c of cand) {
    if (built >= count) break;
    if (!afford(sim, 'pipe', reserve)) break;
    if (sim.build('pipe', c.x, c.y).ok) built++;
  }
  return built;
}

/** 給水能力が足りなければ取水・浄水・配水池を増設する */
function expandWaterSupply(sim: Simulation, site: Site, reserve: number): void {
  const w: World = sim.world;
  const demand = sim.snapshot.net.demand;
  const raw = rawCapacity(w);
  const treat = countKind(w, 'treatment') * TREATMENT_CAPACITY;

  // 需要の 1.8 倍の余裕を持たせる (渇水で取水量が落ちるため)
  if (raw < demand * 1.8 && afford(sim, 'intake', reserve)) {
    // 既存の水道網の近くで、川沿いの取水地点を探す
    const spots: { x: number; y: number; d: number }[] = [];
    for (const b of w.buildings.values()) {
      if (!BUILDINGS[b.kind].network) continue;
      for (const j of w.cellsInRadius(b.x, b.y, 3)) {
        const x = j % w.w;
        const y = (j / w.w) | 0;
        if (!w.canPlace('intake', x, y).ok) continue;
        if (w.maxWaterNear(x, y, 3) < 0.6) continue; // 細い流れは避ける
        spots.push({ x, y, d: Math.hypot(x - site.x, y - site.y) });
      }
    }
    spots.sort((a, b) => a.d - b.d);
    if (spots[0]) sim.build('intake', spots[0].x, spots[0].y);
  }

  if (treat < Math.min(raw, demand * 1.4) && afford(sim, 'treatment', reserve)) {
    const cand = networkFrontier(w, 'treatment', () => true);
    if (cand[0]) sim.build('treatment', cand[0].x, cand[0].y);
  }

  // 配水池は取水施設 2 基につき 1 つ (渇水と夜間需要のバッファ)
  if (countKind(w, 'tower') * 2 < countKind(w, 'intake') && afford(sim, 'tower', reserve)) {
    const cand = networkFrontier(w, 'tower', () => true);
    if (cand[0]) sim.build('tower', cand[0].x, cand[0].y);
  }
}

/** 灌漑されている土地に田畑を拓く */
function addFarms(
  sim: Simulation,
  site: Site,
  count: number,
  reserve: number,
  reserved: Uint8Array | null,
): number {
  const w = sim.world;
  const paddies: { x: number; y: number; m: number }[] = [];
  const fields: { x: number; y: number; m: number }[] = [];

  for (const i of w.cellsInRadius(site.x, site.y, 26)) {
    const x = i % w.w;
    const y = (i / w.w) | 0;
    if (reserved?.[i]) continue; // ダム水没予定地には作らない
    const m = w.moisture[i];
    if (m >= 0.82 && w.canPlace('paddy', x, y).ok) paddies.push({ x, y, m });
    else if (m >= 0.45 && w.canPlace('farm', x, y).ok) fields.push({ x, y, m });
  }
  // 湿っている順 (＝安定して収穫できる順)
  paddies.sort((a, b) => b.m - a.m);
  fields.sort((a, b) => b.m - a.m);

  let built = 0;
  for (const p of paddies) {
    if (built >= count) break;
    if (!afford(sim, 'paddy', reserve)) break;
    if (sim.build('paddy', p.x, p.y).ok) built++;
  }
  for (const f of fields) {
    if (built >= count) break;
    if (!afford(sim, 'farm', reserve)) break;
    if (sim.build('farm', f.x, f.y).ok) built++;
  }
  return built;
}

/**
 * 町と川の間に堤防を築く。
 * 平常時の水域に接した陸地セルを、町の周囲だけ一列に固める。
 */
function buildLevees(
  sim: Simulation,
  site: Site,
  radius: number,
  reserve: number,
  reserved: Uint8Array | null,
): number {
  const w = sim.world;
  const cand: { x: number; y: number; d: number }[] = [];

  for (const i of w.cellsInRadius(site.x, site.y, radius)) {
    if (w.baselineWet[i]) continue;
    if (w.structure[i] >= 0) continue;
    if (reserved?.[i]) continue; // ダムの堤体位置・水没予定地は空けておく
    const x = i % w.w;
    const y = (i / w.w) | 0;
    // 平常時の水域に接している = 岸
    let bank = false;
    for (let dy = -1; dy <= 1 && !bank; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!w.inBounds(nx, ny)) continue;
        if (w.baselineWet[w.idx(nx, ny)]) {
          bank = true;
          break;
        }
      }
    }
    if (!bank) continue;
    if (!w.canPlace('levee', x, y).ok) continue;
    cand.push({ x, y, d: Math.hypot(x - site.x, y - site.y) });
  }

  cand.sort((a, b) => a.d - b.d);
  let built = 0;
  for (const c of cand) {
    if (!afford(sim, 'levee', reserve)) break;
    if (sim.build('levee', c.x, c.y).ok) built++;
  }
  return built;
}

/** ダムを架け切るのに必要な総工費 */
export function damCost(spot: DamSite): number {
  return spot.span * BUILDINGS.dam.cost;
}

/** ダム地点の評価結果 */
export interface DamSite {
  x: number;
  y: number;
  /** 必要な径間数 */
  span: number;
  /** 両岸が立ち上がる高さ = 貯められる水深の目安 (m) */
  abutment: number;
  /** 支配流域面積 (セル) */
  acc: number;
}

/** 1基のダムに許す最大径間数 */
export const DAM_MAX_SPAN = 24;

/**
 * その地点に、指定した取り付け高さで堰を架けるのに必要な径間数。
 * 谷が広すぎて端部が見つからなければ -1。
 */
function damSpanLength(w: World, x: number, y: number, abutment: number, limit = 60): number {
  const riverLevel = w.height[w.idx(x, y)];
  const top = riverLevel + abutment;
  let span = 1;
  for (const dir of [-1, 1]) {
    let d = 1;
    for (; d < limit; d++) {
      const nx = x + dir * d;
      if (!w.inBounds(nx, y)) return -1;
      if (w.height[w.idx(nx, y)] > top) break;
      span++;
    }
    if (d >= limit) return -1;
  }
  return span;
}

/**
 * 町の取水口から本流を遡り、堰を架けるのに適した狭窄部を探す。
 *
 * 「上流で流量が大きいところ」を探すだけでは、町とは別の水系にダムを架けて
 * しまい、洪水調節にまったく効かない。必ず自分の川を遡って選ぶ。
 *
 * 取り付け高さは固定せず、深く貯められること・堰が短いこと・支配流域が
 * 広いことのバランス (acc × 取り付け高さ ÷ 径間数) で評価する。
 * この流域は峡谷ではなく開けた谷なので、高い取り付け部を要求すると
 * どこにも架けられなくなる。
 */
export function findDamSite(w: World, from: { x: number; y: number }): DamSite | null {
  // --- 1. 取水口の近くで本流 (flowAcc 最大) のセルに乗る ---
  let cx = from.x;
  let cy = from.y;
  let seedAcc = -1;
  for (const i of w.cellsInRadius(from.x, from.y, 6)) {
    if (w.flowAcc[i] > seedAcc) {
      seedAcc = w.flowAcc[i];
      cx = i % w.w;
      cy = (i / w.w) | 0;
    }
  }
  // 本流の 1/5 未満まで細った地点には架けない (調節できる水量が小さい)
  const minAcc = Math.max(400, seedAcc * 0.2);

  // --- 2. 「より高くて流量の大きい隣接セル」へ進み、本流を遡る ---
  const path: { x: number; y: number }[] = [];
  const seen = new Set<number>();
  for (let step = 0; step < 200; step++) {
    const i = w.idx(cx, cy);
    seen.add(i);
    path.push({ x: cx, y: cy });
    let best = -1;
    let bestScore = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!w.inBounds(nx, ny)) continue;
        const j = w.idx(nx, ny);
        if (seen.has(j)) continue;
        if (w.height[j] <= w.height[i]) continue; // 上流 = 標高が高い方
        if (w.flowAcc[j] > bestScore) {
          bestScore = w.flowAcc[j];
          best = j;
        }
      }
    }
    if (best < 0) break;
    cx = best % w.w;
    cy = (best / w.w) | 0;
  }

  // --- 3. 町から離れた区間で、貯留効果 ÷ 建設費 が最大の断面を選ぶ ---
  let site: DamSite | null = null;
  let bestValue = 0;
  for (let k = 14; k < path.length; k++) {
    const p = path[k];
    const acc = w.flowAcc[w.idx(p.x, p.y)];
    if (acc < minAcc) continue;
    // 実際に水が流れている地点に限る。flowAcc は「降った雨が全部流れたら」の
    // 集水量なので、涸れ沢にも大きな値が出る。そこに架けても何も貯まらない。
    if (w.water[w.idx(p.x, p.y)] < 0.15) continue;
    for (const abutment of [12, 10, 8, 6, 5]) {
      const span = damSpanLength(w, p.x, p.y, abutment);
      if (span <= 0 || span > DAM_MAX_SPAN) continue;
      const value = (acc * abutment) / span;
      if (value > bestValue) {
        bestValue = value;
        site = { x: p.x, y: p.y, span, abutment, acc };
      }
      break; // その地点では最も高く取れる取り付け高さを採用する
    }
  }
  return site;
}

/**
 * ダムを架けたときに水没する範囲。
 * ここに家や田畑を作ってしまうと、ダムを建てた瞬間に自分の町を沈めることになる。
 * (実際のダム建設で水没予定地に手を入れないのと同じ)
 */
export function reservoirFootprint(w: World, spot: DamSite): Uint8Array {
  const mask = new Uint8Array(w.w * w.h);
  const top = w.height[w.idx(spot.x, spot.y)] + spot.abutment;
  const queue: number[] = [];

  for (let dx = -DAM_MAX_SPAN; dx <= DAM_MAX_SPAN; dx++) {
    const x = spot.x + dx;
    const y = spot.y - 1;
    if (!w.inBounds(x, y)) continue;
    const i = w.idx(x, y);
    if (w.height[i] <= top && !mask[i]) {
      mask[i] = 1;
      queue.push(i);
    }
  }

  let filled = 0;
  while (queue.length > 0 && filled < 6000) {
    const i = queue.pop() as number;
    filled++;
    const x = i % w.w;
    const y = (i / w.w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!w.inBounds(nx, ny)) continue;
      if (ny > spot.y) continue; // ダムより下流へは広がらない
      const j = w.idx(nx, ny);
      if (mask[j] || w.height[j] > top) continue;
      mask[j] = 1;
      queue.push(j);
    }
  }
  return mask;
}

/** 町の上流の狭窄部にダムを架ける */
function buildDam(sim: Simulation, spot: DamSite | null, reserve: number): number {
  const w = sim.world;
  if (!spot) return 0;
  // 途中で資金が尽きて径間が欠けると、そこから水が抜けて堰として機能しない。
  // 全径間ぶんの費用を確保できるまで着手しない。
  if (sim.city.money - damCost(spot) < reserve) return 0;

  const riverLevel = w.height[w.idx(spot.x, spot.y)];
  let built = 0;
  for (const dir of [-1, 1]) {
    for (let d = dir < 0 ? 0 : 1; d < DAM_MAX_SPAN; d++) {
      const x = spot.x + dir * d;
      if (!w.inBounds(x, spot.y)) break;
      const i = w.idx(x, spot.y);
      // 取り付け高さまで立ち上がった地形に達したら、そこが端部
      if (w.height[i] > riverLevel + spot.abutment) break;
      if (w.structure[i] >= 0) continue;
      if (sim.build('dam', x, spot.y).ok) built++;
    }
  }
  return built;
}

/** 堤防の内側に排水機場を置く */
function buildDrainPump(sim: Simulation, site: Site, reserve: number): boolean {
  const w = sim.world;
  if (!afford(sim, 'drainpump', reserve)) return false;
  // 町の中で最も低いセル (内水が集まるところ) を探す
  let best = -1;
  let bestH = Infinity;
  for (const i of w.cellsInRadius(site.x, site.y, 14)) {
    const x = i % w.w;
    const y = (i / w.w) | 0;
    if (!w.canPlace('drainpump', x, y).ok) continue;
    if (w.height[i] < bestH) {
      bestH = w.height[i];
      best = i;
    }
  }
  if (best < 0) return false;
  return sim.build('drainpump', best % w.w, (best / w.w) | 0).ok;
}

/* ------------------------------------------------------------------ */
/* ゲート操作 (洪水調節と渇水補給)                                       */
/* ------------------------------------------------------------------ */

function operateGates(sim: Simulation): void {
  const w = sim.world;
  const peak = sim.weather.forecastPeakInflow(3);
  const now = sim.snapshot.inflow;

  for (const b of w.buildings.values()) {
    if (b.kind !== 'dam') continue;
    const i = w.idx(b.x, b.y);
    const crest = w.height[i] + BUILDINGS.dam.wallHeight * (0.35 + 0.65 * b.hp);

    // 上流側 (北) の水位を見て、あと何 m 貯められるかを測る
    let upstream = -Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = b.x + dx;
      const ny = b.y - 1;
      if (!w.inBounds(nx, ny)) continue;
      upstream = Math.max(upstream, w.level(w.idx(nx, ny)));
    }
    const freeboard = crest - upstream;

    // 判断の順序が肝心。「出水予測が出ている間はずっと全開」にしてしまうと、
    // 洪水の最中もゲートが開きっぱなしになり、ダムは何も貯めずに素通しになる。
    // 실際の操作と同じく、来る前に空け、来たら閉める。
    let target: number;
    if (freeboard < 2.5) {
      // 満水に近い: これ以上貯めると越流して堤体が壊れるので全開にする
      // (実際のダムの「ただし書き操作」にあたる)
      target = 1;
    } else if (now > 25) {
      // 出水が来ている & まだ容量がある: 絞り込んでピークをカットする
      target = 0.06;
    } else if (peak > 150) {
      // 貯水池では受けきれない規模の出水が来る: 事前放流で容量を空ける。
      // 中規模の出水にまで事前放流すると、せっかく貯めた水を先に流してしまい
      // かえってピークが上がる (実測で確認)
      target = 1;
    } else if (sim.weather.drought || now < 8) {
      // 渇水: 貯めておいた水を細く流して下流の取水を維持する
      target = 0.18;
    } else {
      target = 0.35;
    }
    sim.setGate(b, target);
  }
}

/* ------------------------------------------------------------------ */
/* キャンペーン本体                                                     */
/* ------------------------------------------------------------------ */

export function runCampaign(sim: Simulation, opts: AutoplayOptions): CampaignReport {
  const log = opts.log ?? ((): void => {});
  const reserve = opts.reserve ?? 2500;
  const maxHouses = opts.maxHouses ?? 260;
  const w = sim.world;

  const site = pickTownSite(sim);
  if (!site) throw new Error('町を作れる場所が見つかりませんでした');
  const baseHeight = w.height[w.idx(site.x, site.y)];
  log(`町の起点: (${site.x}, ${site.y}) 標高 ${baseHeight.toFixed(1)}m / 拡張方向 (${site.dx},${site.dy})`);

  if (!buildWaterworks(sim, site, reserve)) throw new Error('上水道を敷設できませんでした');

  // ダムの適地と水没予定地を先に決めておき、そこには手を付けない
  const damSpot = findDamSite(w, site);
  const reserved = damSpot ? reservoirFootprint(w, damSpot) : null;
  if (damSpot && reserved) {
    // 堤体を並べる線そのものも予約しておく (堤防に塞がれると架けられない)
    const riverLevel = w.height[w.idx(damSpot.x, damSpot.y)];
    for (const dir of [-1, 1]) {
      for (let d = 0; d < DAM_MAX_SPAN; d++) {
        const x = damSpot.x + dir * d;
        if (!w.inBounds(x, damSpot.y)) break;
        const i = w.idx(x, damSpot.y);
        if (w.height[i] > riverLevel + damSpot.abutment) break;
        reserved[i] = 1;
      }
    }
  }
  if (damSpot) {
    const cells = reserved ? reserved.reduce((a: number, b: number) => a + b, 0) : 0;
    log(
      `ダム適地: (${damSpot.x}, ${damSpot.y}) ${damSpot.span}径間 (￥${damCost(damSpot).toLocaleString('ja-JP')}) / ` +
        `取り付け高 ${damSpot.abutment}m / 支配流域 ${damSpot.acc.toFixed(0)}セル / 水没予定地 ${cells}セル`,
    );
  } else {
    log('ダムを架けられる狭窄部が見つかりませんでした');
  }

  addHouses(sim, 8, baseHeight, reserve, reserved);

  const history: DayRecord[] = [];
  let minMoney = sim.city.money;
  let maxFloodedBuildings = 0;
  let buildingsLost = 0;
  let criticalLost = 0;
  const lostByKind: Record<string, number> = {};
  let leveeBreaches = 0;
  let minWaterRatio = 1;
  let minFood = sim.city.food;
  let peakInflow = 0;
  let leveesBuilt = false;
  let damBuilt = false;
  let pumpBuilt = false;

  for (let day = 0; day < opts.days; day++) {
    for (let h = 0; h < 24; h++) {
      sim.stepHour();
      const s = sim.snapshot;
      buildingsLost += s.damage.destroyed;
      for (const k of s.damage.destroyedKinds) {
        const name = BUILDINGS[k].name;
        lostByKind[name] = (lostByKind[name] ?? 0) + 1;
        // 農地は氾濫原に置くものなので、失われても「守れなかった」とは数えない
        if (BUILDINGS[k].category !== 'agri') criticalLost++;
      }
      leveeBreaches += s.damage.breached;
      maxFloodedBuildings = Math.max(maxFloodedBuildings, s.damage.flooded);
      peakInflow = Math.max(peakInflow, s.inflow);
      minMoney = Math.min(minMoney, s.city.money);
      if (s.net.demand > 0) minWaterRatio = Math.min(minWaterRatio, s.net.served / s.net.demand);
      minFood = Math.min(minFood, s.city.food);
    }

    const s = sim.snapshot;
    operateGates(sim);

    // --- 毎日の投資判断 ---------------------------------------------
    // 順番が大事: 町は「大きくなるほど儲かる」ので、まず人口を増やして
    // 収入源を育て、治水設備はそれを賄えるようになってから固める。
    // (先に堤防を並べると維持費で資本が尽きて、二度と成長できなくなる)

    // 1. 給水能力は人口の伸びに先行させる
    expandWaterSupply(sim, site, reserve);

    // 2. 食料。
    //    「在庫」ではなく「生産能力」を基準にする。在庫を目標にすると、
    //    人口が増えるたびに際限なく農地が増えて維持費で潰れる。
    //    冬は生育が止まるので、その間を凌ぐ在庫 (人口の 0.7 倍) も確保する。
    const needRate = s.city.population * CITY.FOOD_PER_CAPITA * 1.5;
    const haveRate = foodProduction(w);
    if (haveRate < needRate || s.city.food < s.city.population * 0.7 || s.city.foodScore < 0.98) {
      addFarms(sim, site, 4, reserve, reserved);
    }

    // 3. 治水 — 町が維持費を賄えるようになったら、拡張を一旦止めて資金を貯め、
    //    堤防 → 排水機場 → ダム の順に固める。
    //    (常に拡張していると手元に現金が残らず、いつまでもダムが建たない)
    // 治水設備は維持費が重いので、町が十分に稼げるようになってから着手する。
    // 積立額を決め、それを上回った分だけ拡張に回す (積立が貯まらないと
    // いつまでもダムが建たず、かといって拡張を止めると収入が伸びない)
    // 積立の目標額。ダムは高いので、町が十分に稼げる規模 (人口900) に
    // なってから貯め始める。小さいうちに貯めようとすると、成長が止まって
    // 維持費だけがかさみ、いつまでも建たない。
    let defenseFund = 0;
    if (!leveesBuilt && s.city.population > 400) defenseFund = 16000;
    else if (leveesBuilt && !pumpBuilt) defenseFund = 12000;
    else if (leveesBuilt && pumpBuilt && !damBuilt && damSpot && s.city.population > 900) {
      defenseFund = damCost(damSpot) + 8000;
    }

    if (!leveesBuilt && s.city.population > 500 && sim.city.money > 16000) {
      const n = buildLevees(sim, site, 15, 6000, reserved);
      if (n > 0) {
        leveesBuilt = true;
        log(`day ${day}: 堤防を ${n} 区間築いた (人口 ${Math.round(s.city.population)})`);
      }
    }
    if (leveesBuilt && !pumpBuilt && sim.city.money > 12000) {
      pumpBuilt = buildDrainPump(sim, site, 8000);
      if (pumpBuilt) log(`day ${day}: 排水機場を建設`);
    }
    if (leveesBuilt && pumpBuilt && !damBuilt && sim.city.money > 46000) {
      const n = buildDam(sim, damSpot, 8000);
      if (n > 0) {
        damBuilt = true;
        log(`day ${day}: ダムを ${n} 径間で建設 (資金 ￥${Math.round(sim.city.money)})`);
      } else if (day % 20 === 0) {
        log(`day ${day}: ダムを架けられなかった (堤体位置が塞がれている可能性)`);
      }
    }

    // 4. 拡張 — 収支の柱。住宅1棟は 10 日ほどで元が取れる
    const houses = countKind(w, 'house');
    const roomy = s.city.population > houses * CITY.HOUSE_CAPACITY * 0.78;
    const healthy = s.city.waterScore > 0.9 && s.city.foodScore > 0.95;
    if (roomy && healthy && houses < maxHouses && sim.city.money > defenseFund + reserve + 1200) {
      const added = addHouses(sim, 8, baseHeight, reserve, reserved);
      if (added < 6) extendPipes(sim, 8, baseHeight, reserve, reserved);
    }

    history.push({
      day,
      season: sim.weather.season.name,
      population: Math.round(s.city.population),
      money: Math.round(s.city.money),
      waterRatio: s.net.demand > 0 ? s.net.served / s.net.demand : 1,
      food: Math.round(s.city.food),
      inflow: s.inflow,
      floodedCells: s.damage.floodedCells,
      floodedBuildings: s.damage.flooded,
      buildings: w.buildings.size,
      income: sim.city.income,
      expense: sim.city.expense,
    });
  }

  const counts: Record<string, number> = {};
  for (const b of w.buildings.values()) {
    counts[BUILDINGS[b.kind].name] = (counts[BUILDINGS[b.kind].name] ?? 0) + 1;
  }

  // 財政の健全さ: 破産しておらず、かつ直近の運転収支が黒字か。
  // (資金残高で測ると「稼いだ分を全部投資している健全な町」を不安定と誤判定する)
  const recent = history.slice(-30);
  const operatingBalance =
    recent.reduce((a, r) => a + (r.income - r.expense), 0) / Math.max(1, recent.length);
  const peakFloodedCells = history.reduce((a, r) => Math.max(a, r.floodedCells), 0);

  return {
    days: opts.days,
    history,
    population: Math.round(sim.snapshot.city.population),
    money: Math.round(sim.city.money),
    minMoney: Math.round(minMoney),
    financiallyStable: minMoney > 0 && operatingBalance > 0,
    operatingBalance,
    peakFloodedCells,
    lostByKind,
    criticalLost,
    maxFloodedBuildings,
    buildingsLost,
    leveeBreaches,
    minWaterRatio,
    minFood: Math.round(minFood),
    peakInflow,
    counts,
  };
}
