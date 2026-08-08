import { describe, expect, it } from 'vitest';
import { RNG } from '../src/core/rng';
import { computeFlowAccumulation, generateTerrain, resolveDepressions } from '../src/world/terrain';

/** 各セルから「より低い隣接セル」へ辿れるか (窪地が残っていないか) を確認する */
function countPits(hm: Float32Array, w: number, h: number): number {
  let pits = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let lower = false;
      for (let dy = -1; dy <= 1 && !lower; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (hm[(y + dy) * w + (x + dx)] < hm[i]) {
            lower = true;
            break;
          }
        }
      }
      if (!lower) pits++;
    }
  }
  return pits;
}

describe('resolveDepressions', () => {
  it('窪地をすべて解消する', () => {
    const w = 32;
    const h = 32;
    const rng = new RNG(7);
    const hm = new Float32Array(w * h);
    for (let i = 0; i < hm.length; i++) hm[i] = rng.range(0, 40);
    expect(countPits(hm, w, h)).toBeGreaterThan(0);

    resolveDepressions(hm, w, h);
    expect(countPits(hm, w, h)).toBe(0);
  });

  it('標高を下げることはない (埋めるだけ)', () => {
    const w = 24;
    const h = 24;
    const rng = new RNG(11);
    const hm = new Float32Array(w * h);
    for (let i = 0; i < hm.length; i++) hm[i] = rng.range(0, 30);
    const before = Float32Array.from(hm);
    resolveDepressions(hm, w, h);
    for (let i = 0; i < hm.length; i++) {
      expect(hm[i]).toBeGreaterThanOrEqual(before[i] - 1e-6);
    }
  });
});

describe('computeFlowAccumulation', () => {
  it('傾斜面では下流ほど流域面積が大きい', () => {
    const w = 16;
    const h = 16;
    const hm = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) hm[y * w + x] = (h - y) * 2;
    }
    const acc = computeFlowAccumulation(hm, w, h);
    const top = acc[2 * w + 8];
    const bottom = acc[(h - 2) * w + 8];
    expect(bottom).toBeGreaterThan(top);
  });

  it('総流量はセル数を超えない', () => {
    const w = 20;
    const h = 20;
    const rng = new RNG(3);
    const hm = new Float32Array(w * h);
    for (let i = 0; i < hm.length; i++) hm[i] = rng.range(0, 50);
    resolveDepressions(hm, w, h);
    const acc = computeFlowAccumulation(hm, w, h);
    for (let i = 0; i < acc.length; i++) {
      expect(acc[i]).toBeLessThanOrEqual(w * h);
      expect(acc[i]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('generateTerrain', () => {
  const t = generateTerrain(12345, 72, 72, 0.25);

  it('窪地のない、海まで繋がった地形になる', () => {
    expect(countPits(t.height, 72, 72)).toBe(0);
  });

  it('河道が抽出され、源流が山地側にある', () => {
    const riverCells = t.riverMask.reduce((a, b) => a + b, 0);
    expect(riverCells).toBeGreaterThan(20);
    expect(t.sources.length).toBeGreaterThan(0);
    for (const s of t.sources) {
      const hAt = t.height[s.y * 72 + s.x];
      expect(hAt).toBeGreaterThan(t.maxHeight * 0.3);
    }
    const total = t.sources.reduce((a, s) => a + s.weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('同じシードなら同じ地形になる', () => {
    const t2 = generateTerrain(12345, 72, 72, 0.25);
    expect(Array.from(t2.height.slice(0, 200))).toEqual(Array.from(t.height.slice(0, 200)));
  });

  it('南 (河口側) の平均標高は北 (山地) より低い', () => {
    let north = 0;
    let south = 0;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 72; x++) {
        north += t.height[y * 72 + x];
        south += t.height[(71 - y) * 72 + x];
      }
    }
    expect(south).toBeLessThan(north);
  });
});
