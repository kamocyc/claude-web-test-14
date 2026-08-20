import { describe, expect, it } from 'vitest';
import { CELL, MAP, VOXEL, voxelBlocksPerCell, voxelH, voxelLevel } from '../src/config';
import { BLOCK_INDICES, BLOCK_QUADS, BLOCK_VERTS, buildBlockGeometry } from '../src/render/gfx/blockgeo';
import { VOXEL_GLSL } from '../src/render/gfx/glsl';
import { generateTerrain } from '../src/world/terrain';
import { World } from '../src/world/world';

describe('ボクセル格子への丸め', () => {
  const samples = [-24, -7.5, -4.5, -1.5, -0.4, 0, 0.4, 1.4, 1.5, 3, 4.5, 6.2, 47.9, 118];

  it('必ずブロック高の倍数に乗る', () => {
    for (const h of samples) {
      expect(voxelH(h) % VOXEL.SIZE).toBeCloseTo(0, 9);
    }
  });

  it('ずれはブロック高の半分を超えない', () => {
    for (const h of samples) {
      expect(Math.abs(voxelH(h) - h)).toBeLessThanOrEqual(VOXEL.SIZE / 2 + 1e-9);
    }
  });

  it('2度掛けても動かない (冪等)', () => {
    for (const h of samples) {
      expect(voxelH(voxelH(h))).toBeCloseTo(voxelH(h), 9);
    }
  });

  it('順序を壊さない (単調)', () => {
    const sorted = [...samples].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(voxelH(sorted[i])).toBeGreaterThanOrEqual(voxelH(sorted[i - 1]));
    }
  });

  /**
   * CPU と GPU がずれると、建物や木がブロックから浮く/沈む。
   * GLSL は vitest で実行できないので、シェーダが使っている式
   * `floor(h / uVoxel + 0.5) * uVoxel` を TS で再現して突き合わせる。
   */
  it('GLSL 側の式と一致する (負の標高でも)', () => {
    const glsl = (h: number): number => Math.floor(h / VOXEL.SIZE + 0.5) * VOXEL.SIZE;
    for (let h = -30; h <= 130; h += 0.1) {
      expect(voxelH(h)).toBeCloseTo(glsl(h), 9);
    }
  });

  it('シェーダが実際にその式を持っている', () => {
    expect(VOXEL_GLSL).toContain('floor(h / uVoxel + 0.5) * uVoxel');
  });
});

describe('表示上の水面', () => {
  it('丸め上がったブロックの中に水が埋もれない', () => {
    // 地形 4.0m → ブロック上面 3.0m ではなく 3.0m... 4.0 は 3 に丸まる
    // 逆に 4.6m は 6.0m へ丸め上がるので、素の solid+water では水が埋まる
    const height = 4.6;
    const solid = 4.6;
    const water = 0.2;
    expect(solid + water).toBeLessThan(voxelH(height));
    expect(voxelLevel(height, solid, water)).toBeGreaterThan(voxelH(height));
  });

  it('堤防の嵩上げは丸めずそのまま乗る', () => {
    const height = 6;
    const wall = 5;
    const level = voxelLevel(height, height + wall, 0.5);
    expect(level).toBeCloseTo(voxelH(height) + wall + 0.5, 6);
  });

  it('乾いたセルでは表示上の地面と同じ高さになる', () => {
    expect(voxelLevel(4.6, 4.6, 0)).toBeCloseTo(voxelH(4.6), 6);
  });
});

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
 * 実際の地形で「水がブロックに埋もれない」ことを確かめる。
 *
 * 地形を丸め上げたセルでは、素の `solid + water` がブロック上面より下に
 * 来てしまう。実測でおよそ 2 割の水面セルがこれに当たるので、
 * `voxelLevel` の押し上げが効かないと川がごっそり消える。
 */
describe('実地形での水の見え方', () => {
  const t = generateTerrain(4242, 72, 72, 0.35);
  const world = new World(t);
  const n = t.width * t.heightMap;

  /** シェーダ (cellWater) と同じ式 */
  const cell = (i: number) => {
    const depth = Math.max(world.water[i], 0);
    const bed = voxelH(world.height[i]) + (world.solid[i] - world.height[i]);
    return { lvl: voxelLevel(world.height[i], world.solid[i], world.water[i]), bed, depth };
  };

  it('素の水面標高では、丸め上がったブロックに水が埋もれるセルがある', () => {
    let buried = 0;
    let wet = 0;
    for (let i = 0; i < n; i++) {
      if (world.water[i] <= 0.006) continue;
      wet++;
      if (world.solid[i] + world.water[i] < voxelH(world.height[i])) buried++;
    }
    expect(wet).toBeGreaterThan(100);
    expect(buried).toBeGreaterThan(0);
  });

  it('voxelLevel を通すと、水面は必ずブロック上面より上に出る', () => {
    for (let i = 0; i < n; i++) {
      if (world.water[i] <= 0.006) continue;
      expect(cell(i).lvl).toBeGreaterThan(voxelH(world.height[i]));
    }
  });

  it('水際に垂直な壁が立ち、水中どうしの境界では潰れる', () => {
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
          const a = cell(i);
          const b = cell(ny * t.width + nx);
          const top = Math.max(a.lvl, b.lvl);
          const bot = Math.min(top, Math.max(Math.max(a.bed, b.bed), Math.min(a.lvl, b.lvl)));
          const depth = a.lvl >= b.lvl ? a.depth : b.depth;
          if (depth < 0.006) continue;
          if (top - bot > 1e-4) walls++;
          // 十分に水没した2セルのあいだには板を立てない (湖の中に壁が見えてしまう)
          else if (a.depth > 0.2 && b.depth > 0.2) insideBody++;
        }
      }
    }
    expect(walls).toBeGreaterThan(0);
    expect(insideBody).toBeGreaterThan(0);
  });
});
