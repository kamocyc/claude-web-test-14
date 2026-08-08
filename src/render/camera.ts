import { clamp } from '../core/rng';

/** セル座標 ↔ 画面座標の変換。 */
export class Camera {
  /** 画面中心が見ているセル座標 */
  x: number;
  y: number;
  /** 1セルあたりのピクセル数 */
  zoom = 4;
  minZoom = 1.6;
  maxZoom = 26;

  constructor(
    private mapW: number,
    private mapH: number,
  ) {
    this.x = mapW / 2;
    this.y = mapH / 2;
  }

  viewW = 800;
  viewH = 600;

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.minZoom = Math.max(1.2, Math.min(w / this.mapW, h / this.mapH) * 0.85);
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    this.clampPosition();
  }

  worldToScreenX(cx: number): number {
    return (cx - this.x) * this.zoom + this.viewW / 2;
  }

  worldToScreenY(cy: number): number {
    return (cy - this.y) * this.zoom + this.viewH / 2;
  }

  screenToWorldX(sx: number): number {
    return (sx - this.viewW / 2) / this.zoom + this.x;
  }

  screenToWorldY(sy: number): number {
    return (sy - this.viewH / 2) / this.zoom + this.y;
  }

  /** 画面座標 → セル (整数) */
  pick(sx: number, sy: number): { x: number; y: number } {
    return {
      x: Math.floor(this.screenToWorldX(sx)),
      y: Math.floor(this.screenToWorldY(sy)),
    };
  }

  pan(dxPixels: number, dyPixels: number): void {
    this.x -= dxPixels / this.zoom;
    this.y -= dyPixels / this.zoom;
    this.clampPosition();
  }

  /** 指定した画面座標を固定したままズーム */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    const next = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    if (next === this.zoom) return;
    this.zoom = next;
    this.x = wx - (sx - this.viewW / 2) / this.zoom;
    this.y = wy - (sy - this.viewH / 2) / this.zoom;
    this.clampPosition();
  }

  private clampPosition(): void {
    const marginX = this.viewW / this.zoom / 2;
    const marginY = this.viewH / this.zoom / 2;
    this.x = clamp(this.x, -marginX * 0.3, this.mapW + marginX * 0.3);
    this.y = clamp(this.y, -marginY * 0.3, this.mapH + marginY * 0.3);
  }

  /** 画面に映っているセル範囲 */
  visibleBounds(): { x0: number; y0: number; x1: number; y1: number } {
    return {
      x0: Math.max(0, Math.floor(this.screenToWorldX(0)) - 1),
      y0: Math.max(0, Math.floor(this.screenToWorldY(0)) - 1),
      x1: Math.min(this.mapW - 1, Math.ceil(this.screenToWorldX(this.viewW)) + 1),
      y1: Math.min(this.mapH - 1, Math.ceil(this.screenToWorldY(this.viewH)) + 1),
    };
  }

  centerOn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clampPosition();
  }
}
