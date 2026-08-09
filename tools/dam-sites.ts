/**
 * ダムの適地を測る。
 *
 * 「良いダムサイト」= 谷が狭くて (= 少ない径間で塞げて)、上流に大きな流域と
 * 貯水容量がある地点。ゲームでは 1 セルにつき 1 基のダム (￥4,200) を並べて
 * 谷を塞ぐので、**必要径間数がそのまま建設費**になる。
 *
 *   npx vite-node tools/dam-sites.ts [seed...]
 */
import { CELL } from '../src/config';
import { BUILDINGS } from '../src/sim/buildings';
import { hashSeed } from '../src/core/rng';
import { generateTerrain } from '../src/world/terrain';

const DAM_H = BUILDINGS.dam.wallHeight;
/** これを超える径間数は現実的に建設できないとみなす */
const MAX_SPAN = 16;

const NX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const NY8 = [0, 1, 1, 1, 0, -1, -1, -1];

export interface DamSite {
  x: number;
  y: number;
  /** 谷を塞ぐのに要する径間数 (= ダムの基数) */
  span: number;
  /** 上流流域 (km²) */
  areaKm2: number;
  /** 満水時の貯水量 (百万 m³) */
  storageMm3: number;
  /** 径間1つあたりの貯水量 — 費用対効果 */
  perSpan: number;
  /** 湛水がマップ外まで達する (切り出しの都合) */
  leaks: boolean;
  bedH: number;
}

/** 地点 c で谷を横断するのに必要な径間数と、その並び */
function spanAt(h: Float32Array, w: number, hh: number, x: number, y: number): number[] | null {
  const i = y * w + x;
  const crest = h[i] + DAM_H;

  // 流下方向 (最急降下) を求め、その直交方向へ谷を横断する
  let best = -1;
  let bestDrop = 0;
  for (let k = 0; k < 8; k++) {
    const nx = x + NX8[k];
    const ny = y + NY8[k];
    if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
    const drop = h[i] - h[ny * w + nx];
    if (drop > bestDrop) {
      bestDrop = drop;
      best = k;
    }
  }
  if (best < 0) return null;
  // 直交方向 (8 近傍を 2 つ回す = 90°)
  const px = NX8[(best + 2) % 8];
  const py = NY8[(best + 2) % 8];

  const cells = [i];
  for (const dir of [1, -1]) {
    for (let s = 1; s <= MAX_SPAN; s++) {
      const nx = x + px * s * dir;
      const ny = y + py * s * dir;
      if (nx < 0 || ny < 0 || nx >= w || ny >= hh) return null; // 谷が閉じない
      const j = ny * w + nx;
      if (h[j] >= crest) break; // 尾根に到達 = ここで塞げる
      cells.push(j);
      if (cells.length > MAX_SPAN) return null;
    }
  }
  return cells;
}

/**
 * ダムを架けたときの貯水量 (m³) と、湛水が場外へ抜けるか。
 * このマップは広い流域の切り出しなので、湛水が上流端に達することはふつうにある。
 * その場合は「そこまでの容量」を返し、漏れとして印をつける。
 */
function storage(
  h: Float32Array,
  w: number,
  hh: number,
  x: number,
  y: number,
  span: number[],
): { vol: number; leaks: boolean } | null {
  const i = y * w + x;
  const crest = h[i] + DAM_H;
  const blocked = new Set(span);

  // 上流側 (堰より高い隣接セルのうち、いちばん低いもの) から湛水させる
  let start = -1;
  let startH = Infinity;
  for (let k = 0; k < 8; k++) {
    const nx = x + NX8[k];
    const ny = y + NY8[k];
    if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
    const j = ny * w + nx;
    if (blocked.has(j) || h[j] <= h[i]) continue;
    if (h[j] < startH) {
      startH = h[j];
      start = j;
    }
  }
  if (start < 0) return null;

  const seen = new Uint8Array(w * hh);
  const stack = [start];
  seen[start] = 1;
  let vol = 0;
  let count = 0;
  let leaks = false;
  while (stack.length) {
    const j = stack.pop() as number;
    const jx = j % w;
    const jy = (j / w) | 0;
    vol += (crest - h[j]) * CELL * CELL;
    if (++count > 40000) return null;
    for (let k = 0; k < 8; k++) {
      const nx = jx + NX8[k];
      const ny = jy + NY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= hh) {
        leaks = true; // 湛水がマップの外まで達する
        continue;
      }
      const m = ny * w + nx;
      if (seen[m] || blocked.has(m)) continue;
      if (h[m] >= crest) continue;
      seen[m] = 1;
      stack.push(m);
    }
  }
  return { vol, leaks };
}

