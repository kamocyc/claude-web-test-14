/**
 * 施設の描画。種類 × パートごとに InstancedMesh を1つ持ち、毎フレーム行列と色を
 * 書き込む (数百〜数千棟なので、まとめて更新しても十分速い)。
 *
 * 生育度・ゲート開度・損傷は「見た目に出る」ようにしてある:
 * - 作物は生育度で背が伸びて色が緑 → 黄金色に変わる
 * - ゲートは開けると持ち上がり、水が抜ける隙間が見える
 * - 損傷した堤防・ダムは実際に低くなる (シミュレーション側の有効天端と一致)
 */
import * as THREE from 'three';
import { CELL, voxelH } from '../../config';
import { clamp } from '../../core/rng';
import { BUILDINGS, type Building, type BuildingKind } from '../../sim/buildings';
import type { World } from '../../world/world';
import { createModels, createPalette, type ModelPart, type Palette } from './models';

interface Layer {
  kind: BuildingKind;
  part: ModelPart;
  mesh: THREE.InstancedMesh;
  capacity: number;
}

/** ゲートが開ききったときに持ち上がる高さ (m) */
const GATE_LIFT: Partial<Record<BuildingKind, number>> = { dam: 9.5, floodgate: 5.2 };

const LINEAR_KINDS = new Set<BuildingKind>(['levee', 'dam', 'floodgate']);

const UP = new THREE.Vector3(0, 1, 0);

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 2654435761) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967295;
}

