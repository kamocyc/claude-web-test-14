import { SPEEDS } from './config';
import { hashSeed } from './core/rng';
import { Camera } from './render/camera';
import { DEFAULT_GRAPHICS, Renderer, type GraphicsSettings, type Overlay } from './render/renderer';
import { BUILDINGS, type BuildingKind } from './sim/buildings';
import {
  SaveError,
  applySave,
  loadSave,
  readLocalStorage,
  saveToLocalStorage,
  validate,
  type SaveData,
} from './sim/save';
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

const GFX_KEY = 'hydropolis.graphics.v1';

/** 画質設定はブラウザに覚えさせておく */
function readGraphics(): GraphicsSettings {
  try {
    const raw = localStorage.getItem(GFX_KEY);
    if (!raw) return { ...DEFAULT_GRAPHICS };
    return { ...DEFAULT_GRAPHICS, ...(JSON.parse(raw) as Partial<GraphicsSettings>) };
  } catch {
    return { ...DEFAULT_GRAPHICS };
  }
}

function boot(): void {
  const seed = readSeed();
  const gfx = readGraphics();
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
    onSave: () => {
      try {
        saveToLocalStorage(sim, `${sim.weather.dateLabel()} の水都`);
        sim.damage.info('この状態をブラウザに保存しました', sim.weather.day, sim.weather.hour, 'good');
      } catch {
        sim.damage.info('保存できませんでした (ブラウザの空き容量が不足)', sim.weather.day, sim.weather.hour, 'warn');
      }
    },
    onLoad: () => {
      const data = readLocalStorage();
      if (!data) {
        sim.damage.info('保存されたデータがありません', sim.weather.day, sim.weather.hour, 'warn');
        return;
      }
      void applySaveData(data, '保存した状態を読み込んでいます…');
    },
    onLoadSample: () => void loadSample(),
    onGraphics: (next) => {
      Object.assign(gfx, next);
      renderer?.applySettings(next);
      try {
        localStorage.setItem(GFX_KEY, JSON.stringify(gfx));
      } catch {
        /* 保存できなくても描画は続けられる */
      }
    },
    graphics: gfx,
    onUnlimited: (on) => {
      sim.city.unlimited = on;
      sim.damage.info(
        on
          ? '資金無制限モードにしました (建設費・維持費で資金が減りません)'
          : `資金無制限モードを解除しました (残高 ￥${Math.round(sim.city.money).toLocaleString('ja-JP')})`,
        sim.weather.day,
        sim.weather.hour,
        'info',
      );
    },
    onBulldoze: (b) => {
      const r = sim.bulldoze(b.x, b.y);
      sim.damage.info(r.message, sim.weather.day, sim.weather.hour, r.ok ? 'good' : 'warn');
    },
    onWeather: (next) => {
      sim.weather.setManual(next);
      sim.damage.info(
        next
          ? `天気を手動に切り替えました (${next.rainRate.toFixed(1)}mm/h)`
          : '天気を暦どおりに戻しました',
        sim.weather.day,
        sim.weather.hour,
        'info',
      );
    },
  });

  ui.setLoadingText('流域を生成しています… (侵食計算中)');

  let sim!: Simulation;
  let camera!: Camera;
  let renderer!: Renderer;

  // 生成は重いので 1 フレーム待ってローディング画面を見せる
  setTimeout(() => {
    sim = new Simulation(seed);
    camera = new Camera(sim.world);
    try {
      renderer = new Renderer(canvas, sim.world, camera, gfx, seed);
    } catch (e) {
      ui.showLoading(
        'WebGL2 を初期化できませんでした。ハードウェアアクセラレーションを有効にしたブラウザで開いてください。',
      );
      console.error(e);
      return;
    }

    // 河口付近 (南) の平野を初期表示にする
    camera.centerOn(sim.world.w * 0.5, sim.world.h * 0.68);
    camera.distance = 620;
    camera.pitch = 0.62;
    camera.update();

    setupInput();
    exposeDebugHandles();
    ui.hideLoading();
    requestAnimationFrame(loop);
  }, 60);

  /* ---------------------------------------------------------------- */
  /* セーブデータの読み込み                                             */
  /* ---------------------------------------------------------------- */

  /** 開発時のデバッグ用フック (コンソールから世界の状態を覗ける) */
  function exposeDebugHandles(): void {
    if (!import.meta.env.DEV) return;
    Object.assign(window, { __game: sim, __camera: camera, __ui: ui, __renderer: renderer });
  }

  /** ローディング画面を実際に描画させてから重い処理に入る */
  function nextPaint(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  async function applySaveData(data: SaveData, message: string): Promise<void> {
    ui.showLoading(message);
    await nextPaint();
    try {
      validate(data);
      if (data.seed === sim.seed) {
        // 同じ流域なら地形を作り直す必要はない
        applySave(sim, data);
      } else {
        // 別の流域: 地形から作り直し、描画側も差し替える
        ui.setLoadingText('流域を生成しています… (侵食計算中)');
        await nextPaint();
        sim = loadSave(data);
        camera.setWorld(sim.world);
        renderer.setWorld(sim.world, data.seed);
        renderer.resize();
        camera.centerOn(sim.world.w * 0.5, sim.world.h * 0.6);
      }
      ui.reset();
      ui.setSpeedButtons(sim.speedIndex);
      exposeDebugHandles();
      sim.damage.info(`「${data.label}」を読み込みました`, sim.weather.day, sim.weather.hour, 'good');
    } catch (e) {
      const msg = e instanceof SaveError ? e.message : 'セーブデータを読み込めませんでした';
      sim.damage.info(msg, sim.weather.day, sim.weather.hour, 'warn');
    } finally {
      ui.hideLoading();
    }
  }

  async function loadSample(): Promise<void> {
    ui.showLoading('サンプルの町を読み込んでいます…');
    await nextPaint();
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}saves/sample.json`);
      if (!res.ok) throw new SaveError('サンプルデータが見つかりません');
      const data = (await res.json()) as SaveData;
      await applySaveData(data, 'サンプルの町を読み込んでいます…');
    } catch (e) {
      ui.hideLoading();
      const msg = e instanceof SaveError ? e.message : 'サンプルを読み込めませんでした';
      sim.damage.info(msg, sim.weather.day, sim.weather.hour, 'warn');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 入力                                                              */
  /* ---------------------------------------------------------------- */

  /** 押しっぱなしを見るキー (カメラ操作) */
  const CAMERA_KEYS = new Set([
    'w',
    'a',
    's',
    'd',
    'arrowup',
    'arrowdown',
    'arrowleft',
    'arrowright',
    'pageup',
    'pagedown',
    '+',
    ';', // JIS 配列の + は Shift+;
    '-',
    '=',
    'shift',
  ]);
  const heldKeys = new Set<string>();

  /** 押されているキーに応じてカメラを動かす (dt は実時間の秒) */
  function applyCameraKeys(dt: number): void {
    if (heldKeys.size === 0) return;
    const on = (...names: string[]): boolean => names.some((n) => heldKeys.has(n));
    const rotating = heldKeys.has('shift');

    let x = 0;
    let z = 0;
    if (on('a', 'arrowleft')) x -= 1;
    if (on('d', 'arrowright')) x += 1;
    if (on('w', 'arrowup')) z += 1;
    if (on('s', 'arrowdown')) z -= 1;

    if (rotating) {
      // Shift + 方向キーで視点を回す (ドラッグの回転と同じ向き)
      if (x !== 0 || z !== 0) camera.rotateBy(x * 1.6 * dt, z * 0.9 * dt);
    } else if (x !== 0 || z !== 0) {
      // 移動量はズームに比例させる (引いているときほど速く動く)
      const speed = camera.distance * 1.15 * dt;
      const len = Math.hypot(x, z);
      camera.moveBy((x / len) * speed, (z / len) * speed);
    }

    let zoom = 0;
    if (on('pageup', '+', ';', '=')) zoom += 1;
    if (on('pagedown', '-')) zoom -= 1;
    if (zoom !== 0) camera.zoomBy(Math.pow(2.4, zoom * dt));
  }

  let panning = false;
  let orbiting = false;
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
    // 右ドラッグを地図移動に使うので、ブラウザの右クリックメニューは
    // キャンバスだけでなく UI パネルの上でも出さない
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      lastPointer = { x: e.clientX, y: e.clientY };
      dragMoved = 0;
      // 中ドラッグ / Shift+右ドラッグ で視点を回す
      if (e.button === 1 || (e.button === 2 && e.shiftKey)) {
        orbiting = true;
        return;
      }
      if (e.button === 2) {
        panning = true;
        return;
      }
      if (e.button !== 0) return;
      if (e.shiftKey) {
        orbiting = true;
        return;
      }
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

      if (orbiting) {
        camera.orbit(dx, dy);
        ui.hideTooltip();
        return;
      }
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
      orbiting = false;
      painting = false;
      lastPaint = -1;
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', () => {
      panning = false;
      orbiting = false;
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
        camera.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.14 : 1 / 1.14);
      },
      { passive: false },
    );

    window.addEventListener('resize', () => renderer.resize());

    // カメラ移動は「押している間ずっと」動かしたいので、キーの状態だけ持っておき、
    // 実際の移動はメインループで dt を掛けて行う (keydown のリピートに任せると
    // 押し始めに間が空いてカクつく)
    window.addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => heldKeys.clear());

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (CAMERA_KEYS.has(e.key.toLowerCase())) {
        heldKeys.add(e.key.toLowerCase());
        e.preventDefault();
      }
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
        case 'x':
        case 'X':
        case 'Delete':
          // 撤去ツール (施設を選んでいるなら、それを直接撤去する)
          if (ui.selected) {
            const b = ui.selected;
            const r = sim.bulldoze(b.x, b.y);
            sim.damage.info(r.message, sim.weather.day, sim.weather.hour, r.ok ? 'good' : 'warn');
            ui.clearSelection();
          } else {
            ui.setTool('bulldoze');
          }
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
        case 'r':
        case 'R':
          camera.yaw = -0.62;
          camera.pitch = 0.62;
          camera.distance = 620;
          camera.update();
          break;
        case 'Escape':
          ui.setTool('inspect');
          ui.clearSelection();
          ui.closePanels();
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
    applyCameraKeys(dt);

    const overlay: Overlay = ui.overlay;
    renderer.render(sim, {
      overlay,
      showFlow: ui.showFlow,
      showGrid: ui.showGrid,
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