export function findDamSites(seed: number): {
  sites: DamSite[];
  maxAcc: number;
  reject: { span: number; storage: number };
} {
  const t = generateTerrain(seed);
  const { height: h, flowAcc: acc, width: w, heightMap: hh } = t;
  let maxAcc = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxAcc) maxAcc = acc[i];

  const sites: DamSite[] = [];
  const reject = { span: 0, storage: 0 };
  for (let y = 4; y < hh - 12; y++) {
    for (let x = 4; x < w - 4; x++) {
      const i = y * w + x;
      // 本流〜主要支流だけを見る (町が取水できる規模)。
      // ダムは山地に架けるものなので、下流の大流量地点だけを見ると適地を見落とす。
      if (acc[i] < maxAcc * 0.04) continue;
      if (h[i] < 2) continue; // 河口の低地は対象外
      const span = spanAt(h, w, hh, x, y);
      if (!span) {
        reject.span++;
        continue;
      }
      const st = storage(h, w, hh, x, y, span);
      if (st === null || st.vol <= 0) {
        reject.storage++;
        continue;
      }
      sites.push({
        x,
        y,
        span: span.length,
        areaKm2: (acc[i] * CELL * CELL) / 1e6,
        storageMm3: st.vol / 1e6,
        perSpan: st.vol / 1e6 / span.length,
        leaks: st.leaks,
        bedH: h[i],
      });
    }
  }
  sites.sort((a, b) => b.perSpan - a.perSpan);
  return { sites, maxAcc, reject };
}

function report(seedText: string): void {
  const seed = /^\d+$/.test(seedText) ? Number(seedText) : hashSeed(seedText);
  const { sites, maxAcc } = findDamSites(seed);
  // 一番知りたいのは「安く塞げる地点のうち、いちばん大きな川はどれか」。
  // 上流の枝沢をいくら安く塞げても、下流の町の水は守れない。
  // 湛水がマップ外まで続く地点 (河口の低地など) は、ダムサイトとしては数えない
  const cheap = sites.filter((s) => s.span <= 10 && !s.leaks).sort((a, b) => b.areaKm2 - a.areaKm2);
  const best = cheap[0];
  const basinKm2 = (maxAcc * CELL * CELL) / 1e6;
  console.log(
    `seed=${seedText.padEnd(12)} 候補 ${String(sites.length).padStart(3)} ` +
      `(≤10径間で湛水が収まる ${String(cheap.length).padStart(3)}) / ` +
      (best
        ? `最大の川 (${String(best.x).padStart(3)},${String(best.y).padStart(3)}) ` +
          `${String(best.span).padStart(2)}径間 ￥${String(best.span * BUILDINGS.dam.cost).padStart(6)} / ` +
          `流域 ${best.areaKm2.toFixed(2)}km² (全流域の ${((best.areaKm2 / basinKm2) * 100).toFixed(0)}%) / ` +
          `貯水 ${best.storageMm3.toFixed(2)}百万m³`
        : '安く塞げる地点なし'),
  );
}

const args = process.argv.slice(2);
const seeds = args.length > 0 ? args : ['hydro-demo', '1', '2', '3', '4', '5'];
for (const s of seeds) report(s);
