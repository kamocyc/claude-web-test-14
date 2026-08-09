/**
 * three.js による 3D レンダラ。
 *
 * 構成:
 *   - 地形メッシュ (標高テクスチャを頂点シェーダで変位 / 色は手続き的)
 *   - 水面メッシュ (水位テクスチャで変位、流速に沿って波が流れる)
 *   - 施設 (種類ごとの InstancedMesh)
 *   - 植生・露岩 (InstancedMesh)
 *   - 空・太陽・環境マップ・降水
 *   - ポストプロセス (ブルーム + SMAA)
 *
 * 高さは uVScale 倍して描く (実寸だと 2.3km に対して比高 130m なので、
 * 高低差が読み取りにくい)。地形・水面はシェーダ内で、施設と植生は
 * scale.y を掛けたグループで、同じ倍率を掛けている。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CELL, MAP } from '../config';
import { clamp } from '../core/rng';
import type { Building } from '../sim/buildings';
import type { Simulation } from '../sim/simulation';
import type { World } from '../world/world';
import type { Camera } from './camera';
import { Minimap } from './minimap';
import type { Overlay } from './overlay';
import { BuildingLayer } from './gfx/buildings';
import { FieldTextures } from './gfx/fields';
import { Markers } from './gfx/markers';
import { PropLayer } from './gfx/props';
import { SkyEnv } from './gfx/sky';
import { TerrainMesh, type TerrainDetail } from './gfx/terrain';
import { createSharedUniforms, type SharedUniforms } from './gfx/uniforms';
import { WaterMesh } from './gfx/water';

export type { Overlay } from './overlay';

export type Quality = 'low' | 'medium' | 'high';

export interface GraphicsSettings {
  quality: Quality;
  shadows: boolean;
  /** 高さ強調 (1 = 実寸) */
  vscale: number;
  trees: boolean;
  /** ゲーム内時刻に合わせて日照を動かす */
  dayNight: boolean;
  contour: boolean;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  quality: 'high',
  shadows: true,
  vscale: 1.45,
  trees: true,
  dayNight: true,
  contour: false,
};

export interface RenderOptions {
  overlay: Overlay;
  showFlow: boolean;
  showGrid: boolean;
  cursor: { cells: { x: number; y: number; ok: boolean }[]; label: string } | null;
  selected: Building | null;
  /** 実時間 (秒) */
  time: number;
}

interface QualityProfile {
  terrain: TerrainDetail;
  water: number;
  post: boolean;
  shadowMap: number;
  maxPixelRatio: number;
}

