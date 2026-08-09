/**
 * 植生と露岩。
 *
 * 「どこに木が生えるか」は地形から決める: 急すぎる崖と河床と雪線より上には
 * 生えず、標高帯と斜面の向きで針葉樹 / 広葉樹が入れ替わる。森の疎密は
 * 低周波ノイズで決めているので、山肌に自然な森のまだらができる。
 *
 * 候補は起動時に一度だけ作り、地形が変わったときはその候補を「今の標高・
 * 建造物」で絞り直すだけにしている (掘削のたびに全部撒き直すと重い)。
 */
import * as THREE from 'three';
import { mergeParts } from './geo';
import { CELL } from '../../config';
import { RNG, clamp, hash01 } from '../../core/rng';
import type { World } from '../../world/world';

interface Candidate {
  cx: number;
  cy: number;
  x: number;
  z: number;
  scale: number;
  rot: number;
  /** 0 = 針葉樹, 1 = 広葉樹 */
  broad: number;
  tint: number;
}

function conifer(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.16, 0.28, 2.2, 5);
  trunk.translate(0, 1.1, 0);
  const c1 = new THREE.ConeGeometry(1.9, 4.2, 7);
  c1.translate(0, 3.8, 0);
  const c2 = new THREE.ConeGeometry(1.35, 3.2, 7);
  c2.translate(0, 6.0, 0);
  return mergeParts([trunk, c1, c2]);
}

function broadleaf(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.2, 0.34, 2.6, 5);
  trunk.translate(0, 1.3, 0);
  const crown = new THREE.IcosahedronGeometry(2.5, 0);
  crown.scale(1.0, 0.82, 1.0);
  crown.translate(0, 4.2, 0);
  const crown2 = new THREE.IcosahedronGeometry(1.7, 0);
  crown2.translate(1.3, 3.1, 0.7);
  return mergeParts([trunk, crown, crown2]);
}

function rock(): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(1.0, 0);
  g.scale(1.4, 0.8, 1.1);
  g.translate(0, 0.35, 0);
  return g;
}

export class PropLayer {
  readonly group = new THREE.Group();
  private conifers: THREE.InstancedMesh;
  private broadleaves: THREE.InstancedMesh;
  private rocks: THREE.InstancedMesh;
  private trees: Candidate[] = [];
  private stones: Candidate[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  private version = -1;
  private vscale = 1;
  private materials: THREE.Material[] = [];

  constructor(
    private world: World,
    seed: number,
    density = 1,
  ) {
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b857c, roughness: 0.95, flatShading: true });
    this.materials = [leafMat, rockMat];

    this.scatter(seed, density);

