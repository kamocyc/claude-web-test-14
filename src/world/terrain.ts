import { MinHeap } from '../core/heap';
import { Perlin } from '../core/noise';
import { RNG, clamp, smoothstep } from '../core/rng';
import { MAP } from '../config';

export interface RiverSource {
  x: number;
  y: number;
  /** 流量の重み (合計 1.0 になるよう正規化済み) */
  weight: number;
}

export interface TerrainData {
  /** 標高 (m) */
  height: Float32Array;
  /** 流域面積 (上流セル数) */
  flowAcc: Float32Array;
  /** 河道フラグ */
  riverMask: Uint8Array;
  /** 湧出点 (山地側の源流) */
  sources: RiverSource[];
  maxHeight: number;
  width: number;
  heightMap: number;
}

const NX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const NY8 = [0, 1, 1, 1, 0, -1, -1, -1];
const ND8 = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/* ------------------------------------------------------------------ */
/* 1. ベース地形                                                        */
/* ------------------------------------------------------------------ */

/**
 * ベース地形を [0,1] に正規化して返す。
 * 侵食計算のパラメータは 0..1 スケールを前提にしているため、
 * メートルへの変換は侵食が終わったあとに行う。
 */
function baseHeight(rng: RNG, w: number, h: number): Float32Array {
  const p = new Perlin(rng);
  const warp = new Perlin(rng);
  const out = new Float32Array(w * h);
  const off = rng.range(0, 500);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x / w;
      const ny = y / h;

      // ドメインワーピングで「まっすぐすぎない」自然な尾根をつくる
      const wx = warp.fbm(nx * 2.1 + off, ny * 2.1, 4) * 0.55;
      const wy = warp.fbm(nx * 2.1, ny * 2.1 + off + 31.7, 4) * 0.55;

      const fx = nx * 3.4 + wx;
      const fy = ny * 3.4 + wy;

      // なだらかな丘陵 + 山岳の尾根
      const hills = (p.fbm(fx, fy, 7) + 1) * 0.5;
      const ridge = p.ridged(fx * 0.85 + 11.3, fy * 0.85 - 7.1, 5);

      // 北 (y=0) ほど山、南 (y=h) ほど平野 → 河口へ向かう自然な傾斜。
      // 山地帯を南へ伸ばしてあるのは、川が山の中を流れる区間を長くするため
      // (平野をだらだら流れるだけだと、谷が広すぎてダムを架ける場所がない)。
      const mountain = smoothstep(0.2, 0.72, 1 - ny);
      const plain = smoothstep(0.46, 0.92, ny);

      let v = hills * (0.42 + 0.25 * plain) + ridge * mountain * 1.35;
      // 全体傾斜 (南へ下る)
      v -= ny * 0.46;
      // 平野部は起伏を抑える
      v = v * (1 - 0.35 * plain);

      out[y * w + x] = v;
    }
  }

  normalize(out);
  // 低地を広く、山を鋭く
  for (let i = 0; i < out.length; i++) out[i] = Math.pow(out[i], 1.45);
  return out;
}

/**
 * 本流の山あい区間に**狭窄部 (ゴルジュ) を彫る**。
 *
 * 川筋そのものには触らず、川から数セル離れたところの両岸だけを持ち上げる。
 * すると「川幅は変わらないのに両岸が切り立った」峡谷ができる — 山地を横切る川が
 * 硬い岩盤を穿ってつくる地形と同じで、ここがダムの適地になる。
 * 狭いので少ない径間で塞げ、上流側は谷が広いのでよく貯まる。
 *
 * 侵食が終わって「どこが川か」が確定してから彫り、そのあと軽く侵食をかけ直すので、
 * 定規で引いたような壁にはならない。
 *
 * @param field 0..1 に正規化された高さ場
 * @param acc   侵食後の流域面積 (どこが本流かを知るために使う)
 */
