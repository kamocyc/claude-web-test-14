import { HYDRO, MAP } from '../config';
import { clamp } from '../core/rng';
import type { BuildingKind } from './buildings';
import { Simulation } from './simulation';

export const SAVE_VERSION = 1;

export interface SavedBuilding {
  /** kind */
  k: BuildingKind;
  x: number;
  y: number;
  /** hp 0..1 */
  hp: number;
  /** gate 0..1 */
  g: number;
  /** growth 0..1 */
  gr: number;
  /** occupancy 0..1 */
  oc: number;
  /** stored (m^3) */
  st: number;
  /** builtDay */
  bd: number;
}

export interface SaveData {
  version: number;
  label: string;
  createdAt: string;
  seed: number;
  mapSize: number;
  weather: {
    day: number;
    hour: number;
    quick: number;
    slow: number;
    dryDays: number;
  };
  city: {
    money: number;
    food: number;
  };
  /** 地形改変のあったセルだけ [index, height, ...] */
  terrainEdits: number[];
  /** 水深 (Uint16, m×3000) を base64 で */
  water: string;
  /** 土壌水分 (Uint8, 飽和を255) */
  soil: string;
  /** 最大浸水履歴 (Uint16, m×3000) */
  floodMax: string;
  buildings: SavedBuilding[];
  /** 参考情報 (読み込みには使わない) */
  summary?: Record<string, number | string>;
}

/* ------------------------------------------------------------------ */
/* base64 (ブラウザ / Node のどちらでも動く)                            */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const WATER_SCALE = 3000; // 0.33mm 刻み、最大 21.8m

function packU16(src: Float32Array, scale: number): string {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = clamp(Math.round(src[i] * scale), 0, 65535);
  return bytesToBase64(new Uint8Array(out.buffer));
}

function unpackU16(b64: string, dst: Float32Array, scale: number): void {
  const bytes = base64ToBytes(b64);
  const src = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) dst[i] = src[i] / scale;
}

function packU8(src: Float32Array, max: number): string {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = clamp(Math.round((src[i] / max) * 255), 0, 255);
  return bytesToBase64(out);
}

function unpackU8(b64: string, dst: Float32Array, max: number): void {
  const src = base64ToBytes(b64);
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) dst[i] = (src[i] / 255) * max;
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