    this.conifers = this.makeMesh(conifer(), leafMat, this.trees.length);
    this.broadleaves = this.makeMesh(broadleaf(), leafMat, this.trees.length);
    this.rocks = this.makeMesh(rock(), rockMat, this.stones.length);
  }

  private makeMesh(geo: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, capacity));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3).fill(1), 3);
    this.group.add(mesh);
    return mesh;
  }

  /** 候補地点を撒く (地形が変わっても位置は変わらない) */
  private scatter(seed: number, density: number): void {
    const w = this.world;
    const rng = new RNG(seed ^ 0x5eed1e);
    const perCell = 1.15 * density;
    for (let cy = 1; cy < w.h - 1; cy++) {
      for (let cx = 1; cx < w.w - 1; cx++) {
        const i = cy * w.w + cx;
        const h = w.natural[i];
        if (h < 1.4) continue;
        if (w.riverMask[i]) continue;
        const slope = w.slope(cx, cy);
        if (slope > 5.2) continue;

        // 森のまだら (低周波ノイズ)
        const patch =
          hash01(Math.floor(cx / 9), Math.floor(cy / 9), 3) * 0.55 +
          hash01(Math.floor(cx / 24), Math.floor(cy / 24), 7) * 0.45;
        // 低地は田畑になるので疎、山腹は密、稜線と雪線付近は疎
        const band = clamp((h - 2) / 14, 0, 1) * (1 - clamp((h - w.maxHeight * 0.62) / (w.maxHeight * 0.3), 0, 1));
        const p = perCell * band * clamp(patch * 1.9 - 0.35, 0, 1) * (1 - clamp(slope / 6, 0, 0.8));
        if (rng.next() > p) continue;

        this.trees.push({
          cx,
          cy,
          x: (cx + rng.range(0.12, 0.88)) * CELL,
          z: (cy + rng.range(0.12, 0.88)) * CELL,
          scale: rng.range(0.75, 1.55) * (h > 60 ? 0.82 : 1),
          rot: rng.range(0, Math.PI * 2),
          broad: h < 34 && slope < 2.2 ? (rng.bool(0.72) ? 1 : 0) : rng.bool(0.22) ? 1 : 0,
          tint: rng.next(),
        });

        if (rng.next() < 0.012 && slope > 1.6) {
          this.stones.push({
            cx,
            cy,
            x: (cx + rng.range(0.2, 0.8)) * CELL,
            z: (cy + rng.range(0.2, 0.8)) * CELL,
            scale: rng.range(0.6, 2.6),
            rot: rng.range(0, Math.PI * 2),
            broad: 0,
            tint: rng.next(),
          });
        }
      }
    }
    // 岩は崖地にも足す
    for (let cy = 1; cy < w.h - 1; cy++) {
      for (let cx = 1; cx < w.w - 1; cx++) {
        if (w.slope(cx, cy) < 5.2) continue;
        if (rng.next() > 0.05) continue;
        this.stones.push({
          cx,
          cy,
          x: (cx + rng.range(0.2, 0.8)) * CELL,
          z: (cy + rng.range(0.2, 0.8)) * CELL,
          scale: rng.range(0.8, 3.4),
          rot: rng.range(0, Math.PI * 2),
          broad: 0,
          tint: rng.next(),
        });
      }
    }
  }

  /** 地形の高さを双一次補間で拾う (セル中心が格子点) */
  private heightAt(x: number, z: number): number {
    const w = this.world;
    const fx = clamp(x / CELL - 0.5, 0, w.w - 1.001);
    const fz = clamp(z / CELL - 0.5, 0, w.h - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * w.w + ix;
    const h00 = w.height[i];
    const h10 = w.height[i + 1];
    const h01 = w.height[i + w.w];
    const h11 = w.height[i + w.w + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** 地形か建造物が変わったときだけ並べ直す (木の高さは実寸のまま、位置だけ強調地形に載せる) */
  update(force = false, vscale = 1): void {
    if (!force && this.version === this.world.terrainVersion && this.vscale === vscale) return;
    this.version = this.world.terrainVersion;
    this.vscale = vscale;
    const w = this.world;

    let nc = 0;
    let nb = 0;
    for (const t of this.trees) {
      const i = t.cy * w.w + t.cx;
      if (w.structure[i] >= 0) continue;
      const h = this.heightAt(t.x, t.z);
      if (h < 1.0) continue;
      if (w.water[i] > 0.12) continue; // 水没した森は消える
      this.p.set(t.x, h * vscale - 0.3, t.z);
      this.q.setFromAxisAngle(UP, t.rot);
      this.s.setScalar(t.scale);
      this.m.compose(this.p, this.q, this.s);
      const mesh = t.broad ? this.broadleaves : this.conifers;
      const n = t.broad ? nb++ : nc++;
      mesh.setMatrixAt(n, this.m);
      // 標高が上がるほど暗く青みがかった葉に
      const cold = clamp((h - 30) / 70, 0, 1);
      this.col.setHSL(0.28 - t.tint * 0.05 + cold * 0.02, 0.34 + t.tint * 0.2 - cold * 0.12, 0.19 + t.tint * 0.13 - cold * 0.05);
      mesh.setColorAt(n, this.col.convertSRGBToLinear());
    }
    this.conifers.count = nc;
    this.broadleaves.count = nb;

    let nr = 0;
    for (const s of this.stones) {
      const i = s.cy * w.w + s.cx;
      if (w.structure[i] >= 0) continue;
      const h = this.heightAt(s.x, s.z);
      this.p.set(s.x, h * vscale - 0.25, s.z);
      this.q.setFromAxisAngle(UP, s.rot);
      this.s.set(s.scale, s.scale * 0.8, s.scale);
      this.m.compose(this.p, this.q, this.s);
      this.rocks.setMatrixAt(nr, this.m);
      this.col.setHSL(0.09, 0.06, 0.34 + s.tint * 0.2);
      this.rocks.setColorAt(nr, this.col.convertSRGBToLinear());
      nr++;
    }
    this.rocks.count = nr;

    for (const mesh of [this.conifers, this.broadleaves, this.rocks]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    for (const mesh of [this.conifers, this.broadleaves, this.rocks]) {
      mesh.dispose();
      mesh.geometry.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
