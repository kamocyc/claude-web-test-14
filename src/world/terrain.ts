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
  const axisPhase = rng.range(0, Math.PI * 2);

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

      // 北 1/3 が山地 (ダムを架ける上流域)、南 2/3 が平野 (人が住む下流域)。
      //   mountain: ny 0.10 まで満額 → 0.38 でゼロ (その間が山麓)
      //   plain:    ny 0.28 から立ち上がり 0.52 で満額
      const mountain = smoothstep(0.62, 0.9, 1 - ny);
      const plain = smoothstep(0.28, 0.52, ny);

      // 起伏 (丘陵 + 山岳の尾根)。平野側では起伏そのものを抑える。
      const relief = (hills * (0.42 + 0.25 * plain) + ridge * mountain * 1.35) * (1 - 0.55 * plain);

      // 谷の軸 — 南北に蛇行する「本流の通り道」。
      // 南北傾斜だけを強くすると、斜面を平行に流れ落ちる小川が何本も並ぶだけの
      // 地形になり、「一本の川の流域」に見えなくなる。軸から離れるほど地面を
      // 持ち上げて、支流が本流へ集まるようにする。
      const axis = 0.5 + Math.sin(ny * 2.3 + axisPhase) * 0.15 + (warp.fbm(ny * 1.7, off * 0.01, 3) - 0.5) * 0.22;
      const across = Math.min(1, Math.abs(nx - axis) / 0.46);
      const valley = Math.pow(across, 1.7) * (0.55 + 0.5 * mountain);

      // 全体傾斜 (南へ下る)。傾斜には平野側の減衰を掛けない
      // (掛けると南端が持ち上がって、せっかくの傾斜を打ち消す)。
      out[y * w + x] = relief + valley - ny * 0.78;
    }
  }

  normalize(out);
  // 低地を広く、山を鋭く。南北傾斜を強くしたぶん平野側が 0 付近に潰れるので、
  // 以前ほどきつく持ち上げない (1.45 だと下流が海面下に沈む)。
  for (let i = 0; i < out.length; i++) out[i] = Math.pow(out[i], 1.25);
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

  // 狭窄部は**上流域 (北 1/3) の中だけ**に彫る。
  // 下流は人が住む場所なので、ここに峡谷を作ると氾濫原が潰れ、水位が上がっても
  // 水は谷の中で深くなるだけになる (堤防にも排水機場にも仕事が無くなる)。
  // 帯は「山地の出口」= ちょうど 1/3 の境をまたぐ位置に置く。現実のダムサイトと
  // 同じ場所であるうえ、両側の制約からここしか成り立たない:
  //   上流に寄せすぎる → 支配できる流域が小さく、かつ**湛水がマップ上端に届く**。
  //     境界セルは海として排水されるので (hydrology.ts の edge)、端に触れた
  //     貯水池は水が抜けてしまい、ダムとして成立しない。
  //   下流に寄せすぎる → 人が住む氾濫原を峡谷が潰す。
  const bands: [number, number][] = [
    [0.2, 0.27],
    [0.27, 0.34],
    [0.34, 0.41],
  ];

  // 各帯で、離れた 3 本の川筋に彫る。マップは複数の川に分かれて海へ注ぐので、
  // いちばん大きい 1 本だけに彫ると、町が別の川沿いに開けたときに適地がなくなる。
  // 帯を上流に寄せたぶん 1 帯あたりの本数を増やして、適地の総数を維持する。
  const targets: number[] = [];
  for (const [y0, y1] of bands) {
    const from = Math.round(y0 * h);
    const to = Math.round(y1 * h);
    const cands: number[] = [];
    for (let y = from; y < to; y++) {
      for (let x = 6; x < w - 6; x++) {
        const i = y * w + x;
        // 上流ほど集水量が小さいので、下流と同じ閾値では候補が採れない
        if (acc[i] > maxAcc * 0.025) cands.push(i);
      }
    }
    cands.sort((a, b) => acc[b] - acc[a]);
    const picked: number[] = [];
    for (const i of cands) {
      if (picked.length >= 3) break;
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
    // 川に沿った長さ (片側のセル数)。
    // ここは**背水長より長く**なければならない。上流域の河床勾配は約 0.53m/セル
    // なので 16m の堰がつくる背水は約 30 セル伸びる。峡谷がそれより短いと、
    // 貯水池の上流端が壁の外へはみ出し、そこから水が横へ逃げてダムが成立しない。
    const half = rng.int(10) + 22;
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
    // 壁は「河道沿いの細い縁」では足りない。縁だけだと、堰でせき止めた水が
    // 縁の外側 (= 隣の支流の谷) へ乗り越えて、そのまま下流の平野へ抜けてしまう。
    // 峡谷を囲む**山塊**になるまで広げて、周りの分水嶺ごと持ち上げる。
    const flank = 14; // 満高で保つ幅 (セル)
    const fade = 8; // そこから自然地形へ戻すまでの幅 (セル)
    const reach = Math.ceil(floor + rise + flank + fade);
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
        // 立ち上がったあと、外側でまた自然地形へ戻す**帯**にする。
        // 立ち上げっぱなしにすると、走査した矩形いっぱいが河床+wallH の
        // 台地になってしまい、真上から見て長方形のブロックとして露出する。
        const inner = smoothstep(floor, floor + rise, dist);
        const outer = 1 - smoothstep(floor + rise + flank, floor + rise + flank + fade, dist);
        const wall = inner * outer;
        if (wall <= 0.02) continue;
        // 峡谷の前後はなだらかに戻す (急に壁が終わると不自然)。
        // ただし中央付近は満高で保つ — ガウス減衰だと壁が中央以外で低くなり、
        // 貯水池の上流端がそこを越えて溢れてしまう。
        const t = Math.abs((at - mid) / (path.length * 0.5 + 1));
        const env = 1 - smoothstep(0.55, 1, t);
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

/**
 * 下流域 (南 2/3) に**氾濫原 — 幅の広い平らな谷底**を彫る。
 *
 * `sculptGorges` と対になる処理。これが無いと、水位が上がっても水は谷の中で
 * 深くなるだけで横に広がらない。実測では日雨量 720mm でも浸水は陸地の 3.8% に
 * とどまり、そのかわり水深が 9.5m に達していた — 峡谷の底が深くなっても、
 * 段丘の上の町には何も起きないので、堤防にも排水機場にも仕事が生まれない。
 *
 * 実際の沖積河川と同じく、**下流ほど (集める水が多いほど) 谷底を広く**取る。
 * 川筋からの距離で目標高さを決め、**下げる方向にだけ**適用する
 * (持ち上げると意図しない堰ができて、その裏に水が溜まってしまう)。
 */
function carveFloodplain(field: Float32Array, acc: Float32Array, w: number, h: number): void {
  const n = w * h;
  let maxAcc = 0;
  for (let i = 0; i < n; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
  const logSpan = Math.log(Math.max(2, maxAcc / RIVER_THRESHOLD));

  /**
   * その行が氾濫原になる度合い (山地では 0)。狭窄部の帯 (〜0.41) には掛からない。
   *
   * 帯をこれ以上上流へ寄せると、ダムが支配できる流域が 20% → 8% に落ちる
   * (集水する前の細い沢を塞いでも、下流の町は守れない)。山地の出口に置くのが
   * いちばん効く、という現実のダムと同じ結論になる。
   */
  const zoneAt = (y: number): number => smoothstep(0.44, 0.6, y / h);

  // --- 河道までの距離と「いちばん近い河道セル」をチャンファー距離で求める ---
  const D1 = 1;
  const D2 = Math.SQRT2;
  const dist = new Float32Array(n).fill(Infinity);
  const near = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (acc[i] > RIVER_THRESHOLD && zoneAt((i / w) | 0) > 0) {
      dist[i] = 0;
      near[i] = i;
    }
  }
  const relax = (i: number, j: number, cost: number): void => {
    const d = dist[j] + cost;
    if (d < dist[i]) {
      dist[i] = d;
      near[i] = near[j];
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (y > 0) {
        relax(i, i - w, D1);
        if (x > 0) relax(i, i - w - 1, D2);
        if (x < w - 1) relax(i, i - w + 1, D2);
      }
      if (x > 0) relax(i, i - 1, D1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (y < h - 1) {
        relax(i, i + w, D1);
        if (x < w - 1) relax(i, i + w + 1, D2);
        if (x > 0) relax(i, i + w - 1, D2);
      }
      if (x < w - 1) relax(i, i + 1, D1);
    }
  }

  // --- 目標高さまで下げる ---
  for (let y = 0; y < h; y++) {
    const zone = zoneAt(y);
    if (zone <= 0) continue;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const src = near[i];
      if (src < 0) continue;
      // 集水量が多い川ほど谷底を広く、氾濫原の面も高く取る (= 満杯まで深い)
      const mag = clamp(Math.log(Math.max(1, acc[src] / RIVER_THRESHOLD)) / logSpan, 0, 1);
      const half = 5 + 20 * mag; // 谷底の半幅 (セル) — 本流で約 300m
      const rise = 1.6 + 1.2 * mag; // 河床から氾濫原の面までの高さ (m)
      // 谷底の外側は 1.1m/セル で自然地形へ戻す
      const target = field[src] + rise + Math.max(0, dist[i] - half) * 1.1;
      if (target >= field[i]) continue; // 下げるときだけ触る
      field[i] += (target - field[i]) * zone;
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
  // 下駄 (+6m) を履かせて、平野の南端でも陸地が残るようにする。海は下の
  // `coast` 行で明示的に作るので、内陸に海面下の土地を作る必要はない。
  for (let i = 0; i < field.length; i++) out[i] = field[i] * 112 + 6;

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
  // 5. 下流域には逆に、幅の広い平らな氾濫原を彫る (狭窄部と対になる処理)。
  //    上流で水を止め、下流で水を広げる — これで治水施設に仕事が生まれる。
  carveFloodplain(height, acc, w, h);
  resolveDepressions(height, w, h); // 壁の裏や氾濫原に窪地ができていたら解消する
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
