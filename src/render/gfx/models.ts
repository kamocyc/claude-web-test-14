/**
 * 施設の 3D モデル。外部アセットを使わず、箱・円柱・角錐を組み合わせて作る。
 *
 * ローカル座標は「セルの中心が原点、Y=0 が地面、単位はメートル」。
 * セルの一辺は 12m なので、家は 7×8m、堤防はセル幅いっぱい、という寸法感。
 */
import * as THREE from 'three';
import { mergeParts } from './geo';
import { CELL } from '../../config';
import type { BuildingKind } from '../../sim/buildings';

/** インスタンスごとに動かすパート */
export type PartDynamic = 'none' | 'growth' | 'gate' | 'wall';

/** インスタンスごとの色をどう決めるか */
export type TintRole = 'none' | 'main' | 'roof';

export interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** インスタンスごとの色 (壁の色違い・屋根の色違い・作物の生育) */
  tint: TintRole;
  dynamic: PartDynamic;
  /** 影を落とすか */
  castShadow: boolean;
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

function cyl(rTop: number, rBot: number, h: number, seg: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  g.translate(x, y + h / 2, z);
  return g;
}

function pyramid(r: number, h: number, seg: number, x = 0, y = 0, z = 0, rot = Math.PI / 4): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.rotateY(rot);
  g.translate(x, y + h / 2, z);
  return g;
}

/** 円柱を任意の軸に沿わせる (中心を x,y,z に置く) */
function tube(r: number, len: number, axis: 'x' | 'y' | 'z', x: number, y: number, z: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** 台形断面の土手 (X 方向に走る) */
function embankment(len: number, h: number, baseW: number, topW: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-baseW / 2, 0);
  shape.lineTo(baseW / 2, 0);
  shape.lineTo(topW / 2, h);
  shape.lineTo(-topW / 2, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false, steps: 1 });
  // 断面は XY 平面にできるので、押し出し方向 (Z) が走行方向 (X) になるよう回す
  g.rotateY(Math.PI / 2);
  g.translate(-len / 2, 0, 0);
  g.clearGroups();
  g.computeVertexNormals();
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeParts(list);
}

function mat(color: number, opt: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opt });
}

export interface Palette {
  concrete: THREE.MeshStandardMaterial;
  concreteDark: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  earth: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  wallTint: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  window: THREE.MeshStandardMaterial;
  crop: THREE.MeshStandardMaterial;
  paddyWater: THREE.MeshStandardMaterial;
  soil: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  pipe: THREE.MeshStandardMaterial;
}

export function createPalette(): Palette {
  return {
    concrete: mat(0xc2c0ba, { roughness: 0.9 }),
    concreteDark: mat(0x8d8b86, { roughness: 0.95 }),
    steel: mat(0x8b939c, { roughness: 0.38, metalness: 0.82 }),
    earth: mat(0x8b7551, { roughness: 1 }),
    grass: mat(0x6f8a47, { roughness: 1 }),
    wallTint: mat(0xffffff, { roughness: 0.75 }),
    roof: mat(0xffffff, { roughness: 0.62 }),
    window: mat(0x223040, { roughness: 0.2, metalness: 0.1, emissive: 0xffc36b, emissiveIntensity: 0 }),
    crop: mat(0xffffff, { roughness: 0.95 }),
    paddyWater: mat(0x4d7f86, { roughness: 0.18, metalness: 0.1 }),
    soil: mat(0x6b563c, { roughness: 1 }),
    wood: mat(0x8a6a45, { roughness: 0.9 }),
    pipe: mat(0x9c9a92, { roughness: 0.8, metalness: 0.15 }),
  };
}

const P = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  opt: Partial<Pick<ModelPart, 'tint' | 'dynamic' | 'castShadow'>> = {},
): ModelPart => ({
  geometry,
  material,
  tint: opt.tint ?? 'none',
  dynamic: opt.dynamic ?? 'none',
  castShadow: opt.castShadow ?? true,
});