/**
 * 本流の山あい区間に**狭窄部 (ゴルジュ) を彫る**。
 *
 * 川筋そのものには触らず、川から数セル離れた両岸だけを持ち上げる。すると
 * 「川幅は変わらないのに両岸が切り立った」峡谷ができる — 山地を横切る川が硬い岩盤を
 * 穿ってつくる地形と同じで、ここがダムの適地になる。狭いので少ない径間で塞げ、
 * 上流側は谷が広いのでよく貯まる。
 *
 * 壁の高さは「川筋からの距離」で決める。直線ではなく**実際の流路をたどる**ので、
 * 川が曲がっていても両岸が途切れない。侵食が終わって流路が確定してから彫り、
 * そのあと軽く侵食をかけ直すので、定規で引いたような壁にはならない。
 *
 * @param field 標高 (m)
 * @param acc   確定した流域面積 (どこが本流かを知るために使う)
 */
function sculptGorges(field: Float32Array, acc: Float32Array, w: number, h: number, rng: RNG): void {
  let maxAcc = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxAcc) maxAcc = acc[i];

  // 山地〜中下流を 3 帯に分け、それぞれで最も水を集めている地点 (= 本流) を選ぶ。
  // 下流側にも1つ置かないと、支流が合わさって町の水源になった本流を押さえられない。
  const bands: [number, number][] = [
    [0.2, 0.34],
    [0.36, 0.5],
    [0.52, 0.64],
    [0.66, 0.78],
  ];

  // 各帯で、離れた 2 本の川筋に彫る。マップは複数の川に分かれて海へ注ぐので、
  // いちばん大きい 1 本だけに彫ると、町が別の川沿いに開けたときに適地がなくなる。
  const targets: number[] = [];
  for (const [y0, y1] of bands) {
    const from = Math.round(y0 * h);
    const to = Math.round(y1 * h);
    const cands: number[] = [];
    for (let y = from; y < to; y++) {
      for (let x = 6; x < w - 6; x++) {
        const i = y * w + x;
        if (acc[i] > maxAcc * 0.05) cands.push(i);
      }
    }
    cands.sort((a, b) => acc[b] - acc[a]);
    const picked: number[] = [];
    for (const i of cands) {
      if (picked.length >= 2) break;
      const ix = i % w;
      const iy = (i / w) | 0;
      // 既に選んだ地点と近すぎるものは同じ川筋なので飛ばす
      const far = picked.every((j) => Math.hypot((j % w) - ix, ((j / w) | 0) - iy) > 30);
      if (far) picked.push(i);
    }
    targets.push(...picked);
  }

  for (const best of targets) {

    // 峡谷の寸法 (セル)。谷底の半幅 + 壁の立ち上がりが、そのまま
    // 「塞ぐのに要する径間数の半分」になる。
    const floor = rng.range(1.3, 2.0); // 谷底の半幅
    const rise = rng.range(1.4, 2.2); // 壁が立ち上がるまでの距離
    const half = rng.int(6) + 9; // 川に沿った長さ (片側のセル数)
    // 壁の高さは「河床から見て堰 (16m) より確実に高い」値に決め打ちする。
    // 元の地形へ一定量を足すやり方だと、もともと低い所では堰を越えられず谷が閉じない。
    const wallH = rng.range(21, 30); // 河床からの壁の高さ (m)

    // --- 川筋をたどる (上流へ acc の大きい方、下流へ最急降下) ---
    const path: number[] = [best];
    let cur = best;
    for (let s = 0; s < half; s++) {
      const cx = cur % w;
      const cy = (cur / w) | 0;
      let next = -1;
      let bestA = 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NX8[k];
        const ny = cy + NY8[k];
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
        const j = ny * w + nx;
        if (field[j] <= field[cur]) continue; // 上流 = 高い方
        if (acc[j] > bestA) {
          bestA = acc[j];
          next = j;
        }
      }
      if (next < 0) break;
      path.unshift(next);
      cur = next;
    }
    cur = best;
    for (let s = 0; s < half; s++) {
      const cx = cur % w;
      const cy = (cur / w) | 0;
      let next = -1;
      let drop = 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NX8[k];
        const ny = cy + NY8[k];
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
        const j = ny * w + nx;
        const d = field[cur] - field[j];
        if (d > drop) {
          drop = d;
          next = j;
        }
      }
      if (next < 0) break;
      path.push(next);
      cur = next;
    }

    // --- 川筋からの距離で壁を立てる ---
    const reach = Math.ceil(floor + rise + 5);
    let left = w;
    let right = 0;
    let top = h;
    let bottom = 0;
    for (const j of path) {
      const jx = j % w;
      const jy = (j / w) | 0;
      left = Math.min(left, jx);
      right = Math.max(right, jx);
      top = Math.min(top, jy);
      bottom = Math.max(bottom, jy);
    }
    left = Math.max(0, left - reach);
    right = Math.min(w - 1, right + reach);
    top = Math.max(0, top - reach);
    bottom = Math.min(h - 1, bottom + reach);

    const mid = path.indexOf(best);
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        // いちばん近い川筋セルまでの距離と、そのセルの川沿い位置を求める
        let dist2 = Infinity;
        let at = 0;
        for (let s = 0; s < path.length; s++) {
          const jx = path[s] % w;
          const jy = (path[s] / w) | 0;
          const d2 = (x - jx) * (x - jx) + (y - jy) * (y - jy);
          if (d2 < dist2) {
            dist2 = d2;
            at = s;
          }
        }
        // 川そのもの (本流も支流も) は絶対に埋めない。埋めると水の出口がなくなり、
        // 窪地解消で谷が平らな湖になってしまう。
        if (acc[y * w + x] > RIVER_THRESHOLD * 0.5) continue;
        const dist = Math.sqrt(dist2);
        const wall = smoothstep(floor, floor + rise, dist);
        if (wall <= 0) continue;
        // 峡谷の前後はなだらかに戻す (急に壁が終わると不自然)
        const t = (at - mid) / (path.length * 0.5 + 1);
        const env = Math.exp(-t * t * 1.6);
        if (env < 0.05) continue;
        // 一様な壁に見えないよう、ゆるやかな凹凸をつける
        const rough = 1 + 0.16 * Math.sin(x * 0.63 + y * 0.41) + 0.09 * Math.sin(y * 0.27 - x * 0.19);
        // 「いちばん近い川筋セルの河床」を基準にするので、壁は川と一緒に下っていく
        const bed = field[path[at]];
        const want = bed + wall * env * wallH * rough;
        // 持ち上げるだけ。もともと高い尾根を削ってしまわない
        if (want > field[y * w + x]) field[y * w + x] = want;
      }
    }
  }
}

