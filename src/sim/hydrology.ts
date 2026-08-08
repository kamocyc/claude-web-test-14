import { CELL, CELL_AREA, HYDRO, SEA_LEVEL, TIME_COMPRESSION, WEATHER } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';

/**
 * 仮想パイプ法 (Mei et al.) による浅水シミュレーション。
 *
 * - セル間の水面標高差から流束を加速させ、摩擦 (DAMPING) で減衰させる
 * - 「そのセルにある水量以上は流出できない」という制約でスケールし、質量を厳密に保存する
 * - マップ外は海 (標高 SEA_LEVEL) として扱い、境界から水が出入りする
 */
export class Hydrology {
  /** 1ステップで海へ出た水量 (m^3) */
  lastOutflow = 0;
  /** 直近ステップでの最大流速 (m/s) */
  maxSpeed = 0;

  private outflow: Float32Array;
  private scale: Float32Array;

  constructor(private world: World) {
    const n = world.w * world.h;
    this.outflow = new Float32Array(n);
    this.scale = new Float32Array(n);
  }

  step(dt = HYDRO.DT): void {
    const w = this.world;
    const W = w.w;
    const H = w.h;
    const water = w.water;
    const solid = w.solid;
    const fR = w.fluxR;
    const fD = w.fluxD;
    const accel = (dt * HYDRO.PIPE_AREA * HYDRO.G) / HYDRO.PIPE_LEN;
    const damp = HYDRO.DAMPING;

    // --- 1. 流束の更新 (符号付き: 正 = 右/下向き) -------------------
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        const li = solid[i] + water[i];
        if (x < W - 1) {
          const j = i + 1;
          fR[i] = fR[i] * damp + accel * (li - (solid[j] + water[j]));
        }
        if (y < H - 1) {
          const j = i + W;
          fD[i] = fD[i] * damp + accel * (li - (solid[j] + water[j]));
        }
      }
    }

    // --- 2. セルごとの総流出量を集計 --------------------------------
    const out = this.outflow;
    out.fill(0);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (x < W - 1) {
          const f = fR[i];
          if (f > 0) out[i] += f;
          else out[i + 1] -= f;
        }
        if (y < H - 1) {
          const f = fD[i];
          if (f > 0) out[i] += f;
          else out[i + W] -= f;
        }
      }
    }

    // --- 3. 水量を超える流出はスケールダウン ------------------------
    const k = this.scale;
    for (let i = 0; i < out.length; i++) {
      const need = out[i] * dt;
      const have = water[i] * CELL_AREA;
      k[i] = need > have ? (have > 0 ? have / need : 0) : 1;
    }

    // --- 4. 流束を確定し、水深を更新 --------------------------------
    const invArea = 1 / CELL_AREA;
    let maxSpeed = 0;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (x < W - 1) {
          const j = i + 1;
          let f = fR[i];
          f *= f > 0 ? k[i] : k[j];
          fR[i] = f;
          const v = f * dt * invArea;
          water[i] -= v;
          water[j] += v;
        }
        if (y < H - 1) {
          const j = i + W;
          let f = fD[i];
          f *= f > 0 ? k[i] : k[j];
          fD[i] = f;
          const v = f * dt * invArea;
          water[i] -= v;
          water[j] += v;
        }
      }
    }

    // --- 5. 境界 (海) との交換 --------------------------------------
    let drained = 0;
    const bk = HYDRO.BOUNDARY_K * dt;
    const edge = (i: number) => {
      const lvl = solid[i] + water[i];
      if (lvl > SEA_LEVEL) {
        const d = Math.min(water[i], (lvl - SEA_LEVEL) * bk);
        water[i] -= d;
        drained += d;
      } else if (solid[i] < SEA_LEVEL) {
        water[i] += (SEA_LEVEL - lvl) * bk;
      }
    };
    for (let x = 0; x < W; x++) {
      edge(x);
      edge((H - 1) * W + x);
    }
    for (let y = 1; y < H - 1; y++) {
      edge(y * W);
      edge(y * W + W - 1);
    }
    this.lastOutflow = drained * CELL_AREA;

    // --- 6. 流速場 (描画・水車・侵食判定用) --------------------------
    const vx = w.vx;
    const vy = w.vy;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        const d = water[i];
        if (d < HYDRO.EPS_DEPTH) {
          vx[i] = 0;
          vy[i] = 0;
          continue;
        }
        const fx = ((x > 0 ? fR[i - 1] : 0) + (x < W - 1 ? fR[i] : 0)) * 0.5;
        const fy = ((y > 0 ? fD[i - W] : 0) + (y < H - 1 ? fD[i] : 0)) * 0.5;
        const inv = 1 / (CELL * Math.max(0.12, d));
        vx[i] = fx * inv;
        vy[i] = fy * inv;
        const s = Math.hypot(vx[i], vy[i]);
        if (s > maxSpeed) maxSpeed = s;
      }
    }
    this.maxSpeed = maxSpeed;
  }

  /**
   * 源流からの流入。
   * @param totalQ 全源流の合計流量 (m^3/s)
   * @param hydroSeconds この呼び出しが担当する hydro 時間
   */
  addSourceInflow(totalQ: number, hydroSeconds: number): void {
    const w = this.world;
    for (const s of w.sources) {
      const volume = totalQ * s.weight * hydroSeconds;
      // 源流点とその周囲に配って 1 セルに集中しすぎないようにする
      let count = 0;
      const cells: number[] = [];
      for (const i of w.cellsInRadius(s.x, s.y, 1)) {
        cells.push(i);
        count++;
      }
      const per = volume / (count * CELL_AREA);
      for (const i of cells) w.water[i] += per;
    }
  }

  /**
   * 降雨を地表に加える (m)。空間的なムラを少し付ける。
   */
  addRain(depth: number, phase: number): void {
    if (depth <= 0) return;
    const w = this.world;
    const W = w.w;
    const H = w.h;
    for (let y = 0; y < H; y++) {
      const fy = Math.sin((y / H) * 3.1 + phase) * 0.18;
      for (let x = 0; x < W; x++) {
        const fx = Math.cos((x / W) * 2.7 - phase * 0.7) * 0.18;
        w.water[y * W + x] += depth * (1 + fx + fy);
      }
    }
  }

  /**
   * 1ゲーム時間ぶんの蒸発・浸透・土壌への降雨・地下水流出。
   *
   * 水面 (water) への出入りは水理計算と同じ圧縮時間で行う (TIME_COMPRESSION)。
   * これを怠ると、河川が受け取る量より蒸発・浸透で失う量の方が大きくなり、
   * 川が数日で干上がってしまう。
   * 一方 soil は「実時間の貯留槽」として扱い、雨から直接涵養され、
   * 基底流出 (m^3/s) として河川へ戻る。
   *
   * @param rainMm この1時間の降雨強度 (mm/h)
   * @returns 地下水から河川へ供給される水量 (1ゲーム時間あたりの m^3)
   */
  hourlyExchange(hours: number, evapScale: number, rainMm = 0): number {
    const w = this.world;
    const water = w.water;
    const soil = w.soil;
    const evap = HYDRO.EVAP_BASE * evapScale * hours * TIME_COMPRESSION;
    const infil = HYDRO.INFILTRATION * hours * TIME_COMPRESSION;
    // 降雨のうち地表流出にならなかったぶんは土壌へ浸透する
    const soilRain = (rainMm / 1000) * (1 - WEATHER.RUNOFF_RATIO) * hours;
    const release = HYDRO.BASEFLOW_RATE * hours;
    const cap = HYDRO.SOIL_CAPACITY;
    let base = 0;

    for (let i = 0; i < water.length; i++) {
      const d = water[i];
      if (d > 0) {
        // 蒸発
        const e = Math.min(d, evap);
        water[i] = d - e;
        // 水面下の浸透 (土壌が満たされるまで)
        const room = cap - soil[i];
        if (room > 0) {
          const q = Math.min(water[i], Math.min(infil, room));
          water[i] -= q;
          soil[i] += q;
        }
      }
      if (soilRain > 0) soil[i] = Math.min(cap, soil[i] + soilRain);
      // 土壌水は緩やかに減り、一部が基底流出として河川へ戻る
      const loss = soil[i] * release;
      soil[i] -= loss;
      base += loss;
    }
    return base * CELL_AREA;
  }

  /** 指定セルを通過している流量の大きさ (m^3/s) */
  fluxMagnitude(x: number, y: number): number {
    const w = this.world;
    const i = w.idx(x, y);
    const fx = ((x > 0 ? w.fluxR[i - 1] : 0) + (x < w.w - 1 ? w.fluxR[i] : 0)) * 0.5;
    const fy = ((y > 0 ? w.fluxD[i - w.w] : 0) + (y < w.h - 1 ? w.fluxD[i] : 0)) * 0.5;
    return Math.hypot(fx, fy);
  }

  /** 浸水深の最大値を記録 (ハザードマップ) */
  recordFloodMax(): void {
    const w = this.world;
    for (let i = 0; i < w.water.length; i++) {
      if (w.water[i] > w.floodMax[i]) w.floodMax[i] = w.water[i];
    }
  }

  /** 排水機場: 半径内の水を汲み出す。汲み出した水量 (m^3) を返す */
  drain(cx: number, cy: number, radius: number, amount: number): number {
    const w = this.world;
    let total = 0;
    for (const i of w.cellsInRadius(cx, cy, radius)) {
      const d = Math.min(w.water[i], amount);
      if (d <= 0) continue;
      w.water[i] -= d;
      total += d;
    }
    return total * CELL_AREA;
  }

  /** デバッグ/テスト用: 全体の水量が有限かどうか */
  sanityCheck(): boolean {
    const water = this.world.water;
    for (let i = 0; i < water.length; i++) {
      if (!Number.isFinite(water[i]) || water[i] < -1e-6) return false;
    }
    return true;
  }
}

/** 水深から見た「安全度」(0 = 危険) — UI 表示用 */
export function floodSeverity(depth: number): number {
  return clamp(depth / 1.5, 0, 1);
}