export function createModels(p: Palette): Record<BuildingKind, ModelPart[]> {
  const C = CELL;

  /* -------------------- 住宅 -------------------- */
  const house = [
    // 基礎 (斜面でも浮かないよう地面へ埋める)
    P(box(8.2, 3.0, 9.0, 0, -2.7, 0), p.concreteDark, { castShadow: false }),
    P(merge([box(7.0, 4.2, 8.0), box(3.2, 2.4, 3.0, 4.4, 0, 2.0)]), p.wallTint, { tint: 'main' }),
    P(merge([pyramid(6.2, 2.7, 4, 0, 4.2), box(3.0, 0.35, 3.6, 4.4, 2.4, 2.0)]), p.roof, { tint: 'roof' }),
    P(merge([box(4.2, 1.3, 0.25, 0, 1.5, 4.02), box(0.25, 1.3, 3.0, 3.52, 1.5, 0)]), p.window, { castShadow: false }),
  ];

  /* -------------------- 農地 -------------------- */
  const farm = [
    P(box(C - 0.6, 0.5, C - 0.6, 0, -0.42), p.soil, { castShadow: false }),
    P(
      merge([0, 1, 2, 3, 4].map((i) => box(C - 1.6, 1.0, 1.1, 0, 0, -4.4 + i * 2.2))),
      p.crop,
      { tint: 'main', dynamic: 'growth', castShadow: false },
    ),
  ];

  const paddy = [
    P(box(C - 0.4, 0.55, C - 0.4, 0, -0.45), p.soil, { castShadow: false }),
    P(box(C - 1.4, 0.22, C - 1.4, 0, 0.02), p.paddyWater, { castShadow: false }),
    // 畦
    P(
      merge([
        box(C - 0.4, 0.42, 0.7, 0, 0, -(C - 0.4) / 2 + 0.35),
        box(C - 0.4, 0.42, 0.7, 0, 0, (C - 0.4) / 2 - 0.35),
        box(0.7, 0.42, C - 1.8, -(C - 0.4) / 2 + 0.35, 0, 0),
        box(0.7, 0.42, C - 1.8, (C - 0.4) / 2 - 0.35, 0, 0),
      ]),
      p.earth,
      { castShadow: false },
    ),
    P(box(C - 2.2, 1.1, C - 2.2, 0, 0.16), p.crop, { tint: 'main', dynamic: 'growth', castShadow: false }),
  ];

  /* -------------------- 治水 -------------------- */
  // 堤防: セル幅いっぱいの台形。上面は草、法面は土。
  const levee = [
    P(embankment(C, 5, 11.0, 4.4), p.earth, { dynamic: 'wall' }),
    P(box(4.2, 0.35, C, 0, 4.85, 0), p.grass, { dynamic: 'wall', castShadow: false }),
  ];

  // ダム: 両側の堤体 + 中央のゲート (開けると持ち上がる)
  const dam = [
    P(
      merge([
        box(3.4, 16, 8.0, -4.3, 0, 0),
        box(3.4, 16, 8.0, 4.3, 0, 0),
        box(C, 1.4, 3.0, 0, 14.6, -2.6), // 天端の道路
        box(C, 2.2, 1.0, 0, 0, 3.6), // 下流側の水叩き
      ]),
      p.concrete,
    ),
    P(merge([box(C, 0.25, 0.25, 0, 16.0, -3.9), box(C, 0.25, 0.25, 0, 16.0, -1.3)]), p.steel, { castShadow: false }),
    P(box(5.6, 13.5, 1.1, 0, 0.4, -1.6), p.steel, { dynamic: 'gate' }),
  ];

  const floodgate = [
    P(
      merge([box(2.6, 7, 5.0, -4.7, 0, 0), box(2.6, 7, 5.0, 4.7, 0, 0), box(C, 1.1, 2.2, 0, 7.0, 0)]),
      p.concrete,
    ),
    P(box(6.6, 6.4, 0.9, 0, 0.2, 0), p.steel, { dynamic: 'gate' }),
  ];

  const drainpump = [
    P(box(C - 1.0, 1.0, C - 1.0, 0, -0.9), p.concreteDark, { castShadow: false }),
    P(merge([box(8.0, 5.2, 6.0, -1.0, 0.1, 0), box(3.0, 3.0, 3.0, 4.2, 0.1, -2.0)]), p.concrete),
    P(merge([tube(1.0, 6.0, 'z', 3.4, 1.6, 2.0, 12), cyl(0.55, 0.55, 3.2, 10, -1.0, 5.3, 0)]), p.pipe),
    P(box(8.4, 0.4, 6.4, -1.0, 5.3, 0), p.steel, { castShadow: false }),
  ];

  /* -------------------- 上水道 -------------------- */
  const intake = [
    P(box(C - 1.0, 1.6, C - 1.0, 0, -1.4), p.concreteDark, { castShadow: false }),
    P(merge([cyl(2.2, 2.6, 5.4, 14, -2.0, 0.2), box(4.6, 3.0, 4.2, 3.2, 0.2, 0)]), p.concrete),
    P(merge([tube(0.7, 6.0, 'x', 0.6, 2.2, 0), cyl(1.1, 1.1, 0.6, 12, -2.0, 5.6)]), p.pipe),
  ];

  const treatment = [
    P(box(C - 0.6, 1.2, C - 0.6, 0, -1.0), p.concreteDark, { castShadow: false }),
    P(
      merge([
        cyl(3.1, 3.1, 2.6, 20, -2.4, 0.2, -2.4),
        cyl(2.3, 2.3, 2.6, 18, 3.0, 0.2, 3.0),
        box(5.0, 3.6, 4.0, 2.6, 0.2, -3.0),
      ]),
      p.concrete,
    ),
    P(
      merge([
        cyl(2.75, 2.75, 0.25, 20, -2.4, 2.6, -2.4),
        cyl(2.0, 2.0, 0.25, 18, 3.0, 2.6, 3.0),
        box(5.2, 0.3, 4.2, 2.6, 3.8, -3.0),
      ]),
      p.paddyWater,
      { castShadow: false },
    ),
    P(merge([tube(0.4, 6.0, 'z', -2.4, 1.9, 0.6, 8), tube(0.35, 4.2, 'x', 0.4, 2.4, -3.0, 8)]), p.pipe, {
      castShadow: false,
    }),
  ];

  const tower = [
    P(box(6.4, 1.0, 6.4, 0, -0.9), p.concreteDark, { castShadow: false }),
    P(
      merge([
        cyl(0.42, 0.5, 9.0, 8, -2.4, 0, -2.4),
        cyl(0.42, 0.5, 9.0, 8, 2.4, 0, -2.4),
        cyl(0.42, 0.5, 9.0, 8, -2.4, 0, 2.4),
        cyl(0.42, 0.5, 9.0, 8, 2.4, 0, 2.4),
        box(5.6, 0.28, 0.5, 0, 4.4, -2.4),
        box(5.6, 0.28, 0.5, 0, 4.4, 2.4),
      ]),
      p.steel,
    ),
    P(merge([cyl(3.4, 3.0, 4.2, 18, 0, 9.0), cyl(2.0, 3.4, 1.4, 18, 0, 13.2)]), p.wallTint, { tint: 'main' }),
    P(cyl(3.55, 3.55, 0.3, 18, 0, 8.7), p.steel, { castShadow: false }),
  ];

  const pipeModel = [
    // セル幅いっぱいに通して、隣とつながって見えるようにする
    P(merge([box(C, 0.34, 3.2, 0, -0.16), cyl(0.75, 0.75, 0.22, 10, 0, 0.16)]), p.pipe, { castShadow: false }),
  ];

  const well = [
    P(cyl(1.7, 1.9, 1.5, 14, 0, -0.3), p.concrete),
    P(
      merge([cyl(0.16, 0.16, 2.6, 6, -1.5, 1.2), cyl(0.16, 0.16, 2.6, 6, 1.5, 1.2), pyramid(2.6, 1.1, 4, 0, 3.8)]),
      p.wood,
    ),
  ];

  return {
    house,
    farm,
    paddy,
    levee,
    dam,
    floodgate,
    drainpump,
    intake,
    treatment,
    tower,
    pipe: pipeModel,
    well,
  };
}