/** [0,1] に正規化する */
function normalize(a: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < a.length; i++) {
    a[i] = Number.isFinite(a[i]) ? clamp((a[i] - lo) / span, 0, 1) : 0;
  }
}

/** 正規化された地形をメートルへ変換し、南端を海へ落とす */
function toMeters(field: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = field[i] * 122 - 4;

  const coast = 9;
  for (let y = h - coast; y < h; y++) {
    const t = (y - (h - coast)) / (coast - 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = out[i] * (1 - t) + (-7 - 3 * t) * t;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 水力侵食 (droplet erosion)                                        */
/* ------------------------------------------------------------------ */

export interface ErosionParams {
  droplets: number;
  maxSteps: number;
  inertia: number;
  capacity: number;
  erode: number;
  deposit: number;
  evaporate: number;
  gravity: number;
  radius: number;
}

const DEFAULT_EROSION: ErosionParams = {
  droplets: 90000,
  maxSteps: 42,
  inertia: 0.05,
  capacity: 4,
  erode: 0.3,
  deposit: 0.3,
  evaporate: 0.012,
  gravity: 4,
  radius: 2,
};

/** 1ステップで動かせる土量の上限 (正規化スケール) — 数値の暴走を防ぐ */
const MAX_TRANSFER = 0.02;

/** 双一次補間した高さと勾配 */
function heightAndGradient(hm: Float32Array, w: number, h: number, px: number, py: number) {
  const cx = Math.min(w - 2, Math.max(0, Math.floor(px)));
  const cy = Math.min(h - 2, Math.max(0, Math.floor(py)));
  const u = px - cx;
  const v = py - cy;
  const i = cy * w + cx;
  const nw = hm[i];
  const ne = hm[i + 1];
  const sw = hm[i + w];
  const se = hm[i + w + 1];
  const gx = (ne - nw) * (1 - v) + (se - sw) * v;
  const gy = (sw - nw) * (1 - u) + (se - ne) * u;
  const height = nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v;
  return { height, gx, gy };
}

export function erode(
  hm: Float32Array,
  w: number,
  h: number,
  rng: RNG,
  params: Partial<ErosionParams> = {},
): void {
  const P = { ...DEFAULT_EROSION, ...params };

  // 侵食/堆積を半径内へ分配するためのブラシ
  const brush: number[] = [];
  const brushW: number[] = [];
  let wsum = 0;
  for (let dy = -P.radius; dy <= P.radius; dy++) {
    for (let dx = -P.radius; dx <= P.radius; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > P.radius) continue;
      brush.push(dy * w + dx);
      const weight = 1 - d / (P.radius + 1);
      brushW.push(weight);
      wsum += weight;
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] /= wsum;

  for (let d = 0; d < P.droplets; d++) {
    let px = rng.range(1, w - 2);
    let py = rng.range(1, h - 2);
    let dx = 0;
    let dy = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < P.maxSteps; step++) {
      const nodeX = Math.floor(px);
      const nodeY = Math.floor(py);
      const cellOffX = px - nodeX;
      const cellOffY = py - nodeY;
      const g = heightAndGradient(hm, w, h, px, py);

      dx = dx * P.inertia - g.gx * (1 - P.inertia);
      dy = dy * P.inertia - g.gy * (1 - P.inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len;
      dy /= len;
      px += dx;
      py += dy;

      if (px < 1 || px >= w - 2 || py < 1 || py >= h - 2) break;

      const newH = heightAndGradient(hm, w, h, px, py).height;
      const dh = newH - g.height;

      const cap = Math.max(-dh * speed * water * P.capacity, 0.008);

      const dropIndex = nodeY * w + nodeX;
      if (sediment > cap || dh > 0) {
        // 上りに転じた or 飽和 → 堆積
        const raw = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * P.deposit;
        const amount = Math.min(raw, MAX_TRANSFER);
        sediment -= amount;
        // 双一次で 4 近傍へ配分
        hm[dropIndex] += amount * (1 - cellOffX) * (1 - cellOffY);
        hm[dropIndex + 1] += amount * cellOffX * (1 - cellOffY);
        hm[dropIndex + w] += amount * (1 - cellOffX) * cellOffY;
        hm[dropIndex + w + 1] += amount * cellOffX * cellOffY;
      } else {
        // 下り → 侵食 (ブラシで滑らかに削る)
        const amount = Math.min((cap - sediment) * P.erode, -dh, MAX_TRANSFER);
        for (let b = 0; b < brush.length; b++) {
          const idx = dropIndex + brush[b];
          if (idx < 0 || idx >= hm.length) continue;
          const delta = amount * brushW[b];
          hm[idx] -= delta;
        }
        sediment += amount;
      }

      speed = Math.sqrt(Math.max(0, speed * speed + -dh * P.gravity));
      water *= 1 - P.evaporate;
      if (water < 0.01) break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. 窪地除去 (Priority-Flood + ε)                                     */
/* ------------------------------------------------------------------ */

/**
 * すべてのセルからマップ外へ単調に下る経路が存在するよう、窪地を微小勾配で埋める。
 * これにより「水が溜まって消える」ことなく河川が海までつながる。
 */
export function resolveDepressions(hm: Float32Array, w: number, h: number, eps = 0.0015): void {
  const closed = new Uint8Array(w * h);
  const heap = new MinHeap(w * 2 + h * 2 + 16);

  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x;
      if (!closed[i]) {
        closed[i] = 1;
        heap.push(hm[i], i);
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const i = y * w + x;
      if (!closed[i]) {
        closed[i] = 1;
        heap.push(hm[i], i);
      }
    }
  }

  while (heap.length > 0) {
    const c = heap.pop();
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NX8[k];
      const ny = cy + NY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (closed[n]) continue;
      closed[n] = 1;
      if (hm[n] <= hm[c] + eps) hm[n] = hm[c] + eps;
      heap.push(hm[n], n);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. 流域面積 (D8)                                                     */
/* ------------------------------------------------------------------ */

/** 流れの集中度。大きいほど最急降下方向に寄る (D8 に近づく) */
const MFD_EXPONENT = 2.6;

/**
 * 上流セル数 (流域面積) を積み上げる。
 *
 * D8 (最急1方向) だと平坦地で流路が 8 方向のどれかに吸着し、直線的な水路が
 * できてしまう。ここでは MFD (複数流向) を使い、低い隣接セルすべてへ
 * 傾斜の MFD_EXPONENT 乗で按分することで、自然に収束する流路を得る。
 */
export function computeFlowAccumulation(hm: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const acc = new Float32Array(n).fill(1);
  const sorted = new Int32Array(n);
  for (let i = 0; i < n; i++) sorted[i] = i;
  // 高い順に処理すれば 1 パスで累積できる
  sorted.sort((a, b) => hm[b] - hm[a]);

  const weight = new Float64Array(8);

  for (let s = 0; s < n; s++) {
    const i = sorted[s];
    const x = i % w;
    const y = (i / w) | 0;
    let total = 0;
    let escapes = false;

    for (let k = 0; k < 8; k++) {
      weight[k] = 0;
      const nx = x + NX8[k];
      const ny = y + NY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
        escapes = true; // マップ外 (海) へ抜ける
        continue;
      }
      const slope = (hm[i] - hm[ny * w + nx]) / ND8[k];
      if (slope <= 0) continue;
      const ww = Math.pow(slope, MFD_EXPONENT);
      weight[k] = ww;
      total += ww;
    }

    if (escapes || total <= 0) continue;
    const share = acc[i] / total;
    for (let k = 0; k < 8; k++) {
      if (weight[k] <= 0) continue;
      acc[(y + NY8[k]) * w + (x + NX8[k])] += weight[k] * share;
    }
  }
  return acc;
}

/* ------------------------------------------------------------------ */
/* 5. 河道の掘り込み                                                    */
/* ------------------------------------------------------------------ */

function boxBlur(src: Float32Array, w: number, h: number, radius = 1): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let d = -radius; d <= radius; d++) {
        const nx = x + d;
        if (nx < 0 || nx >= w) continue;
        s += src[y * w + nx];
        c++;
      }
      tmp[y * w + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let d = -radius; d <= radius; d++) {
        const ny = y + d;
        if (ny < 0 || ny >= h) continue;
        s += tmp[ny * w + x];
        c++;
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

const RIVER_THRESHOLD = 70;

function carveChannels(hm: Float32Array, acc: Float32Array, w: number, h: number): void {
  const carve = new Float32Array(w * h);
  for (let i = 0; i < carve.length; i++) {
    if (acc[i] <= RIVER_THRESHOLD) continue;
    const mag = Math.log(acc[i] / RIVER_THRESHOLD);
    carve[i] = Math.min(9.5, 1.15 + mag * 1.55);
  }
  // 掘り込みを広げすぎると谷底が幅広くなり、堰を架けられる狭窄部がなくなる。
  // 河道そのものは深く、周囲へのならしは控えめにする。
  const wide = boxBlur(boxBlur(carve, w, h, 1), w, h, 2);
  for (let i = 0; i < hm.length; i++) {
    hm[i] -= Math.max(carve[i] * 0.82, wide[i] * 0.7);
  }
}

/* ------------------------------------------------------------------ */
/* 6. 生成本体                                                          */
/* ------------------------------------------------------------------ */

export function generateTerrain(seed: number, w = MAP, h = MAP, quality = 1): TerrainData {
  const rng = new RNG(seed);

  // 1. ノイズで骨格をつくり (0..1)、2. 水で削り、3. メートルへ変換する
  const field = baseHeight(rng, w, h);
  const droplets = Math.round(((90000 * (w * h)) / (192 * 192)) * quality);
  erode(field, w, h, rng, { droplets });
  normalize(field);

  const height = toMeters(field, w, h);

  resolveDepressions(height, w, h);
  let acc = computeFlowAccumulation(height, w, h);
  carveChannels(height, acc, w, h);
  resolveDepressions(height, w, h);
  acc = computeFlowAccumulation(height, w, h);

  // 4. 流路が確定してから、山あい区間に狭窄部を彫る (= 峡谷 / ダムの適地)。
  //    侵食や河道掘削のあとに彫るのは、それらが川筋を動かしてしまうため。
  //    先に彫ると、せっかくの峡谷の外を川が流れることになる。
  sculptGorges(height, acc, w, h, rng);
  resolveDepressions(height, w, h); // 壁の裏に窪地ができていたら解消する
  acc = computeFlowAccumulation(height, w, h);

  let maxHeight = -Infinity;
  for (let i = 0; i < height.length; i++) if (height[i] > maxHeight) maxHeight = height[i];

  const riverMask = new Uint8Array(w * h);
  for (let i = 0; i < riverMask.length; i++) riverMask[i] = acc[i] > RIVER_THRESHOLD ? 1 : 0;

  const sources = pickSources(height, acc, w, h, maxHeight);

  return { height, flowAcc: acc, riverMask, sources, maxHeight, width: w, heightMap: h };
}

/** 山地側にある流量の大きいセルを源流として選ぶ (互いに離す)。 */
function pickSources(
  hm: Float32Array,
  acc: Float32Array,
  w: number,
  h: number,
  maxHeight: number,
): RiverSource[] {
  const cands: number[] = [];
  const minH = maxHeight * 0.34;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (hm[i] < minH) continue;
      if (acc[i] < RIVER_THRESHOLD * 1.5) continue;
      cands.push(i);
    }
  }
  cands.sort((a, b) => acc[b] - acc[a]);

  const chosen: RiverSource[] = [];
  const minSep = Math.max(14, Math.floor(w * 0.12));
  for (const i of cands) {
    if (chosen.length >= 5) break;
    const x = i % w;
    const y = (i / w) | 0;
    let ok = true;
    for (const c of chosen) {
      if (Math.hypot(c.x - x, c.y - y) < minSep) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    chosen.push({ x, y, weight: Math.sqrt(acc[i]) });
  }

  if (chosen.length === 0) {
    // 保険: 最高標高のセルを源流にする
    let best = 0;
    for (let i = 0; i < hm.length; i++) if (hm[i] > hm[best]) best = i;
    chosen.push({ x: best % w, y: (best / w) | 0, weight: 1 });
  }

  const total = chosen.reduce((s, c) => s + c.weight, 0);
  for (const c of chosen) c.weight /= total;
  return chosen;
}

/** 標高から地表の種類 (描画・建設判定用) を返す */
export function slopeAt(hm: Float32Array, w: number, h: number, x: number, y: number): number {
  const xm = clamp(x - 1, 0, w - 1);
  const xp = clamp(x + 1, 0, w - 1);
  const ym = clamp(y - 1, 0, h - 1);
  const yp = clamp(y + 1, 0, h - 1);
  const dzdx = (hm[y * w + xp] - hm[y * w + xm]) * 0.5;
  const dzdy = (hm[yp * w + x] - hm[ym * w + x]) * 0.5;
  return Math.hypot(dzdx, dzdy);
}
