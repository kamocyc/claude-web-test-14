/**
 * 建設カーソル・選択枠・源流マーカー・流線。
 * どれも地形の起伏に沿わせたいので、毎フレーム頂点を作り直している
 * (数十〜数千頂点なので負荷は無視できる)。
 */
import * as THREE from 'three';
import { CELL, VOXEL } from '../../config';
import type { Building } from '../../sim/buildings';
import type { World } from '../../world/world';

const MAX_FLOW = 6000;

export class Markers {
  readonly group = new THREE.Group();
  private cursorMesh: THREE.Mesh;
  private cursorGeo: THREE.BufferGeometry;
  private cursorPos: Float32Array;
  private cursorCol: Float32Array;
  private outline: THREE.LineSegments;
  private outlineGeo: THREE.BufferGeometry;
  private outlinePos: Float32Array;
  private selection: THREE.LineSegments;
  private selectionGeo: THREE.BufferGeometry;
  private selectionPos: Float32Array;
  private flow: THREE.LineSegments;
  private flowGeo: THREE.BufferGeometry;
  private flowPos: Float32Array;
  private flowAlpha: Float32Array;
  private sources: THREE.InstancedMesh | null = null;

  /** 高さ方向の強調率 (地形シェーダと合わせる) */
  vscale = 1;

