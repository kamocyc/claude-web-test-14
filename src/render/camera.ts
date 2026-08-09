import * as THREE from 'three';
import { CELL, MAP } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';

/**
 * RTS 風の周回カメラ。注視点は常に地面の上にあり、そこを中心に
 * 距離・方位角・仰角で回る。
 *
 * 画面 → セルの変換は高さ場のレイマーチで行う (三角形へのレイキャストより
 * 速く、水面や建物に邪魔されずに「地面のどのセルか」が取れる)。
 *
 * カメラが扱う座標は「メートル単位 & 高さ方向は uVScale 倍済み」のワールド空間。
 */
export class Camera {
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.5, 12000);
  /** 注視点 (ワールド m) */
  readonly target = new THREE.Vector3();
  distance = 420;
  yaw = -0.62;
  pitch = 0.72;
  minDistance = 26;
  maxDistance = 2600;
  viewW = 800;
  viewH = 600;
  vscale = 1.45;

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmp = new THREE.Vector3();

  constructor(private world: World) {
    this.centerOn(MAP * 0.5, MAP * 0.62);
    this.update();
  }

  setWorld(world: World): void {
    this.world = world;
    this.centerOn(MAP * 0.5, MAP * 0.62);
  }

  setVScale(v: number): void {
    this.vscale = v;
    this.target.y = this.groundAt(this.target.x, this.target.z);
    this.update();
  }

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** 地面の高さ (ワールド m, 高さ強調込み) */
  groundAt(wx: number, wz: number): number {
    const w = this.world;
    const fx = clamp(wx / CELL - 0.5, 0, w.w - 1.001);
    const fz = clamp(wz / CELL - 0.5, 0, w.h - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const i = iz * w.w + ix;
    const h00 = w.height[i];
    const h10 = w.height[i + 1];
    const h01 = w.height[i + w.w];
    const h11 = w.height[i + w.w + 1];
    const h = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
    return h * this.vscale;
  }

  update(): void {
    this.pitch = clamp(this.pitch, 0.13, 1.45);
    this.distance = clamp(this.distance, this.minDistance, this.maxDistance);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.target.x + Math.cos(this.yaw) * cp * this.distance,
      this.target.y + sp * this.distance,
      this.target.z + Math.sin(this.yaw) * cp * this.distance,
    );
    // 地面へめり込まないよう最低限の高さを確保する
    const ground = this.groundAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < ground + 8) this.camera.position.y = ground + 8;
    this.camera.near = Math.max(0.5, this.distance * 0.008);
    this.camera.far = Math.max(3000, this.distance * 12);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** 画面上のドラッグで地図を平行移動 */
  pan(dxPixels: number, dyPixels: number): void {
    const perPixel = (2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this.viewH;
    const forward = new THREE.Vector3(-Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    this.target.addScaledVector(right, -dxPixels * perPixel);
    this.target.addScaledVector(forward, -dyPixels * perPixel);
    this.clampTarget();
    this.update();
  }

  /** 方位角・仰角 */
  orbit(dxPixels: number, dyPixels: number): void {
    this.yaw += dxPixels * 0.005;
    this.pitch = clamp(this.pitch - dyPixels * 0.004, 0.13, 1.45);
    this.update();
  }

  rotateBy(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, 0.13, 1.45);
    this.update();
  }

  /** 画面上の点を固定したままズーム */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.pickWorld(sx, sy);
    const next = clamp(this.distance / factor, this.minDistance, this.maxDistance);
    const applied = next / this.distance;
    this.distance = next;
    if (before) {
      // カーソル位置へ寄る
      const k = 1 - applied;
      this.target.x += (before.x - this.target.x) * k;
      this.target.z += (before.z - this.target.z) * k;
      this.clampTarget();
    }
    this.target.y = this.groundAt(this.target.x, this.target.z);
    this.update();
  }

  private clampTarget(): void {
    const span = MAP * CELL;
    this.target.x = clamp(this.target.x, -span * 0.1, span * 1.1);
    this.target.z = clamp(this.target.z, -span * 0.1, span * 1.1);
    this.target.y = this.groundAt(this.target.x, this.target.z);
  }

  centerOn(cellX: number, cellY: number): void {
    this.target.x = (cellX + 0.5) * CELL;
    this.target.z = (cellY + 0.5) * CELL;
    this.clampTarget();
    this.update();
  }

  /** 画面座標 → 地面のワールド座標 (高さ場のレイマーチ) */
  pickWorld(sx: number, sy: number): THREE.Vector3 | null {
    this.ndc.set((sx / this.viewW) * 2 - 1, -(sy / this.viewH) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;

    const maxY = (this.world.maxHeight + 4) * this.vscale;
    const minY = -10 * this.vscale;

    let t = 0;
    // 地形より高いところは一気に飛ばす
    if (o.y > maxY) {
      if (d.y >= -1e-6) return null;
      t = (maxY - o.y) / d.y;
    }
    const far = this.camera.far;
    let prevT = t;
    let prevDiff = o.y + d.y * t - this.groundAt(o.x + d.x * t, o.z + d.z * t);
    const stepBase = CELL * 0.45;
    let guard = 0;
    while (t < far && guard++ < 4000) {
      // 遠いほど粗く刻む (精度は最後の二分探索で取り返す)
      const step = stepBase * (1 + t / 900);
      t += step;
      const px = o.x + d.x * t;
      const py = o.y + d.y * t;
      const pz = o.z + d.z * t;
      if (py < minY) break;
      const diff = py - this.groundAt(px, pz);
      if (diff <= 0 && prevDiff > 0) {
        // 交差した区間を二分探索
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 20; k++) {
          const mid = (lo + hi) * 0.5;
          const my = o.y + d.y * mid - this.groundAt(o.x + d.x * mid, o.z + d.z * mid);
          if (my > 0) lo = mid;
          else hi = mid;
        }
        return this.tmp.set(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi).clone();
      }
      prevDiff = diff;
      prevT = t;
    }
    // 地形に当たらなければ海面 (y=0) との交点
    if (d.y < -1e-6) {
      const th = -o.y / d.y;
      if (th > 0) return this.tmp.set(o.x + d.x * th, 0, o.z + d.z * th).clone();
    }
    return null;
  }

  /** 画面座標 → セル */
  pick(sx: number, sy: number): { x: number; y: number } {
    const p = this.pickWorld(sx, sy);
    if (!p) return { x: -1, y: -1 };
    return { x: Math.floor(p.x / CELL), y: Math.floor(p.z / CELL) };
  }

  /** ミニマップ用: 画面四隅が地面のどこを見ているか (セル座標) */
  footprint(): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    const corners: [number, number][] = [
      [2, 2],
      [this.viewW - 2, 2],
      [this.viewW - 2, this.viewH - 2],
      [2, this.viewH - 2],
    ];
    for (const [sx, sy] of corners) {
      const p = this.pickWorld(sx, sy);
      if (p) pts.push({ x: p.x / CELL, y: p.z / CELL });
      else {
        // 空を向いている隅は、注視点から大きく外へ伸ばした点で代用する
        const dir = new THREE.Vector3(this.target.x - this.camera.position.x, 0, this.target.z - this.camera.position.z).normalize();
        pts.push({
          x: (this.target.x + dir.x * this.distance * 3) / CELL,
          y: (this.target.z + dir.z * this.distance * 3) / CELL,
        });
      }
    }
    return pts;
  }

  /** 影のフィッティングなどに使う「見えている範囲の目安」(m) */
  get viewRadius(): number {
    return this.distance * (0.75 + 0.9 * Math.cos(this.pitch));
  }
}
