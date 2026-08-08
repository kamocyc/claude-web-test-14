import { SPEEDS } from './config';
import { hashSeed } from './core/rng';
import { Camera } from './render/camera';
import { Renderer, type Overlay } from './render/renderer';
import { BUILDINGS, type BuildingKind } from './sim/buildings';
import { Simulation } from './sim/simulation';
import { UI } from './ui/ui';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const minimap = document.getElementById('minimap') as HTMLCanvasElement;

/** URL の ?seed= で世界を固定できる */
function readSeed(): number {
  const p = new URLSearchParams(location.search);
  const s = p.get('seed');
  if (s) return /^\d+$/.test(s) ? Number(s) : hashSeed(s);
  return (Math.random() * 0xffffffff) >>> 0;
}

function boot(): void {
  const seed = readSeed();
  const ui = new UI({
    onSpeed: (i) => sim.setSpeed(i),
    onPredischarge: () => {
      const n = sim.setAllDamGates(1);
      sim.damage.info(
        n > 0 ? `${n}基のダムを全開にしました (事前放流)` : 'ダムがありません',
        sim.weather.day,
        sim.weather.hour,
        n > 0 ? 'good' : 'info',
      );
    },
    onCloseGates: () => {
      const n = sim.setAllDamGates(0.05);
      sim.damage.info(
        n > 0 ? `${n}基のダムを閉じて貯留を始めました` : 'ダムがありません',
        sim.weather.day,
        sim.weather.hour,
        n > 0 ? 'good' : 'info',
      );
    },
    onGate: (b, v) => sim.setGate(b, v),
    onMinimapClick: (fx, fy) => camera.centerOn(fx * sim.world.w, fy * sim.world.h),
  });

  ui.setLoadingText('流域を生成しています… (侵食計算中)');

  let sim!: Simulation;
  let camera!: Camera;
  let renderer!: Renderer;

  // 生成は重いので 1 フレーム待ってローディング画面を見せる
  setTimeout(() => {
    sim = new Simulation(seed);
    camera = new Camera(sim.world.w, sim.world.h);
    renderer = new Renderer(canvas, sim.world, camera);
    renderer.resize();

    // 河口付近 (南) の平野を初期表示にする
    camera.centerOn(sim.world.w * 0.5, sim.world.h * 0.68);
    camera.zoom = 5.5;

    setupInput();
    // 開発時のデバッグ用フック (コンソールから世界の状態を覗ける)
    if (import.meta.env.DEV) {
      Object.assign(window, { __game: sim, __camera: camera, __ui: ui });
    }
    ui.hideLoading();
    requestAnimationFrame(loop);
  }, 60);

  /* ---------------------------------------------------------------- */
  /* 入力                                                              */
  /* ---------------------------------------------------------------- */

  let panning = false;
  let painting = false;
  let lastPaint = -1;
  let lastPointer = { x: 0, y: 0 };
  let hoverCell: { x: number; y: number } | null = null;
  let dragMoved = 0;

  function applyTool(x: number, y: number): void {
    const tool = ui.tool;
    if (!sim.world.inBounds(x, y)) return;
    const key = y * sim.world.w + x;
    if (key === lastPaint) return;
    lastPaint = key;

    let msg = '';
    let ok = false;
    if (tool === 'inspect') {
      const b = sim.world.buildingAt(x, y);
      ui.select(b ?? null, b ? null : { x, y });
      return;
    } else if (tool === 'bulldoze') {
      const r = sim.bulldoze(x, y);
      ok = r.ok;
      msg = r.message;
    } else if (tool === 'dig') {
      const r = sim.terraform(x, y, -1);
      ok = r.ok;
      msg = r.message;
    } else if (tool === 'fill') {
      const r = sim.terraform(x, y, 1);
      ok = r.ok;
      msg = r.message;
    } else {
      const r = sim.build(tool as BuildingKind, x, y);
      ok = r.ok;
      msg = r.message;
    }
    if (!ok && msg && msg !== 'すでに建造物がある') {
      sim.damage.info(msg, sim.weather.day, sim.weather.hour, 'warn');
    }
  }

  function setupInput(): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      lastPointer = { x: e.clientX, y: e.clientY };
      dragMoved = 0;
      if (e.button === 2 || e.button === 1) {
        panning = true;
        return;
      }
      if (e.button !== 0) return;
      const c = camera.pick(e.offsetX, e.offsetY);
      if (ui.tool === 'inspect') {
        panning = true;
        return;
      }
      painting = true;
      lastPaint = -1;
      applyTool(c.x, c.y);
    });

    canvas.addEventListener('pointermove', (e) => {
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      lastPointer = { x: e.clientX, y: e.clientY };
      dragMoved += Math.abs(dx) + Math.abs(dy);

      if (panning) {
        camera.pan(dx, dy);
        ui.hideTooltip();
        return;
      }
      const c = camera.pick(e.offsetX, e.offsetY);
      hoverCell = c;
      if (painting) {
        const def = ui.tool in BUILDINGS ? BUILDINGS[ui.tool as BuildingKind] : null;
        const canDrag = def ? def.drag : ui.tool === 'dig' || ui.tool === 'fill' || ui.tool === 'bulldoze';
        if (canDrag) applyTool(c.x, c.y);
      } else {
        ui.hoverInfo(sim, c.x, c.y, e.clientX, e.clientY);
      }
    });

    const endPointer = (e: PointerEvent): void => {
      if (panning && ui.tool === 'inspect' && dragMoved < 5 && e.button === 0) {
        const c = camera.pick(e.offsetX, e.offsetY);
        const b = sim.world.buildingAt(c.x, c.y);
        ui.select(b ?? null, b ? null : c);
      }
      panning = false;
      painting = false;
      lastPaint = -1;
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', () => {
      panning = false;
      painting = false;
    });
    canvas.addEventListener('pointerleave', () => {
      hoverCell = null;
      ui.hideTooltip();
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        camera.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.16 : 1 / 1.16);
      },
      { passive: false },
    );

    window.addEventListener('resize', () => renderer.resize());

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          sim.setSpeed(sim.speedIndex === 0 ? 1 : 0);
          ui.setSpeedButtons(sim.speedIndex);
          break;
        case '1':
        case '2':
        case '3':
        case '4': {
          const i = Math.min(Number(e.key) - 1, SPEEDS.length - 1);
          sim.setSpeed(i);
          ui.setSpeedButtons(i);
          break;
        }
        case 'q':
        case 'Q':
          ui.setTool('inspect');
          break;
        case 'm':
        case 'M':
          ui.setOverlay(ui.overlay === 'moisture' ? 'none' : 'moisture');
          break;
        case 'h':
        case 'H':
          ui.setOverlay(ui.overlay === 'hazard' ? 'none' : 'hazard');
          break;
        case 'e':
        case 'E':
          ui.setOverlay(ui.overlay === 'elevation' ? 'none' : 'elevation');
          break;
        case 'n':
        case 'N':
          ui.setOverlay(ui.overlay === 'network' ? 'none' : 'network');
          break;
        case 'f':
        case 'F':
          ui.showFlow = !ui.showFlow;
          document.getElementById('btn-flow')?.classList.toggle('active', ui.showFlow);
          break;
        case 'g':
        case 'G':
          ui.showGrid = !ui.showGrid;
          document.getElementById('btn-grid')?.classList.toggle('active', ui.showGrid);
          break;
        case 'Escape':
          ui.setTool('inspect');
          ui.clearSelection();
          document.getElementById('help')?.classList.add('hidden');
          break;
        default:
          break;
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* メインループ                                                      */
  /* ---------------------------------------------------------------- */

  let last = performance.now();
  let hudTimer = 0;
  let miniTimer = 0;
  const miniCtx = minimap.getContext('2d');

  function loop(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.2);
    last = now;

    sim.advance(dt);

    const overlay: Overlay = ui.overlay;
    renderer.render(sim, {
      overlay,
      showFlow: ui.showFlow,
      showGrid: ui.showGrid,
      hover: hoverCell,
      cursor: buildCursor(),
      selected: ui.selected,
      time: now / 1000,
    });

    hudTimer += dt;
    if (hudTimer > 0.12) {
      hudTimer = 0;
      ui.update(sim);
    }
    miniTimer += dt;
    if (miniTimer > 0.4 && miniCtx) {
      miniTimer = 0;
      renderer.renderMinimap(miniCtx, minimap.width);
    }

    requestAnimationFrame(loop);
  }

  function buildCursor(): { cells: { x: number; y: number; ok: boolean }[]; label: string } | null {
    if (!hoverCell || ui.tool === 'inspect') return null;
    const { x, y } = hoverCell;
    if (!sim.world.inBounds(x, y)) return null;
    let ok = true;
    if (ui.tool === 'bulldoze') ok = !!sim.world.buildingAt(x, y);
    else if (ui.tool === 'dig' || ui.tool === 'fill') ok = !sim.world.buildingAt(x, y);
    else ok = sim.world.canPlace(ui.tool as BuildingKind, x, y).ok;
    return { cells: [{ x, y, ok }], label: '' };
  }
}

boot();
