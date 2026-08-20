/**
 * ボクセル (ブロック) 表示のジオメトリ。
 *
 * 地形も水面もまったく同じトポロジを使うので、ここで1度だけ組む。
 *
 * 形は「セルごとの上面 + セル境界ごとの垂直な面」。垂直面は**境界1つにつき1枚**
 * しか置かない (どちら側のセルが高いかは頂点シェーダで決める) ので、
 * セルごとに4枚張るより 4 割ほど三角形が少ない。
 *
 *   上面     : MAP * MAP           枚
 *   X 境界面 : (MAP + 1) * MAP     枚  ← 両端はマップ外との境界 = 外周のスカート
 *   Z 境界面 : MAP * (MAP + 1)     枚
 *
 * 頂点の Y は毎フレーム頂点シェーダが標高テクスチャから決めるので、
 * 地形を改変してもこのジオメトリを組み直す必要はない。
 *
 * 属性:
 *   position — x, z はワールド座標 (静的)。**y は役割フラグ**で、
 *              0 = 上面 / 垂直面の上辺、1 = 垂直面の下辺。
 *   aCells   — xy = 隣り合うセル A、zw = セル B。上面では A == B。
 *              マップ外を指すこともある (外周のスカート) ので、
 *              シェーダ側で範囲外を判定すること。
 */
import * as THREE from 'three';
import { CELL, MAP } from '../../config';

/** 上面 + 境界面の総枚数 */
export const BLOCK_QUADS = MAP * MAP + (MAP + 1) * MAP + MAP * (MAP + 1);
export const BLOCK_VERTS = BLOCK_QUADS * 4;
export const BLOCK_INDICES = BLOCK_QUADS * 6;

export function buildBlockGeometry(): THREE.BufferGeometry {
  const pos = new Float32Array(BLOCK_VERTS * 3);
  const cells = new Float32Array(BLOCK_VERTS * 4);
  const idx = new Uint32Array(BLOCK_INDICES);

  let v = 0; // 頂点番号
  let o = 0; // インデックス書き込み位置

  /** 四角形を1枚。corners は (x, roleY, z) を4つ、時計回り/反時計回りは問わない */
  const quad = (
    corners: [number, number, number][],
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): void => {
    const base = v;
    for (const [x, ry, z] of corners) {
      pos[v * 3] = x;
      pos[v * 3 + 1] = ry;
      pos[v * 3 + 2] = z;
      cells[v * 4] = ax;
      cells[v * 4 + 1] = ay;
      cells[v * 4 + 2] = bx;
      cells[v * 4 + 3] = by;
      v++;
    }
    idx[o++] = base;
    idx[o++] = base + 1;
    idx[o++] = base + 2;
    idx[o++] = base;
    idx[o++] = base + 2;
    idx[o++] = base + 3;
  };

  // --- 上面 ---
  for (let j = 0; j < MAP; j++) {
    for (let i = 0; i < MAP; i++) {
      const x0 = i * CELL;
      const x1 = x0 + CELL;
      const z0 = j * CELL;
      const z1 = z0 + CELL;
      quad(
        [
          [x0, 0, z0],
          [x0, 0, z1],
          [x1, 0, z1],
          [x1, 0, z0],
        ],
        i,
        j,
        i,
        j,
      );
    }
  }

  // --- X 境界面 (x = i*CELL の平面。セル (i-1, j) と (i, j) のあいだ) ---
  for (let j = 0; j < MAP; j++) {
    for (let i = 0; i <= MAP; i++) {
      const x = i * CELL;
      const z0 = j * CELL;
      const z1 = z0 + CELL;
      quad(
        [
          [x, 0, z0],
          [x, 0, z1],
          [x, 1, z1],
          [x, 1, z0],
        ],
        i - 1,
        j,
        i,
        j,
      );
    }
  }

  // --- Z 境界面 (z = j*CELL の平面。セル (i, j-1) と (i, j) のあいだ) ---
  for (let j = 0; j <= MAP; j++) {
    for (let i = 0; i < MAP; i++) {
      const x0 = i * CELL;
      const x1 = x0 + CELL;
      const z = j * CELL;
      quad(
        [
          [x0, 0, z],
          [x1, 0, z],
          [x1, 1, z],
          [x0, 1, z],
        ],
        i,
        j - 1,
        i,
        j,
      );
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCells', new THREE.BufferAttribute(cells, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  // Y は頂点シェーダで決めるので、境界球は十分大きく固定する (カリングで消えないように)
  const span = MAP * CELL;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(span / 2, 0, span / 2), span);
  return g;
}

/**
 * 頂点シェーダの共通部分。
 *
 * `edgeH` がマップ外を `uVoxelFloor` まで落とすので、外周の境界面が
 * そのままジオラマの側面 (スカート) になる。
 */
export const BLOCK_VERTEX_GLSL = /* glsl */ `
attribute vec4 aCells;

/**
 * セルの地面高さ。マップ外はジオラマの底。
 *
 * **必ず fieldTexel (最近傍) で読む。** sampleH のバイリニアで読むと
 * セル内が平らにならず、柱の天面が波打ってしまう。
 */
float edgeH(sampler2D tex, vec2 c) {
  if (c.x < -0.5 || c.y < -0.5 || c.x > uMapSize.x - 0.5 || c.y > uMapSize.y - 0.5) {
    return uVoxelFloor;
  }
  return fieldTexel(tex, c).r;
}
`;
