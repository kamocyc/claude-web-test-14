/**
 * ミニマップ (2D)。3D ビューとは別に、真上から見た標高陰影図を作る。
 * 全体像の把握はこちらのほうが速いので、3D 化しても残している。
 */
import { HYDRO } from '../config';
import { clamp } from '../core/rng';
import type { World } from '../world/world';
import type { Camera } from './camera';

interface Stop {
  h: number;
  c: [number, number, number];
}

/** 標高カラーランプ (日本の里山〜山岳をイメージ) */
const RAMP: Stop[] = [
  { h: -8, c: [24, 46, 72] },
  { h: -0.5, c: [46, 82, 112] },
  { h: 0.6, c: [176, 165, 126] },
  { h: 3, c: [128, 152, 96] },
  { h: 12, c: [96, 140, 78] },
  { h: 28, c: [78, 118, 66] },
  { h: 50, c: [96, 116, 74] },
  { h: 72, c: [126, 122, 100] },
  { h: 92, c: [150, 146, 140] },
  { h: 110, c: [196, 198, 200] },
  { h: 128, c: [238, 244, 248] },
];

function rampColor(h: number): [number, number, number] {
  if (h <= RAMP[0].h) return RAMP[0].c;
  for (let i = 1; i < RAMP.length; i++) {
    if (h <= RAMP[i].h) {
      const a = RAMP[i - 1];
      const b = RAMP[i];
      const t = (h - a.h) / (b.h - a.h);
      return [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t];
    }
  }
  return RAMP[RAMP.length - 1].c;
}

export class Minimap {
  private terrain: HTMLCanvasElement;
  private terrainCtx: CanvasRenderingContext2D;
  private terrainImage: ImageData;
  private water: HTMLCanvasElement;
  private waterCtx: CanvasRenderingContext2D;
  private waterImage: ImageData;
  private version = -1;

  constructor(private world: World) {
    const mk = (): [HTMLCanvasElement, CanvasRenderingContext2D, ImageData] => {
      const c = document.createElement('canvas');
      c.width = world.w;
      c.height = world.h;
      const cc = c.getContext('2d');
      if (!cc) throw new Error('オフスクリーンを作成できません');
      return [c, cc, cc.createImageData(world.w, world.h)];
    };
    [this.terrain, this.terrainCtx, this.terrainImage] = mk();
    [this.water, this.waterCtx, this.waterImage] = mk();
  }

  private buildTerrain(): void {
    const w = this.world;
    const W = w.w;
    const H = w.h;
    const px = this.terrainImage.data;
    const hm = w.height;
    const lx = -0.55;
    const ly = -0.7;
    const lz = 0.45;
    const ll = Math.hypot(lx, ly, lz);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const h = hm[i];
        const xm = x > 0 ? hm[i - 1] : h;
        const xp = x < W - 1 ? hm[i + 1] : h;
        const ym = y > 0 ? hm[i - W] : h;
        const yp = y < H - 1 ? hm[i + W] : h;
        const nx = (xm - xp) / 24;
        const ny = (ym - yp) / 24;
        const nl = Math.hypot(nx, ny, 1);
        let shade = (nx * lx + ny * ly + lz) / (nl * ll);
        shade = 0.42 + 0.72 * clamp(shade, 0, 1);
        const [r, g, b] = rampColor(h);
        const o = i * 4;
        px[o] = clamp(r * shade, 0, 255);
        px[o + 1] = clamp(g * shade, 0, 255);
        px[o + 2] = clamp(b * shade, 0, 255);
        px[o + 3] = 255;
      }
    }
    this.terrainCtx.putImageData(this.terrainImage, 0, 0);
    this.version = w.terrainVersion;
  }

  private buildWater(): void {
    const w = this.world;
    const px = this.waterImage.data;
    const n = w.w * w.h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const d = w.water[i];
      if (d < HYDRO.EPS_DEPTH) {
        px[o + 3] = 0;
        continue;
      }
      const t = clamp(d / 3.2, 0, 1);
      px[o] = 96 - 72 * t;
      px[o + 1] = 158 - 88 * t;
      px[o + 2] = 206 - 62 * t;
      px[o + 3] = clamp(80 + d * 300, 70, 236);
    }
    this.waterCtx.putImageData(this.waterImage, 0, 0);
  }

  render(ctx: CanvasRenderingContext2D, size: number, camera: Camera): void {
    if (this.version !== this.world.terrainVersion) this.buildTerrain();
    this.buildWater();
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain, 0, 0, size, size);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.water, 0, 0, size, size);
    ctx.globalAlpha = 1;

    // 施設を点で
    const k = size / this.world.w;
    ctx.fillStyle = 'rgba(255,236,180,0.9)';
    for (const b of this.world.buildings.values()) {
      if (b.kind === 'house') ctx.fillRect(b.x * k - 0.5, b.y * k - 0.5, Math.max(1, k), Math.max(1, k));
    }

    // 視界 (3D カメラが地面を切り取っている四角形)
    const fp = camera.footprint();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    fp.forEach((p, i) => {
      const x = clamp(p.x * k, -size, size * 2);
      const y = clamp(p.y * k, -size, size * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}