export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly palette: Palette;
  private models: Record<BuildingKind, ModelPart[]>;
  private layers: Layer[] = [];
  private byKind = new Map<BuildingKind, Building[]>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private col = new THREE.Color();

  constructor() {
    this.palette = createPalette();
    this.models = createModels(this.palette);
    for (const kind of Object.keys(this.models) as BuildingKind[]) {
      this.byKind.set(kind, []);
      for (const part of this.models[kind]) {
        this.layers.push(this.makeLayer(kind, part, 32));
      }
    }
  }

  private makeLayer(kind: BuildingKind, part: ModelPart, capacity: number): Layer {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
    mesh.castShadow = part.castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.name = `${kind}`;
    if (part.tint !== 'none') {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    }
    this.group.add(mesh);
    return { kind, part, mesh, capacity };
  }

  private grow(layer: Layer, need: number): void {
    const cap = Math.max(32, 1 << Math.ceil(Math.log2(need + 1)));
    this.group.remove(layer.mesh);
    layer.mesh.dispose();
    const next = this.makeLayer(layer.kind, layer.part, cap);
    layer.mesh = next.mesh;
    layer.capacity = cap;
  }

  /** 線状の構造物 (堤防・ダム・水道管) の向きを隣接から決める */
  private yawFor(world: World, b: Building): number {
    const linear = LINEAR_KINDS.has(b.kind);
    if (!linear && b.kind !== 'pipe') return (Math.floor(hash01(b.id) * 4) * Math.PI) / 2 + (hash01(b.id * 7) - 0.5) * 0.22;
    const match = (x: number, y: number): boolean => {
      const n = world.buildingAt(x, y);
      if (!n) return false;
      return linear ? LINEAR_KINDS.has(n.kind) : n.kind === 'pipe' || BUILDINGS[n.kind].network;
    };
    const horiz = match(b.x - 1, b.y) || match(b.x + 1, b.y);
    const vert = match(b.x, b.y - 1) || match(b.x, b.y + 1);
    if (vert && !horiz) return Math.PI / 2;
    return 0;
  }

  private tintFor(b: Building, kind: BuildingKind, role: 'main' | 'roof', out: THREE.Color): void {
    if (role === 'roof') {
      // 瓦 (いぶし銀) / トタン (青・赤茶) を混ぜる
      const r = hash01(b.id * 977);
      if (r < 0.5) out.setHSL(0.58, 0.08 + r * 0.1, 0.24 + r * 0.1);
      else if (r < 0.78) out.setHSL(0.05, 0.28, 0.26 + (r - 0.5) * 0.2);
      else out.setHSL(0.33, 0.12, 0.22 + (r - 0.78) * 0.2);
      if (b.hp < 0.98) out.multiplyScalar(0.55 + 0.45 * b.hp);
      out.convertSRGBToLinear();
      return;
    }
    switch (kind) {
      case 'house': {
        const h = hash01(b.id * 13);
        // 白漆喰・土壁・板張りが混ざった集落の色
        out.setHSL(0.07 + h * 0.05, 0.05 + h * 0.28, 0.42 + hash01(b.id * 5) * 0.38);
        break;
      }
      case 'tower':
        out.setHSL(0.55, 0.06, 0.82);
        break;
      case 'farm':
      case 'paddy': {
        const g = clamp(b.growth, 0, 1);
        // 芽出し (青緑) → 生育 (濃緑) → 登熟 (黄金)
        const hue = kind === 'paddy' ? 0.32 - g * 0.19 : 0.28 - g * 0.16;
        out.setHSL(hue, 0.45 + g * 0.24, 0.24 + g * 0.24);
        break;
      }
      default:
        out.setRGB(1, 1, 1);
        break;
    }
    if (b.hp < 0.98) out.multiplyScalar(0.55 + 0.45 * b.hp);
    out.convertSRGBToLinear();
  }

  /**
   * 毎フレームの更新。
   * vscale は「高さ方向の強調率」。建物の高さそのものは実寸のままにし、
   * 位置だけ強調地形に載せる — でないと家が塔のように伸びてしまう。
   * ただし堤防・ダム・水門は「水を止める高さ」がそのまま見た目になるべきなので、
   * 地形・水面と同じ倍率で伸ばす。
   */
  update(world: World, night: number, vscale: number): void {
    for (const list of this.byKind.values()) list.length = 0;
    for (const b of world.buildings.values()) this.byKind.get(b.kind)?.push(b);

    // 夜は窓が灯る
    this.palette.window.emissiveIntensity = night * 1.9;
    this.palette.window.color.setRGB(0.13, 0.16, 0.2);

    for (const layer of this.layers) {
      const list = this.byKind.get(layer.kind) ?? [];
      if (list.length > layer.capacity) this.grow(layer, list.length);
      const mesh = layer.mesh;
      const part = layer.part;
      for (let n = 0; n < list.length; n++) {
        const b = list[n];
        const i = world.idx(b.x, b.y);
        // ブロック上面にぴったり載せる (ボクセル表示 OFF なら素通し)
        const ground = voxelH(world.height[i]);
        const yaw = this.yawFor(world, b);

        const wallKind = BUILDINGS[b.kind].wallHeight > 0;
        const vs = wallKind ? vscale : 1;
        this.pos.set((b.x + 0.5) * CELL, ground * vscale, (b.y + 0.5) * CELL);
        this.scl.set(1, vs, 1);

        switch (part.dynamic) {
          case 'growth': {
            const g = 0.12 + 0.88 * clamp(b.growth, 0, 1);
            this.scl.set(0.94, g * vs, 0.94);
            break;
          }
          case 'gate':
            this.pos.y += (GATE_LIFT[b.kind] ?? 0) * clamp(b.gate, 0, 1) * vs;
            break;
          case 'wall':
            // 損傷すると実際に天端が下がる (World.effectiveWall と同じ係数)
            this.scl.y = (0.35 + 0.65 * b.hp) * vs;
            break;
          default:
            break;
        }
        if (layer.kind === 'house') {
          const s = 0.86 + hash01(b.id * 3) * 0.3;
          this.scl.multiplyScalar(s);
          this.scl.y *= 0.92 + hash01(b.id * 11) * 0.25;
        }

        this.q.setFromAxisAngle(UP, yaw);
        this.m.compose(this.pos, this.q, this.scl);
        mesh.setMatrixAt(n, this.m);
        if (part.tint !== 'none') {
          this.tintFor(b, layer.kind, part.tint, this.col);
          mesh.setColorAt(n, this.col);
        }
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (part.tint !== 'none' && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const l of this.layers) {
      l.mesh.dispose();
      l.part.geometry.dispose();
    }
    for (const m of Object.values(this.palette)) m.dispose();
  }
}
