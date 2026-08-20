import { describe, expect, it } from 'vitest';
import { CELL, MAP, VOXEL, voxelBlocksPerCell } from '../src/config';
import { BLOCK_INDICES, BLOCK_QUADS, BLOCK_VERTS, buildBlockGeometry } from '../src/render/gfx/blockgeo';
import { generateTerrain } from '../src/world/terrain';
import { World } from '../src/world/world';

describe('目地の間隔', () => {
  /**
   * 高さは uVScale 倍して描くので、目地を常に 3m 間隔で引くとブロックが
   * 縦長に見える。1段の見かけの高さに合わせているか確かめる。
   *
   * ブロック数は整数しか取れないので、縦横比をぴったり 1 にはできない。
   * 比で近いほうを選んでいるぶん、最悪でも √2 倍以内には収まる
   * (隣り合う整数 n, n+1 の幾何中点 √(n(n+1)) が最悪点)。
   * 既定の 1.45 倍では 1.09 とほぼ立方体。
   */
  it('高さ強調をどう振ってもブロックが立方体から √2 倍以上ずれない', () => {
    for (let vscale = 1.0; vscale <= 3.0001; vscale += 0.01) {
      const blockXZ = CELL / voxelBlocksPerCell(vscale);
      const aspect = (VOXEL.SIZE * vscale) / blockXZ;
      expect(Math.abs(Math.log2(aspect))).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    const atDefault = (VOXEL.SIZE * 1.45) / (CELL / voxelBlocksPerCell(1.45));
    expect(atDefault).toBeGreaterThan(0.9);
    expect(atDefault).toBeLessThan(1.15);
  });

  it('セルの一辺を割り切るので目地がセル境界と揃う', () => {
    for (let vscale = 1.0; vscale <= 3.0001; vscale += 0.05) {
      const n = voxelBlocksPerCell(vscale);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('ブロックのジオメトリ', () => {
  const g = buildBlockGeometry();

  it('上面 + セル境界ぶんの面を持つ', () => {
    expect(BLOCK_QUADS).toBe(MAP * MAP + (MAP + 1) * MAP + MAP * (MAP + 1));
    expect(g.getAttribute('position').count).toBe(BLOCK_VERTS);
    expect(g.getIndex()?.count).toBe(BLOCK_INDICES);
  });

  it('セル境界の面は1枚ずつしか無い (重複して張らない)', () => {
    const cells = g.getAttribute('aCells');
    const seen = new Set<string>();
    let tops = 0;
    for (let v = 0; v < cells.count; v += 4) {
      const key = `${cells.getX(v)},${cells.getY(v)},${cells.getZ(v)},${cells.getW(v)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (cells.getX(v) === cells.getZ(v) && cells.getY(v) === cells.getW(v)) tops++;
    }
    expect(tops).toBe(MAP * MAP);
  });

  it('境界面は必ず1軸だけ隣り合うセルを結ぶ', () => {
    const cells = g.getAttribute('aCells');
    for (let v = 0; v < cells.count; v += 4) {
      const dx = Math.abs(cells.getZ(v) - cells.getX(v));
      const dy = Math.abs(cells.getW(v) - cells.getY(v));
      if (dx === 0 && dy === 0) continue; // 上面
      expect(dx + dy).toBe(1);
    }
  });

  it('頂点は NaN を含まず、XZ がマップ内、Y は役割フラグ', () => {
    const pos = g.getAttribute('position').array as Float32Array;
    const span = MAP * CELL;
    let bad = 0;
    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k];
      const y = pos[k + 1];
      const z = pos[k + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++;
      else if (x < 0 || x > span || z < 0 || z > span) bad++;
      else if (y !== 0 && y !== 1) bad++;
    }
    expect(bad).toBe(0);
  });

  it('外周の境界面はマップ外のセルを指す (ジオラマの側面になる)', () => {
    const cells = g.getAttribute('aCells');
    let outside = 0;
    for (let v = 0; v < cells.count; v += 4) {
      const ax = cells.getX(v);
      const ay = cells.getY(v);
      const bx = cells.getZ(v);
      const by = cells.getW(v);
      const out = (cx: number, cy: number): boolean => cx < 0 || cy < 0 || cx >= MAP || cy >= MAP;
      if (out(ax, ay) || out(bx, by)) outside++;
    }
    expect(outside).toBe(MAP * 4);
  });
});

/**
 * 水の壁の高さは頂点シェーダ (`cellWater` + `bot` の式) が決めている。
 * **標高を丸めていない**ので、水面はシミュレーションの値そのままでよく、
 * 「丸め上がった地面に水が埋もれる」問題は起きない。
 */
describe('水の壁', () => {
  const t = generateTerrain(4242, 72, 72, 0.35);
  const world = new World(t);

  /** シェーダの cellWater と同じ */
  const cell = (i: number) => ({
    lvl: world.solid[i] + world.water[i],
    bed: world.solid[i],
    depth: Math.max(world.water[i], 0),
  });

  const wall = (i: number, j: number) => {
    const a = cell(i);
    const b = cell(j);
    const top = Math.max(a.lvl, b.lvl);
    const bot = Math.min(top, Math.max(Math.max(a.bed, b.bed), Math.min(a.lvl, b.lvl)));
    return { height: top - bot, depth: a.lvl >= b.lvl ? a.depth : b.depth };
  };

  it('水面の基準が地形の天面と一致する (丸めによるずれが無い)', () => {
    for (let i = 0; i < t.width * t.heightMap; i++) {
      expect(cell(i).bed).toBe(world.solid[i]);
      expect(cell(i).lvl - cell(i).depth).toBeCloseTo(world.solid[i], 9);
    }
  });

  it('水際には壁が立ち、水中どうしの境界では潰れる', () => {
    let walls = 0;
    let insideBody = 0;
    for (let y = 0; y < t.heightMap; y++) {
      for (let x = 0; x < t.width; x++) {
        const i = y * t.width + x;
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= t.width || ny >= t.heightMap) continue;
          const j = ny * t.width + nx;
          const r = wall(i, j);
          if (r.depth < 0.006) continue;
          if (r.height > 1e-4) walls++;
          // 十分に水没した2セルのあいだには板を立てない (湖の中に壁が見えてしまう)
          else if (world.water[i] > 0.2 && world.water[j] > 0.2) insideBody++;
        }
      }
    }
    expect(walls).toBeGreaterThan(0);
    expect(insideBody).toBeGreaterThan(0);
  });

  it('壁が水面より上や河床より下へはみ出さない', () => {
    for (let y = 0; y < t.heightMap - 1; y++) {
      for (let x = 0; x < t.width - 1; x++) {
        const i = y * t.width + x;
        const j = i + 1;
        const r = wall(i, j);
        const a = cell(i);
        const b = cell(j);
        expect(r.height).toBeGreaterThanOrEqual(0);
        expect(r.height).toBeLessThanOrEqual(Math.max(a.lvl, b.lvl) - Math.min(a.bed, b.bed) + 1e-9);
      }
    }
  });
});
