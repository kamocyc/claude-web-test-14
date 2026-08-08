import { CELL, HYDRO, N_CELLS, MAP } from '../config';
import { clamp } from '../core/rng';
import { BUILDINGS, type Building, type BuildingKind } from '../sim/buildings';
import type { RiverSource, TerrainData } from './terrain';

export interface PlaceCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 世界の状態すべて。グリッドは TypedArray に平坦化して保持する。
 */
export class World {
  readonly w: number;
  readonly h: number;

  /** 地形標高 (m) — 掘削/盛土で変化する */
  readonly height: Float32Array;
  /** 生成直後の標高 (地形改変量の基準) */
  readonly natural: Float32Array;
  /** 構造物による嵩上げ (m) */
  readonly wall: Float32Array;
  /** 水が乗る面の高さ = height + 有効な wall */
  readonly solid: Float32Array;

  /** 水深 (m) */
  readonly water: Float32Array;
  /** 仮想パイプの流束 (m^3/s) — 右/下方向のみ保持し、逆向きは符号で表す */
  readonly fluxR: Float32Array;
  readonly fluxD: Float32Array;
  /** 流速 (m/s) — 描画と侵食判定用 */
  readonly vx: Float32Array;
  readonly vy: Float32Array;

  /** 土壌水分ストック (m 換算) */
  readonly soil: Float32Array;
  /** 灌漑による湿潤度 0..1 */
  readonly moisture: Float32Array;
  /** これまでの最大浸水深 (ハザードマップ用) */
  readonly floodMax: Float32Array;
  /** 平常時に水があるセル。「氾濫面積」を平常時との差で測るための基準 */
  readonly baselineWet: Uint8Array;

  readonly flowAcc: Float32Array;
  readonly riverMask: Uint8Array;
  /** セルにある建造物 ID (-1 = なし) */
  readonly structure: Int32Array;

  readonly buildings = new Map<number, Building>();
  readonly sources: RiverSource[];
  readonly maxHeight: number;
  private nextId = 1;

  /** 描画側へ「地形が変わった」ことを伝えるカウンタ */
  terrainVersion = 0;

  constructor(terrain: TerrainData) {
    this.w = terrain.width;
    this.h = terrain.heightMap;
    const n = this.w * this.h;

    this.height = terrain.height;
    this.natural = Float32Array.from(terrain.height);
    this.wall = new Float32Array(n);
    this.solid = Float32Array.from(terrain.height);
    this.water = new Float32Array(n);
    this.fluxR = new Float32Array(n);
    this.fluxD = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.soil = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.floodMax = new Float32Array(n);
    this.baselineWet = new Uint8Array(n);
    this.flowAcc = terrain.flowAcc;
    this.riverMask = terrain.riverMask;
    this.structure = new Int32Array(n).fill(-1);
    this.sources = terrain.sources;
    this.maxHeight = terrain.maxHeight;

    this.seedInitialWater();
  }

  /** 河道と海にあらかじめ水を入れておく (起動直後から川が流れている状態に) */
  private seedInitialWater(): void {
    for (let i = 0; i < this.water.length; i++) {
      if (this.height[i] < 0) {
        this.water[i] = -this.height[i];
      } else if (this.riverMask[i]) {
        this.water[i] = clamp(0.25 + Math.log(Math.max(2, this.flowAcc[i]) / 70) * 0.32, 0.2, 2.4);
      }
      this.soil[i] = this.riverMask[i] ? HYDRO.SOIL_CAPACITY : HYDRO.SOIL_CAPACITY * 0.45;
    }
  }