const PROFILES: Record<Quality, QualityProfile> = {
  low: { terrain: 1, water: 1, post: false, shadowMap: 1024, maxPixelRatio: 1 },
  medium: { terrain: 2, water: 1, post: true, shadowMap: 2048, maxPixelRatio: 1.5 },
  high: { terrain: 2, water: 2, post: true, shadowMap: 4096, maxPixelRatio: 2 },
};

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private uniforms: SharedUniforms;
  private fields: FieldTextures;
  private terrain: TerrainMesh;
  private water: WaterMesh;
  private sky: SkyEnv;
  private buildings: BuildingLayer;
  private props: PropLayer;
  private markers: Markers;
  private minimap: Minimap;
  private scaled = new THREE.Group();
  private sea!: THREE.Mesh;
  private mapCenter = new THREE.Vector3((MAP * CELL) / 2, 0, (MAP * CELL) / 2);
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private settings: GraphicsSettings;
  private frame = 0;
  dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private camera: Camera,
    settings: GraphicsSettings = DEFAULT_GRAPHICS,
    seed = 1,
  ) {
    this.settings = { ...settings };
    this.gl = new THREE.WebGLRenderer({
      canvas,
      // ポストプロセスを使うときは合成用のバッファに描くので効かないが、
      // 品質設定を「低」に切り替えたときにそのまま MSAA が効くようにしておく
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = this.settings.shadows;
    this.gl.shadowMap.type = THREE.PCFShadowMap;

    this.scene.fog = new THREE.FogExp2(0x9fb6c8, 0.0006);

    this.fields = new FieldTextures(world);
    this.uniforms = createSharedUniforms(this.fields, world.maxHeight);
    this.uniforms.uVScale.value = this.settings.vscale;

    const prof = PROFILES[this.settings.quality];
    this.terrain = new TerrainMesh(this.uniforms, prof.terrain);
    this.water = new WaterMesh(this.uniforms, prof.water);
    this.sky = new SkyEnv(this.uniforms);
    this.buildings = new BuildingLayer();
    this.props = new PropLayer(world, seed);
    this.markers = new Markers(world);
    this.minimap = new Minimap(world);

    this.scaled.add(this.buildings.group, this.props.group, this.markers.group);

    this.scene.add(this.terrain.mesh, this.water.mesh, this.sky.group, this.scaled);

    // 海 (マップ外) — 地平線まで水が続いて見えるようにする
    const seaGeo = new THREE.PlaneGeometry(MAP * CELL * 24, MAP * CELL * 24);
    seaGeo.rotateX(-Math.PI / 2);
    const sea = new THREE.Mesh(
      seaGeo,
      new THREE.MeshStandardMaterial({ color: 0x16384f, roughness: 0.12, metalness: 0.35 }),
    );
    sea.position.set((MAP * CELL) / 2, -0.35 * this.settings.vscale, (MAP * CELL) / 2);
    sea.renderOrder = -1;
    sea.name = 'sea';
    this.scene.add(sea);
    this.sea = sea;

    this.camera.setVScale(this.settings.vscale);
    this.uniforms.uContour.value = this.settings.contour ? 1 : 0;
    this.props.setVisible(this.settings.trees);
    this.markers.vscale = this.settings.vscale;
    this.props.update(true, this.settings.vscale);
    this.resize();
  }

  /* ---------------------------------------------------------------- */

  get quality(): Quality {
    return this.settings.quality;
  }

  applySettings(next: Partial<GraphicsSettings>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...next };
    const prof = PROFILES[this.settings.quality];

    if (next.quality && next.quality !== prev.quality) {
      this.terrain.setDetail(prof.terrain);
      this.scene.remove(this.water.mesh);
      this.water.dispose();
      this.water = new WaterMesh(this.uniforms, prof.water);
      this.scene.add(this.water.mesh);
      this.sky.sun.shadow.mapSize.setScalar(prof.shadowMap);
      this.sky.sun.shadow.dispose();
      this.disposeComposer();
      this.resize();
    }
    if (next.shadows !== undefined) {
      this.gl.shadowMap.enabled = next.shadows;
      this.sky.sun.shadow.mapSize.setScalar(prof.shadowMap);
      this.sky.sun.shadow.dispose();
    }
    if (next.vscale !== undefined) {
      this.uniforms.uVScale.value = next.vscale;
      this.sea.position.y = -0.35 * next.vscale;
      this.camera.setVScale(next.vscale);
      this.markers.vscale = next.vscale;
      this.props.update(true, next.vscale);
      this.markers.updateSources(0);
    }
    if (next.trees !== undefined) this.props.setVisible(next.trees);
    if (next.contour !== undefined) this.uniforms.uContour.value = next.contour ? 1 : 0;
  }

  /**
   * 別の流域を読み込んだときに、世界に依存する部分だけ作り直す。
   * (WebGL コンテキストは 1 枚のキャンバスに 1 つしか作れないので、
   *  レンダラごと作り直すことはしない)
   */
  setWorld(world: World, seed: number): void {
    this.scene.remove(this.terrain.mesh, this.water.mesh);
    this.scaled.remove(this.buildings.group, this.props.group, this.markers.group);
    this.terrain.dispose();
    this.water.dispose();
    this.props.dispose();
    this.markers.dispose();
    this.fields.dispose();

    this.world = world;
    const prof = PROFILES[this.settings.quality];
    this.fields = new FieldTextures(world);
    // 共有ユニフォームのテクスチャ参照だけ差し替える
    this.uniforms.uHeightTex.value = this.fields.height;
    this.uniforms.uWaterTex.value = this.fields.water;
    this.uniforms.uSurfTex.value = this.fields.surface;
    this.uniforms.uOverlayTex.value = this.fields.overlay;
    this.uniforms.uSnowLine.value = Math.max(70, world.maxHeight * 0.74);

    this.terrain = new TerrainMesh(this.uniforms, prof.terrain);
    this.water = new WaterMesh(this.uniforms, prof.water);
    this.props = new PropLayer(world, seed);
    this.props.setVisible(this.settings.trees);
    this.markers = new Markers(world);
    this.markers.vscale = this.settings.vscale;
    this.minimap = new Minimap(world);

    this.scene.add(this.terrain.mesh, this.water.mesh);
    this.scaled.add(this.buildings.group, this.props.group, this.markers.group);
    this.props.update(true, this.settings.vscale);
  }

  resize(): void {
    const prof = PROFILES[this.settings.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, prof.maxPixelRatio);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.dpr = dpr;
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(w, h, false);
    this.camera.setViewport(w, h);
    if (prof.post) {
      this.ensureComposer();
      this.composer?.setPixelRatio(dpr);
      this.composer?.setSize(w, h);
      this.bloom?.setSize(w * dpr, h * dpr);
    } else {
      this.disposeComposer();
    }
  }

  private ensureComposer(): void {
    if (this.composer) return;
    const composer = new EffectComposer(this.gl);
    composer.addPass(new RenderPass(this.scene, this.camera.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.72, 0.86);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    composer.addPass(new SMAAPass());
    this.composer = composer;
    this.bloom = bloom;
  }

  private disposeComposer(): void {
    if (!this.composer) return;
    this.composer.dispose();
    this.composer = null;
    this.bloom = null;
  }

  /* ---------------------------------------------------------------- */

  render(sim: Simulation, opt: RenderOptions): void {
    this.frame++;
    const u = this.uniforms;
    u.uTime.value = opt.time;
    u.uGrid.value = opt.showGrid ? 1 : 0;
    u.uOverlayAmt.value = opt.overlay === 'none' ? 0 : 1;

    this.fields.tick(opt.overlay);

    // 季節と天気で地表の見え方を変える
    const w = sim.weather;
    const season = w.season.id;
    u.uSeasonGreen.value = season === 'winter' ? 0.15 : season === 'autumn' ? 0.5 : 1;
    u.uSnowFall.value = season === 'winter' ? 0.55 : 0;
    u.uWetness.value = clamp(w.rainRate / 12, 0, 1);

    const hour = this.settings.dayNight ? sim.clockHour : 11.5;
    this.sky.update({
      hour,
      day: w.day,
      kind: w.today.kind,
      rainRate: w.rainRate,
      scene: this.scene,
      renderer: this.gl,
      focus: this.camera.target,
      cameraPos: this.camera.camera.position,
      viewRadius: this.camera.viewRadius,
      mapCenter: this.mapCenter,
      mapRadius: MAP * CELL * 0.78,
      shadows: this.settings.shadows,
    });
    const night = 1 - this.sky.state.daylight;
    this.water.setAmbient(0.25 + this.sky.state.ambient * 0.75);

    this.buildings.update(this.world, night, this.settings.vscale);
    // 植生は地形が変わったときだけ並べ直す (定期的にも見直して冠水した森を消す)
    this.props.update(this.frame % 180 === 0, this.settings.vscale);

    this.markers.updateCursor(opt.cursor?.cells ?? null);
    this.markers.updateSelection(opt.selected, opt.time);
    this.markers.updateFlow(opt.showFlow, opt.time, this.camera.distance > 700 ? 4 : this.camera.distance > 300 ? 3 : 2);
    this.markers.updateSources(opt.time);

    if (this.composer) this.composer.render();
    else this.gl.render(this.scene, this.camera.camera);
  }

  renderMinimap(ctx: CanvasRenderingContext2D, size: number): void {
    this.minimap.render(ctx, size, this.camera);
  }

  dispose(): void {
    this.disposeComposer();
    this.terrain.dispose();
    this.water.dispose();
    this.sky.dispose();
    this.buildings.dispose();
    this.props.dispose();
    this.markers.dispose();
    this.fields.dispose();
    this.sea.geometry.dispose();
    (this.sea.material as THREE.Material).dispose();
    this.scene.clear();
    this.gl.dispose();
  }
}