export function serialize(sim: Simulation, label = 'セーブデータ'): SaveData {
  const w = sim.world;

  // 地形は seed から再生成できるので、掘削/盛土で変わったセルだけ記録する
  const edits: number[] = [];
  for (let i = 0; i < w.height.length; i++) {
    if (Math.abs(w.height[i] - w.natural[i]) > 1e-4) {
      edits.push(i, Math.round(w.height[i] * 1000) / 1000);
    }
  }

  const buildings: SavedBuilding[] = [];
  for (const b of w.buildings.values()) {
    buildings.push({
      k: b.kind,
      x: b.x,
      y: b.y,
      hp: round(b.hp, 4),
      g: round(b.gate, 3),
      gr: round(b.growth, 4),
      oc: round(b.occupancy, 4),
      st: round(b.stored, 2),
      bd: b.builtDay,
    });
  }

  const ws = sim.weather.snapshotState();
  const s = sim.snapshot;

  return {
    version: SAVE_VERSION,
    label,
    createdAt: new Date().toISOString(),
    seed: sim.seed,
    mapSize: w.w,
    weather: ws,
    city: { money: round(sim.city.money, 2), food: round(sim.city.food, 2) },
    terrainEdits: edits,
    water: packU16(w.water, WATER_SCALE),
    soil: packU8(w.soil, HYDRO.SOIL_CAPACITY),
    floodMax: packU16(w.floodMax, WATER_SCALE),
    buildings,
    summary: {
      人口: Math.round(s.city.population),
      資金: Math.round(s.city.money),
      施設数: buildings.length,
      給水率: Math.round((s.net.demand > 0 ? s.net.served / s.net.demand : 1) * 100),
      経過日数: ws.day,
    },
  };
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/* ------------------------------------------------------------------ */
/* 読み込み                                                            */
/* ------------------------------------------------------------------ */

export class SaveError extends Error {}

/** セーブデータの妥当性をざっと確認する */
export function validate(data: unknown): asserts data is SaveData {
  if (!data || typeof data !== 'object') throw new SaveError('セーブデータが読めません');
  const d = data as Partial<SaveData>;
  if (d.version !== SAVE_VERSION) {
    throw new SaveError(`セーブデータの形式が違います (version ${String(d.version)} / 対応 ${SAVE_VERSION})`);
  }
  if (typeof d.seed !== 'number') throw new SaveError('seed がありません');
  if (!Array.isArray(d.buildings)) throw new SaveError('buildings がありません');
  if (d.mapSize !== MAP) {
    throw new SaveError(`マップサイズが違います (${String(d.mapSize)} / 現在 ${MAP})`);
  }
}

/**
 * セーブデータから世界を復元する。
 * 地形は seed から決定論的に再生成されるので、保存するのは差分だけでよい。
 */
export function loadSave(data: SaveData): Simulation {
  validate(data);
  const sim = new Simulation(data.seed);
  applySave(sim, data);
  return sim;
}

/** すでにある Simulation にセーブ内容を上書きする */
export function applySave(sim: Simulation, data: SaveData): void {
  validate(data);
  if (data.seed !== sim.seed) {
    throw new SaveError('シードが一致しません (同じ流域に読み込んでください)');
  }
  const w = sim.world;

  // --- 建造物をいったん全部消す ---
  for (const b of [...w.buildings.values()]) w.removeBuilding(b.x, b.y);

  // --- 地形改変を戻す ---
  w.height.set(w.natural);
  for (let i = 0; i + 1 < data.terrainEdits.length; i += 2) {
    const idx = data.terrainEdits[i];
    if (idx >= 0 && idx < w.height.length) w.height[idx] = data.terrainEdits[i + 1];
  }

  // --- 建造物を復元 ---
  for (const sb of data.buildings) {
    const b = w.addBuilding(sb.k, sb.x, sb.y, sb.bd);
    b.hp = sb.hp;
    b.gate = sb.g;
    b.growth = sb.gr;
    b.occupancy = sb.oc;
    b.stored = sb.st;
  }

  // --- グリッド ---
  unpackU16(data.water, w.water, WATER_SCALE);
  unpackU8(data.soil, w.soil, HYDRO.SOIL_CAPACITY);
  unpackU16(data.floodMax, w.floodMax, WATER_SCALE);
  w.fluxR.fill(0);
  w.fluxD.fill(0);
  w.vx.fill(0);
  w.vy.fill(0);
  w.refreshAllSolid();
  w.terrainVersion++;

  // --- 状態 ---
  sim.weather.restoreState(data.weather);
  sim.city.money = data.city.money;
  sim.city.food = data.city.food;
  sim.network.markDirty();
  sim.moisture.compute();
  sim.moisture.apply(24);

  // 時間を進めずに集計だけ作り直す (読み込み直後から正しい数値を表示する)
  sim.refresh();
}

/* ------------------------------------------------------------------ */
/* ブラウザ用のヘルパ                                                   */
/* ------------------------------------------------------------------ */

export const LOCAL_STORAGE_KEY = 'hydropolis.save.v1';

export function saveToLocalStorage(sim: Simulation, label = 'クイックセーブ'): void {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serialize(sim, label)));
}

export function readLocalStorage(): SaveData | null {
  const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SaveData;
    validate(data);
    return data;
  } catch {
    return null;
  }
}

export function downloadSave(sim: Simulation, label = 'セーブデータ'): void {
  const json = JSON.stringify(serialize(sim, label));
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hydropolis-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