  constructor(private world: World) {
    const CAP = 64; // 同時に表示するカーソルセル数
    this.cursorPos = new Float32Array(CAP * 6 * 3);
    this.cursorCol = new Float32Array(CAP * 6 * 3);
    this.cursorGeo = new THREE.BufferGeometry();
    this.cursorGeo.setAttribute('position', new THREE.BufferAttribute(this.cursorPos, 3));
    this.cursorGeo.setAttribute('color', new THREE.BufferAttribute(this.cursorCol, 3));
    this.cursorMesh = new THREE.Mesh(
      this.cursorGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.cursorMesh.frustumCulled = false;
    this.cursorMesh.renderOrder = 30;
    this.group.add(this.cursorMesh);

    this.outlinePos = new Float32Array(CAP * 8 * 3);
    this.outlineGeo = new THREE.BufferGeometry();
    this.outlineGeo.setAttribute('position', new THREE.BufferAttribute(this.outlinePos, 3));
    this.outline = new THREE.LineSegments(
      this.outlineGeo,
      new THREE.LineBasicMaterial({ color: 0xd8ffe6, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.outline.frustumCulled = false;
    this.outline.renderOrder = 31;
    this.group.add(this.outline);

    this.selectionPos = new Float32Array(24 * 3);
    this.selectionGeo = new THREE.BufferGeometry();
    this.selectionGeo.setAttribute('position', new THREE.BufferAttribute(this.selectionPos, 3));
    this.selection = new THREE.LineSegments(
      this.selectionGeo,
      new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.selection.frustumCulled = false;
    this.selection.renderOrder = 40;
    this.selection.visible = false;
    this.group.add(this.selection);

    this.flowPos = new Float32Array(MAX_FLOW * 2 * 3);
    this.flowAlpha = new Float32Array(MAX_FLOW * 2);
    this.flowGeo = new THREE.BufferGeometry();
    this.flowGeo.setAttribute('position', new THREE.BufferAttribute(this.flowPos, 3));
    this.flowGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.flowAlpha, 1));
    this.flow = new THREE.LineSegments(
      this.flowGeo,
      new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: /* glsl */ `
          attribute float aAlpha;
          varying float vA;
          void main() {
            vA = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() { gl_FragColor = vec4(0.88, 0.96, 1.0, vA); }
        `,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.flow.frustumCulled = false;
    this.flow.renderOrder = 25;
    this.group.add(this.flow);

    this.buildSources();
  }

  private buildSources(): void {
    const list = this.world.sources;
    if (list.length === 0) return;
    const geo = new THREE.TorusGeometry(4.2, 0.55, 6, 18);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x9fe4ff, transparent: true, opacity: 0.55, depthWrite: false }),
      list.length,
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 26;
    this.sources = mesh;
    this.group.add(mesh);
  }

  private cellHeight(x: number, y: number): number {
    const w = this.world;
    const cx = Math.min(Math.max(x, 0), w.w - 1);
    const cy = Math.min(Math.max(y, 0), w.h - 1);
    const i = cy * w.w + cx;
    return w.height[i] * this.vscale;
  }

  /** セル (x,y) の四隅の高さ (隣接セルの平均) */
  private corners(x: number, y: number, out: number[]): void {
    // ブロック表示では上面が平らなので、隣を混ぜるとカーソルが傾いて
    // ブロックにめり込む。そのセルの高さでまっすぐな四角にする。
    if (VOXEL.enabled) {
      const h0 = this.cellHeight(x, y);
      out[0] = h0;
      out[1] = h0;
      out[2] = h0;
      out[3] = h0;
      return;
    }
    const h = (a: number, b: number): number => this.cellHeight(a, b);
    out[0] = (h(x - 1, y - 1) + h(x, y - 1) + h(x - 1, y) + h(x, y)) * 0.25;
    out[1] = (h(x, y - 1) + h(x + 1, y - 1) + h(x, y) + h(x + 1, y)) * 0.25;
    out[2] = (h(x - 1, y) + h(x, y) + h(x - 1, y + 1) + h(x, y + 1)) * 0.25;
    out[3] = (h(x, y) + h(x + 1, y) + h(x, y + 1) + h(x + 1, y + 1)) * 0.25;
  }

  private c = [0, 0, 0, 0];

  updateCursor(cells: { x: number; y: number; ok: boolean }[] | null): void {
    const n = Math.min(cells?.length ?? 0, 64);
    if (!cells || n === 0) {
      this.cursorMesh.visible = false;
      this.outline.visible = false;
      return;
    }
    this.cursorMesh.visible = true;
    this.outline.visible = true;
    let vo = 0;
    let lo = 0;
    for (let k = 0; k < n; k++) {
      const c = cells[k];
      this.corners(c.x, c.y, this.c);
      const x0 = c.x * CELL;
      const x1 = (c.x + 1) * CELL;
      const z0 = c.y * CELL;
      const z1 = (c.y + 1) * CELL;
      const lift = 0.35;
      const p = [
        [x0, this.c[0] + lift, z0],
        [x1, this.c[1] + lift, z0],
        [x0, this.c[2] + lift, z1],
        [x1, this.c[3] + lift, z1],
      ];
      const tri = [0, 2, 1, 1, 2, 3];
      const col = c.ok ? [0.45, 1.0, 0.62] : [1.0, 0.38, 0.32];
      for (const t of tri) {
        this.cursorPos[vo] = p[t][0];
        this.cursorPos[vo + 1] = p[t][1];
        this.cursorPos[vo + 2] = p[t][2];
        this.cursorCol[vo] = col[0];
        this.cursorCol[vo + 1] = col[1];
        this.cursorCol[vo + 2] = col[2];
        vo += 3;
      }
      const edges = [
        [0, 1],
        [1, 3],
        [3, 2],
        [2, 0],
      ];
      for (const [a, b] of edges) {
        this.outlinePos[lo] = p[a][0];
        this.outlinePos[lo + 1] = p[a][1] + 0.1;
        this.outlinePos[lo + 2] = p[a][2];
        this.outlinePos[lo + 3] = p[b][0];
        this.outlinePos[lo + 4] = p[b][1] + 0.1;
        this.outlinePos[lo + 5] = p[b][2];
        lo += 6;
      }
    }
    this.cursorGeo.setDrawRange(0, n * 6);
    this.outlineGeo.setDrawRange(0, n * 8);
    this.cursorGeo.attributes.position.needsUpdate = true;
    this.cursorGeo.attributes.color.needsUpdate = true;
    this.outlineGeo.attributes.position.needsUpdate = true;
  }

  updateSelection(b: Building | null, time: number): void {
    if (!b) {
      this.selection.visible = false;
      return;
    }
    this.selection.visible = true;
    this.corners(b.x, b.y, this.c);
    const x0 = b.x * CELL;
    const x1 = (b.x + 1) * CELL;
    const z0 = b.y * CELL;
    const z1 = (b.y + 1) * CELL;
    const base = Math.max(this.c[0], this.c[1], this.c[2], this.c[3]) + 0.4;
    const top = base + 14 + Math.sin(time * 2.2) * 1.2;
    const p = [
      [x0, base, z0],
      [x1, base, z0],
      [x1, base, z1],
      [x0, base, z1],
    ];
    let o = 0;
    const push = (a: number[], b2: number[]): void => {
      this.selectionPos[o] = a[0];
      this.selectionPos[o + 1] = a[1];
      this.selectionPos[o + 2] = a[2];
      this.selectionPos[o + 3] = b2[0];
      this.selectionPos[o + 4] = b2[1];
      this.selectionPos[o + 5] = b2[2];
      o += 6;
    };
    for (let i = 0; i < 4; i++) push(p[i], p[(i + 1) % 4]);
    // 四隅から上へ伸びる指標
    for (let i = 0; i < 4; i++) push(p[i], [p[i][0], top, p[i][2]]);
    this.selectionGeo.setDrawRange(0, 16);
    this.selectionGeo.attributes.position.needsUpdate = true;
  }

  updateFlow(show: boolean, time: number, step: number): void {
    this.flow.visible = show;
    if (!show) return;
    const w = this.world;
    let o = 0;
    let a = 0;
    let count = 0;
    for (let y = 1; y < w.h - 1 && count < MAX_FLOW; y += step) {
      for (let x = 1; x < w.w - 1 && count < MAX_FLOW; x += step) {
        const i = y * w.w + x;
        if (w.water[i] < 0.14) continue;
        const vx = w.vx[i];
        const vy = w.vy[i];
        const sp = Math.hypot(vx, vy);
        if (sp < 0.15) continue;
        const phase = ((time * 0.5 + (x * 7 + y * 13) * 0.0917) % 1) - 0.5;
        const cx = (x + 0.5 + (vx / sp) * phase * step * 0.9) * CELL;
        const cz = (y + 0.5 + (vy / sp) * phase * step * 0.9) * CELL;
        const len = Math.min(0.9, 0.25 + sp * 0.2) * step * 0.5 * CELL;
        const yy = (w.solid[i] + w.water[i]) * this.vscale + 0.25;
        const dx = (vx / sp) * len;
        const dz = (vy / sp) * len;
        this.flowPos[o] = cx - dx;
        this.flowPos[o + 1] = yy;
        this.flowPos[o + 2] = cz - dz;
        this.flowPos[o + 3] = cx + dx;
        this.flowPos[o + 4] = yy;
        this.flowPos[o + 5] = cz + dz;
        o += 6;
        const alpha = Math.min(0.75, 0.2 + sp * 0.25) * (1 - Math.abs(phase) * 1.4);
        this.flowAlpha[a] = 0;
        this.flowAlpha[a + 1] = Math.max(0, alpha);
        a += 2;
        count++;
      }
    }
    this.flowGeo.setDrawRange(0, count * 2);
    this.flowGeo.attributes.position.needsUpdate = true;
    this.flowGeo.attributes.aAlpha.needsUpdate = true;
  }

  updateSources(time: number): void {
    if (!this.sources) return;
    const w = this.world;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    w.sources.forEach((src, i) => {
      const idx = src.y * w.w + src.x;
      const y = (w.solid[idx] + w.water[idx]) * this.vscale + 0.6;
      p.set((src.x + 0.5) * CELL, y, (src.y + 0.5) * CELL);
      const k = 1 + 0.16 * Math.sin(time * 2 + i);
      s.set(k, 1, k);
      m.compose(p, q, s);
      this.sources!.setMatrixAt(i, m);
    });
    this.sources.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const o of [this.cursorMesh, this.outline, this.selection, this.flow]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    if (this.sources) {
      this.sources.geometry.dispose();
      (this.sources.material as THREE.Material).dispose();
      this.sources.dispose();
    }
  }
}
