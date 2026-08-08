import { HYDRO } from '../config';
import { clamp } from '../core/rng';
import { BUILDINGS, type Building } from '../sim/buildings';
import type { Simulation } from '../sim/simulation';
import type { World } from '../world/world';
import type { Camera } from './camera';

export type Overlay = 'none' | 'moisture' | 'hazard' | 'elevation' | 'network';

export interface RenderOptions {
  overlay: Overlay;
  showFlow: boolean;
  showGrid: boolean;
  hover: { x: number; y: number } | null;
  /** 建設カーソル: 有効なら色を変えて表示 */
  cursor: { cells: { x: number; y: number; ok: boolean }[]; label: string } | null;
  selected: Building | null;
  time: number;
}

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
      return [
        a.c[0] + (b.c[0] - a.c[0]) * t,
        a.c[1] + (b.c[1] - a.c[1]) * t,
        a.c[2] + (b.c[2] - a.c[2]) * t,
      ];
    }
  }
  return RAMP[RAMP.length - 1].c;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private terrainCanvas: HTMLCanvasElement;
  private terrainCtx: CanvasRenderingContext2D;
  private terrainImage: ImageData;
  private waterCanvas: HTMLCanvasElement;
  private waterCtx: CanvasRenderingContext2D;
  private waterImage: ImageData;
  private overlayCanvas: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private overlayImage: ImageData;
  private terrainVersion = -1;
  private lastOverlay: Overlay | null = null;
  private overlayAge = 0;
  dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private camera: Camera,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D コンテキストを取得できません');
    this.ctx = ctx;

    const mk = (): [HTMLCanvasElement, CanvasRenderingContext2D, ImageData] => {
      const c = document.createElement('canvas');
      c.width = world.w;
      c.height = world.h;
      const cc = c.getContext('2d');
      if (!cc) throw new Error('オフスクリーンを作成できません');
      return [c, cc, cc.createImageData(world.w, world.h)];
    };
    [this.terrainCanvas, this.terrainCtx, this.terrainImage] = mk();
    [this.waterCanvas, this.waterCtx, this.waterImage] = mk();
    [this.overlayCanvas, this.overlayCtx, this.overlayImage] = mk();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.camera.setViewport(rect.width, rect.height);
  }

  /* ---------------------------------------------------------------- */
  /* 地形                                                              */
  /* ---------------------------------------------------------------- */

  private buildTerrain(): void {
    const w = this.world;
    const W = w.w;
    const H = w.h;
    const px = this.terrainImage.data;
    const hm = w.height;

    // 光源: 北西上方
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
        // 法線 (セル幅 12m でスケール)
        const nx = (xm - xp) / 24;
        const ny = (ym - yp) / 24;
        const nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        let shade = (nx * lx + ny * ly + nz * lz) / (nl * ll);
        shade = 0.42 + 0.72 * clamp(shade, 0, 1);

        let [r, g, b] = rampColor(h);

        // 河床は湿った色に
        if (w.riverMask[i]) {
          r = r * 0.78 + 60 * 0.22;
          g = g * 0.78 + 80 * 0.22;
          b = b * 0.78 + 96 * 0.22;
        }

        // 等高線 (10m ごと)
        const band = h / 10;
        const frac = band - Math.floor(band);
        if (h > 0 && (frac < 0.045 || frac > 0.955)) shade *= 0.86;

        const o = i * 4;
        px[o] = clamp(r * shade, 0, 255);
        px[o + 1] = clamp(g * shade, 0, 255);
        px[o + 2] = clamp(b * shade, 0, 255);
        px[o + 3] = 255;
      }
    }
    this.terrainCtx.putImageData(this.terrainImage, 0, 0);
    this.terrainVersion = this.world.terrainVersion;
  }

  /* ---------------------------------------------------------------- */
  /* 水                                                                */
  /* ---------------------------------------------------------------- */

  private buildWater(): void {
    const w = this.world;
    const W = w.w;
    const H = w.h;
    const px = this.waterImage.data;
    const water = w.water;
    const solid = w.solid;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = water[i];
        const o = i * 4;
        if (d < HYDRO.EPS_DEPTH) {
          px[o + 3] = 0;
          continue;
        }
        // 深さで色を変える
        const t = clamp(d / 3.2, 0, 1);
        let r = 96 - 72 * t;
        let g = 158 - 88 * t;
        let b = 206 - 62 * t;

        // 水面の傾き (法線) による陰影で流れの起伏を表現
        const li = solid[i] + d;
        const lxm = x > 0 ? solid[i - 1] + water[i - 1] : li;
        const lxp = x < W - 1 ? solid[i + 1] + water[i + 1] : li;
        const lym = y > 0 ? solid[i - W] + water[i - W] : li;
        const lyp = y < H - 1 ? solid[i + W] + water[i + W] : li;
        const sl = (lxm - lxp + lym - lyp) * 0.5;
        const spec = clamp(0.5 + sl * 1.4, 0, 1.6);
        r *= 0.6 + 0.5 * spec;
        g *= 0.6 + 0.5 * spec;
        b *= 0.6 + 0.5 * spec;

        // 流速が速いところは白波
        const sp = Math.hypot(w.vx[i], w.vy[i]);
        if (sp > 0.9) {
          const f = clamp((sp - 0.9) / 2.5, 0, 0.75);
          r += (255 - r) * f;
          g += (255 - g) * f;
          b += (255 - b) * f;
        }

        px[o] = clamp(r, 0, 255);
        px[o + 1] = clamp(g, 0, 255);
        px[o + 2] = clamp(b, 0, 255);
        px[o + 3] = clamp(70 + d * 300, 60, 236);
      }
    }
    this.waterCtx.putImageData(this.waterImage, 0, 0);
  }

  /* ---------------------------------------------------------------- */
  /* オーバーレイ                                                      */
  /* ---------------------------------------------------------------- */

  private buildOverlay(mode: Overlay): void {
    const w = this.world;
    const px = this.overlayImage.data;
    const n = w.w * w.h;

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      switch (mode) {
        case 'moisture': {
          // 「どこに何が作れるか」が分かるよう、作物の要求値で色分けする
          const m = w.moisture[i];
          if (m >= 0.8) {
            // 水田も作れる十分な湿り
            r = 46;
            g = 200;
            b = 120;
            a = 165;
          } else if (m >= 0.35) {
            // 畑なら作れる
            r = 190;
            g = 205;
            b = 70;
            a = 105;
          } else if (m >= 0.15) {
            // 乾き気味 (灌漑が要る)
            r = 205;
            g = 130;
            b = 60;
            a = 55;
          }
          break;
        }
        case 'hazard': {
          const d = w.floodMax[i];
          if (d > 0.12) {
            const t = clamp(d / 2.2, 0, 1);
            r = 120 + 135 * t;
            g = 210 - 170 * t;
            b = 60;
            a = 60 + t * 150;
          }
          break;
        }
        case 'elevation': {
          const h = w.height[i];
          const t = clamp(h / Math.max(1, w.maxHeight), 0, 1);
          r = 30 + 225 * t;
          g = 60 + 120 * (1 - Math.abs(t - 0.5) * 2);
          b = 220 - 190 * t;
          a = 150;
          break;
        }
        case 'network': {
          const id = w.structure[i];
          if (id >= 0) {
            const bl = w.buildings.get(id);
            if (bl && bl.net >= 0) {
              const hue = (bl.net * 2654435761) % 360;
              const [rr, gg, bb] = hslToRgb(hue / 360, 0.7, 0.55);
              r = rr;
              g = gg;
              b = bb;
              a = 200;
            }
          }
          break;
        }
        default:
          break;
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a;
    }
    this.overlayCtx.putImageData(this.overlayImage, 0, 0);
    this.lastOverlay = mode;
    this.overlayAge = 0;
  }

  /* ---------------------------------------------------------------- */
  /* 描画本体                                                          */
  /* ---------------------------------------------------------------- */

  render(sim: Simulation, opt: RenderOptions): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const w = this.world;

    if (this.terrainVersion !== w.terrainVersion) this.buildTerrain();
    this.buildWater();
    if (opt.overlay !== 'none') {
      this.overlayAge++;
      if (opt.overlay !== this.lastOverlay || this.overlayAge > 12) this.buildOverlay(opt.overlay);
    }

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = '#0b1420';
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    const sx = cam.worldToScreenX(0);
    const sy = cam.worldToScreenY(0);
    const sw = w.w * cam.zoom;
    const sh = w.h * cam.zoom;

    // 地形は連続量なので常に補間する (滑らかな斜面に見える)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.terrainCanvas, sx, sy, sw, sh);

    // 水とオーバーレイは「どのセルか」が重要なので、寄ったときは補間しない。
    // 引いたときだけ補間してちらつきを抑える。
    ctx.imageSmoothingEnabled = cam.zoom < 8;
    ctx.drawImage(this.waterCanvas, sx, sy, sw, sh);
    if (opt.overlay !== 'none') {
      ctx.globalAlpha = 0.72;
      ctx.drawImage(this.overlayCanvas, sx, sy, sw, sh);
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = true;

    if (opt.showFlow) this.drawFlow(ctx, opt.time);
    if (opt.showGrid && cam.zoom >= 11) this.drawGrid(ctx);
    this.drawBuildings(ctx, opt);
    this.drawSources(ctx, opt.time);
    if (opt.cursor) this.drawCursor(ctx, opt.cursor);
    if (opt.selected) this.drawSelection(ctx, opt.selected);
    void sim;

    ctx.restore();
  }

  private drawFlow(ctx: CanvasRenderingContext2D, time: number): void {
    const cam = this.camera;
    const w = this.world;
    const b = cam.visibleBounds();
    const step = cam.zoom > 9 ? 2 : cam.zoom > 4 ? 3 : 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(235,248,255,0.55)';
    ctx.lineWidth = Math.max(0.7, cam.zoom * 0.09);
    ctx.beginPath();
    for (let y = b.y0; y <= b.y1; y += step) {
      for (let x = b.x0; x <= b.x1; x += step) {
        const i = y * w.w + x;
        if (w.water[i] < 0.18) continue;
        const vx = w.vx[i];
        const vy = w.vy[i];
        const sp = Math.hypot(vx, vy);
        if (sp < 0.12) continue;
        // 時間で位相をずらして「流れている」ように見せる
        const phase = ((time * 0.55 + (x * 7 + y * 13) * 0.0917) % 1) - 0.5;
        const cx = x + 0.5 + (vx / sp) * phase * step * 0.9;
        const cy = y + 0.5 + (vy / sp) * phase * step * 0.9;
        const len = Math.min(0.9, 0.22 + sp * 0.22) * step * 0.5;
        const px0 = cam.worldToScreenX(cx - (vx / sp) * len);
        const py0 = cam.worldToScreenY(cy - (vy / sp) * len);
        const px1 = cam.worldToScreenX(cx + (vx / sp) * len);
        const py1 = cam.worldToScreenY(cy + (vy / sp) * len);
        ctx.moveTo(px0, py0);
        ctx.lineTo(px1, py1);
      }
    }
    ctx.stroke();
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const cam = this.camera;
    const b = cam.visibleBounds();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = b.x0; x <= b.x1 + 1; x++) {
      const px = Math.round(cam.worldToScreenX(x)) + 0.5;
      ctx.moveTo(px, cam.worldToScreenY(b.y0));
      ctx.lineTo(px, cam.worldToScreenY(b.y1 + 1));
    }
    for (let y = b.y0; y <= b.y1 + 1; y++) {
      const py = Math.round(cam.worldToScreenY(y)) + 0.5;
      ctx.moveTo(cam.worldToScreenX(b.x0), py);
      ctx.lineTo(cam.worldToScreenX(b.x1 + 1), py);
    }
    ctx.stroke();
  }

  private drawBuildings(ctx: CanvasRenderingContext2D, opt: RenderOptions): void {
    const cam = this.camera;
    const z = cam.zoom;
    const b = cam.visibleBounds();
    const showLabel = z >= 9;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(z * 0.62)}px "Noto Sans JP", sans-serif`;

    for (const bld of this.world.buildings.values()) {
      if (bld.x < b.x0 - 1 || bld.x > b.x1 + 1 || bld.y < b.y0 - 1 || bld.y > b.y1 + 1) continue;
      const def = BUILDINGS[bld.kind];
      const px = cam.worldToScreenX(bld.x);
      const py = cam.worldToScreenY(bld.y);
      const s = z;

      ctx.fillStyle = def.color;
      if (bld.hp < 1) ctx.globalAlpha = 0.45 + 0.55 * bld.hp;
      ctx.fillRect(px + s * 0.08, py + s * 0.08, s * 0.84, s * 0.84);
      ctx.globalAlpha = 1;

      // 堤防・ダムは「壁」らしく縁取る
      if (def.wallHeight > 0) {
        ctx.strokeStyle = 'rgba(20,20,20,0.55)';
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.strokeRect(px + s * 0.08, py + s * 0.08, s * 0.84, s * 0.84);
        if (def.hasGate && bld.gate > 0.05) {
          // ゲート開度を青い隙間で表現
          ctx.fillStyle = 'rgba(90,180,240,0.9)';
          const gh = s * 0.84 * clamp(bld.gate, 0, 1) * 0.5;
          ctx.fillRect(px + s * 0.3, py + s * 0.9 - gh, s * 0.4, gh);
        }
      }

      if (showLabel) {
        ctx.fillStyle = 'rgba(16,18,22,0.85)';
        ctx.fillText(def.label, px + s * 0.5, py + s * 0.52);
      }

      // 健全度バー
      if (bld.hp < 0.98 && z >= 6) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(px + s * 0.1, py + s * 0.02, s * 0.8, s * 0.1);
        ctx.fillStyle = bld.hp > 0.5 ? '#6ad46a' : bld.hp > 0.25 ? '#e8c650' : '#e05a4a';
        ctx.fillRect(px + s * 0.1, py + s * 0.02, s * 0.8 * bld.hp, s * 0.1);
      }

      // 作物の生育を緑の下線で
      if ((bld.kind === 'farm' || bld.kind === 'paddy') && z >= 6) {
        ctx.fillStyle = 'rgba(30,60,20,0.55)';
        ctx.fillRect(px + s * 0.1, py + s * 0.86, s * 0.8, s * 0.1);
        ctx.fillStyle = '#d7e84a';
        ctx.fillRect(px + s * 0.1, py + s * 0.86, s * 0.8 * clamp(bld.growth, 0, 1), s * 0.1);
      }
    }
    void opt;
  }

  private drawSources(ctx: CanvasRenderingContext2D, time: number): void {
    const cam = this.camera;
    if (cam.zoom < 3) return;
    ctx.strokeStyle = 'rgba(150,220,255,0.75)';
    ctx.lineWidth = 1.5;
    for (const s of this.world.sources) {
      const px = cam.worldToScreenX(s.x + 0.5);
      const py = cam.worldToScreenY(s.y + 0.5);
      const r = (cam.zoom * 0.8 + 4) * (1 + 0.15 * Math.sin(time * 2));
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D, cursor: NonNullable<RenderOptions['cursor']>): void {
    const cam = this.camera;
    const z = cam.zoom;
    for (const c of cursor.cells) {
      const px = cam.worldToScreenX(c.x);
      const py = cam.worldToScreenY(c.y);
      ctx.fillStyle = c.ok ? 'rgba(120,220,150,0.35)' : 'rgba(230,90,80,0.35)';
      ctx.fillRect(px, py, z, z);
      ctx.strokeStyle = c.ok ? 'rgba(160,255,190,0.9)' : 'rgba(255,130,120,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 0.5, py + 0.5, z - 1, z - 1);
    }
  }

  private drawSelection(ctx: CanvasRenderingContext2D, b: Building): void {
    const cam = this.camera;
    const z = cam.zoom;
    const px = cam.worldToScreenX(b.x);
    const py = cam.worldToScreenY(b.y);
    ctx.strokeStyle = '#ffe27a';
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 2, py - 2, z + 4, z + 4);
  }

  /** ミニマップ */
  renderMinimap(ctx: CanvasRenderingContext2D, size: number): void {
    const w = this.world;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.terrainCanvas, 0, 0, size, size);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(this.waterCanvas, 0, 0, size, size);
    ctx.globalAlpha = 1;

    const cam = this.camera;
    const b = cam.visibleBounds();
    const k = size / w.w;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x0 * k, b.y0 * k, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