  /**
   * 現在の水面を「平常時の水域」として記録する。
   * 起動直後 (川が落ち着いたあと) に一度だけ呼ぶ。
   */
  captureBaselineWet(): void {
    for (let i = 0; i < this.water.length; i++) {
      // 川幅の揺らぎを含めたいので、隣接セルにも余裕を持たせる
      this.baselineWet[i] = this.water[i] > 0.1 ? 1 : 0;
    }
    const src = Uint8Array.from(this.baselineWet);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (src[y * this.w + x]) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
            if (src[ny * this.w + nx]) {
              near = true;
              break;
            }
          }
        }
        if (near) this.baselineWet[y * this.w + x] = 1;
      }
    }
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /** 水面標高 */
  level(i: number): number {
    return this.solid[i] + this.water[i];
  }

  /** 地形傾斜 (m/セル) */
  slope(x: number, y: number): number {
    const xm = clamp(x - 1, 0, this.w - 1);
    const xp = clamp(x + 1, 0, this.w - 1);
    const ym = clamp(y - 1, 0, this.h - 1);
    const yp = clamp(y + 1, 0, this.h - 1);
    const dx = (this.height[y * this.w + xp] - this.height[y * this.w + xm]) * 0.5;
    const dy = (this.height[yp * this.w + x] - this.height[ym * this.w + x]) * 0.5;
    return Math.hypot(dx, dy);
  }

  buildingAt(x: number, y: number): Building | undefined {
    if (!this.inBounds(x, y)) return undefined;
    const id = this.structure[this.idx(x, y)];
    return id < 0 ? undefined : this.buildings.get(id);
  }

  /** 構造物の有効な壁高 (ゲート開度を反映) */
  effectiveWall(b: Building): number {
    const def = BUILDINGS[b.kind];
    if (def.wallHeight <= 0) return 0;
    const gateFactor = def.hasGate ? 1 - b.gate : 1;
    // 損傷した堤防は低くなる (越流しやすくなる)
    return def.wallHeight * gateFactor * (0.35 + 0.65 * b.hp);
  }

  refreshSolid(i: number): void {
    const id = this.structure[i];
    let wall = 0;
    if (id >= 0) {
      const b = this.buildings.get(id);
      if (b) wall = this.effectiveWall(b);
    }
    this.wall[i] = wall;
    this.solid[i] = this.height[i] + wall;
  }

  refreshAllSolid(): void {
    for (let i = 0; i < this.solid.length; i++) this.refreshSolid(i);
  }

  /* --------------------------------------------------------------- */
  /* 建設                                                             */
  /* --------------------------------------------------------------- */

  canPlace(kind: BuildingKind, x: number, y: number): PlaceCheck {
    if (!this.inBounds(x, y)) return { ok: false, reason: 'マップ外' };
    const i = this.idx(x, y);
    if (this.structure[i] >= 0) return { ok: false, reason: 'すでに建造物がある' };
    const def = BUILDINGS[kind];

    if (this.slope(x, y) > def.maxSlope) return { ok: false, reason: '傾斜が急すぎる' };

    const deepWater = this.water[i] > 0.55;
    if (deepWater && def.wallHeight <= 0 && kind !== 'intake') {
      return { ok: false, reason: '水中には建てられない' };
    }

    if (def.needsWater && this.maxWaterNear(x, y, 2) < 0.25) {
      // 河道 (riverMask) があっても水が流れていなければ取水できない
      return {
        ok: false,
        reason: this.hasRiverNeighbor(x, y) ? '水が流れていない (涸れ川)' : '川に隣接していない',
      };
    }

    if ((kind === 'farm' || kind === 'paddy' || kind === 'house') && this.height[i] < 0.2) {
      return { ok: false, reason: '低すぎる (海面下)' };
    }
    return { ok: true };
  }

  /** 半径 r 以内の最大水深 (m) */
  maxWaterNear(x: number, y: number, r: number): number {
    let d = 0;
    for (const i of this.cellsInRadius(x, y, r)) {
      if (this.water[i] > d) d = this.water[i];
    }
    return d;
  }

  hasRiverNeighbor(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const j = this.idx(nx, ny);
        if (this.riverMask[j] || this.water[j] > 0.3) return true;
      }
    }
    return false;
  }

  addBuilding(kind: BuildingKind, x: number, y: number, day: number): Building {
    const i = this.idx(x, y);
    const b: Building = {
      id: this.nextId++,
      kind,
      x,
      y,
      hp: 1,
      gate: BUILDINGS[kind].hasGate ? (kind === 'dam' ? 0.25 : 1) : 0,
      active: true,
      net: -1,
      growth: 0,
      occupancy: kind === 'house' ? 0.1 : 0,
      stored: 0,
      rate: 0,
      builtDay: day,
    };
    this.buildings.set(b.id, b);
    this.structure[i] = b.id;
    this.refreshSolid(i);
    this.terrainVersion++;
    return b;
  }

  removeBuilding(x: number, y: number): Building | undefined {
    const i = this.idx(x, y);
    const id = this.structure[i];
    if (id < 0) return undefined;
    const b = this.buildings.get(id);
    this.buildings.delete(id);
    this.structure[i] = -1;
    this.refreshSolid(i);
    this.terrainVersion++;
    return b;
  }

  /* --------------------------------------------------------------- */
  /* 地形改変                                                         */
  /* --------------------------------------------------------------- */

  /** 掘削/盛土。delta > 0 で盛土。動かした土量 (m^3) を返す */
  modifyTerrain(x: number, y: number, delta: number): number {
    if (!this.inBounds(x, y)) return 0;
    const i = this.idx(x, y);
    if (this.structure[i] >= 0) return 0;
    const before = this.height[i];
    const after = clamp(before + delta, -8, this.maxHeight + 12);
    if (Math.abs(after - before) < 1e-4) return 0;
    this.height[i] = after;
    // 掘れば水が入る余地ができる / 盛れば水は押し出される
    if (delta > 0) {
      this.water[i] = Math.max(0, this.water[i] - (after - before));
    }
    this.refreshSolid(i);
    this.terrainVersion++;
    return Math.abs(after - before) * CELL * CELL;
  }

  /** 指定半径のセル一覧 */
  *cellsInRadius(cx: number, cy: number, r: number): Generator<number> {
    const r2 = r * r;
    for (let y = Math.max(0, cy - r); y <= Math.min(this.h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(this.w - 1, cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) yield y * this.w + x;
      }
    }
  }

  /** 全水量 (m^3) */
  totalWater(): number {
    let s = 0;
    for (let i = 0; i < this.water.length; i++) s += this.water[i];
    return s * CELL * CELL;
  }
}

export const WORLD_CELLS = N_CELLS;
export const WORLD_SIZE = MAP;
