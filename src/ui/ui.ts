import { CELL, CITY, IRRIGATION } from '../config';
import { clamp } from '../core/rng';
import { CROPS } from '../sim/agriculture';
import {
  BUILDINGS,
  CATEGORY_LABEL,
  DRAINPUMP_RADIUS,
  INTAKE_CAPACITY,
  TOWER_CAPACITY,
  TREATMENT_CAPACITY,
  type Building,
  type BuildingKind,
  type Category,
  type ToolKind,
} from '../sim/buildings';
import type { Simulation } from '../sim/simulation';
import { SKY_ICON, SKY_LABEL, inflowLabel } from '../sim/weather';
import type { Overlay } from '../render/renderer';

export interface UICallbacks {
  onSpeed(index: number): void;
  onPredischarge(): void;
  onCloseGates(): void;
  onGate(b: Building, value: number): void;
  onMinimapClick(x: number, y: number): void;
}

interface PseudoTool {
  kind: ToolKind;
  name: string;
  label: string;
  color: string;
  cost: string;
  desc: string;
  category: Category | 'misc';
}

const EXTRA_TOOLS: PseudoTool[] = [
  {
    kind: 'inspect',
    name: '調査',
    label: '?',
    color: '#9fb6c9',
    cost: '無料',
    desc: 'セルや施設の状態を調べる。ドラッグで地図を移動。',
    category: 'misc',
  },
  {
    kind: 'bulldoze',
    name: '撤去',
    label: '×',
    color: '#c96a5a',
    cost: '25%返金',
    desc: '施設を撤去する。',
    category: 'misc',
  },
  {
    kind: 'dig',
    name: '掘削',
    label: '↓',
    color: '#8a7c66',
    cost: '￥60/回',
    desc: '地面を 1m 下げる。水路をつくって水を引いたり、遊水地をつくったりする。',
    category: 'terrain',
  },
  {
    kind: 'fill',
    name: '盛土',
    label: '↑',
    color: '#a8956f',
    cost: '￥49/回',
    desc: '地面を 1m 上げる。宅地を水位より高くする。',
    category: 'terrain',
  },
];

const ORDER: (Category | 'misc')[] = ['misc', 'terrain', 'flood', 'water', 'agri', 'city'];

/** 住宅がつながっている水道網の状態を人間向けに説明する */
function describeNet(sim: Simulation, net: number): string {
  if (net < 0) return '未接続';
  const info = sim.network.netInfo.get(net);
  if (!info) return '未接続';
  if (!info.hasSource) return `#${net % 1000} (水源なし)`;
  return `#${net % 1000} 供給 ${info.supply.toFixed(2)} / 需要 ${info.demand.toFixed(2)} m³/h`;
}

function netHasSource(sim: Simulation, net: number): boolean {
  return net >= 0 && (sim.network.netInfo.get(net)?.hasSource ?? false);
}

export class UI {
  tool: ToolKind = 'inspect';
  overlay: Overlay = 'none';
  showFlow = true;
  showGrid = false;
  selected: Building | null = null;
  private selectedCell: { x: number; y: number } | null = null;
  private lastEventId = -1;
  private el: Record<string, HTMLElement> = {};
  private toolButtons = new Map<ToolKind, HTMLButtonElement>();

  constructor(private cb: UICallbacks) {
    const q = (id: string): HTMLElement => {
      const e = document.getElementById(id);
      if (!e) throw new Error(`要素が見つかりません: ${id}`);
      return e;
    };
    for (const id of [
      'v-date',
      'v-weather',
      'v-inflow',
      'v-money',
      'v-pop',
      'v-water',
      'v-food',
      'v-flood',
      'chip-flood',
      'chip-money',
      'chip-water',
      'tool-groups',
      'inspector',
      'insp-title',
      'insp-body',
      'events',
      'forecast',
      'tooltip',
      'help',
      'loading',
      'minimap',
      'chip-inflow',
    ]) {
      this.el[id] = q(id);
    }
    this.buildToolbar();
    this.wire();
  }

  /* ---------------------------------------------------------------- */

  private buildToolbar(): void {
    const host = this.el['tool-groups'];
    host.innerHTML = '';

    for (const cat of ORDER) {
      const items: PseudoTool[] = EXTRA_TOOLS.filter((t) => t.category === cat);
      for (const def of Object.values(BUILDINGS)) {
        if (def.category !== cat) continue;
        items.push({
          kind: def.kind,
          name: def.name,
          label: def.label,
          color: def.color,
          cost: `￥${def.cost}`,
          desc: def.desc,
          category: cat,
        });
      }
      if (items.length === 0) continue;

      const group = document.createElement('div');
      group.className = 'tool-group';
      const h = document.createElement('h3');
      h.textContent = cat === 'misc' ? '操作' : CATEGORY_LABEL[cat as Category];
      group.appendChild(h);

      for (const it of items) {
        const btn = document.createElement('button');
        btn.className = 'tool-btn';
        btn.innerHTML = `<span class="tool-swatch" style="background:${it.color}">${it.label}</span>
          <span class="tool-name">${it.name}</span>
          <span class="tool-cost">${it.cost}</span>`;
        btn.title = it.desc;
        btn.addEventListener('click', () => this.setTool(it.kind));
        btn.addEventListener('mouseenter', (e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          this.showTooltip(`<b>${it.name}</b><br>${it.desc}`, r.right + 8, r.top);
        });
        btn.addEventListener('mouseleave', () => this.hideTooltip());
        group.appendChild(btn);
        this.toolButtons.set(it.kind, btn);
      }
      host.appendChild(group);
    }
    this.setTool('inspect');
  }

  private wire(): void {
    document.querySelectorAll<HTMLButtonElement>('.speed button').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.speed);
        this.setSpeedButtons(i);
        this.cb.onSpeed(i);
      });
    });

    document.querySelectorAll<HTMLButtonElement>('.overlays button[data-overlay]').forEach((b) => {
      b.addEventListener('click', () => this.setOverlay(b.dataset.overlay as Overlay));
    });

    const flowBtn = document.getElementById('btn-flow') as HTMLButtonElement;
    flowBtn.addEventListener('click', () => {
      this.showFlow = !this.showFlow;
      flowBtn.classList.toggle('active', this.showFlow);
    });
    const gridBtn = document.getElementById('btn-grid') as HTMLButtonElement;
    gridBtn.addEventListener('click', () => {
      this.showGrid = !this.showGrid;
      gridBtn.classList.toggle('active', this.showGrid);
    });

    document.getElementById('btn-predischarge')?.addEventListener('click', () => this.cb.onPredischarge());
    document.getElementById('btn-closegates')?.addEventListener('click', () => this.cb.onCloseGates());
    document.getElementById('btn-help')?.addEventListener('click', () => this.el['help'].classList.remove('hidden'));
    document.getElementById('help-close')?.addEventListener('click', () => this.el['help'].classList.add('hidden'));
    document.getElementById('insp-close')?.addEventListener('click', () => this.clearSelection());

    const mini = this.el['minimap'] as HTMLCanvasElement;
    mini.addEventListener('click', (e) => {
      const r = mini.getBoundingClientRect();
      this.cb.onMinimapClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
  }

  setTool(tool: ToolKind): void {
    this.tool = tool;
    for (const [k, btn] of this.toolButtons) btn.classList.toggle('active', k === tool);
    if (tool !== 'inspect') this.clearSelection();
  }

  setOverlay(o: Overlay): void {
    this.overlay = o;
    document.querySelectorAll<HTMLButtonElement>('.overlays button[data-overlay]').forEach((b) => {
      b.classList.toggle('active', b.dataset.overlay === o);
    });
  }

  setSpeedButtons(i: number): void {
    document.querySelectorAll<HTMLButtonElement>('.speed button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.speed) === i);
    });
  }

  hideLoading(): void {
    this.el['loading'].classList.add('hidden');
  }

  setLoadingText(t: string): void {
    const e = document.getElementById('loading-text');
    if (e) e.textContent = t;
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  update(sim: Simulation): void {
    const s = sim.snapshot;
    const w = sim.weather;
    const set = (id: string, v: string): void => {
      const e = this.el[id];
      if (e.textContent !== v) e.textContent = v;
    };

    set('v-date', `${w.dateLabel()} ${w.timeLabel()}`);
    set(
      'v-weather',
      `${SKY_ICON[w.today.kind]} ${SKY_LABEL[w.today.kind]} ${w.rainRate > 0.05 ? `${w.rainRate.toFixed(1)}mm/h` : ''} ${w.tempC.toFixed(0)}℃`,
    );
    set('v-inflow', `${s.inflow.toFixed(1)} m³/s ${inflowLabel(s.inflow)}`);
    set('v-money', `￥${Math.round(s.city.money).toLocaleString('ja-JP')}`);
    set('v-pop', `${Math.round(s.city.population).toLocaleString('ja-JP')}`);
    set('v-water', `${Math.round((s.net.demand > 0 ? s.net.served / s.net.demand : 1) * 100)}%`);
    set('v-food', `${Math.round(s.city.food)}`);
    set('v-flood', `${s.damage.floodedCells} セル`);

    this.el['chip-money'].classList.toggle('alert', s.city.money < 0);
    this.el['chip-water'].classList.toggle('alert', s.net.demand > 0 && s.net.served / s.net.demand < 0.7);
    this.el['chip-flood'].classList.toggle('alert', s.damage.floodedCells > 60);
    this.el['chip-flood'].classList.toggle('warn-on', s.damage.floodedCells > 8 && s.damage.floodedCells <= 60);
    this.el['chip-inflow'].classList.toggle('alert', s.inflow > 120);
    this.el['chip-inflow'].classList.toggle('warn-on', s.inflow > 55 && s.inflow <= 120);

    this.updateEvents(sim);
    this.updateForecast(sim);
    if (this.selected) this.renderInspector(sim);
    else if (this.selectedCell) this.renderCellInspector(sim, this.selectedCell.x, this.selectedCell.y);
  }

  private updateEvents(sim: Simulation): void {
    const list = sim.damage.events;
    if (list.length === 0 || list[0].id === this.lastEventId) return;
    this.lastEventId = list[0].id;
    const host = this.el['events'];
    host.innerHTML = '';
    for (const ev of list.slice(0, 6)) {
      const div = document.createElement('div');
      div.className = `event ${ev.level}`;
      div.innerHTML = `<time>${ev.day + 1}日 ${String(ev.hour).padStart(2, '0')}:00</time>${ev.text}`;
      host.appendChild(div);
    }
  }

  private forecastKey = '';

  private updateForecast(sim: Simulation): void {
    const fc = sim.weather.forecast();
    const key = fc.map((d) => `${d.day}:${d.rainMm.toFixed(0)}`).join('|');
    if (key === this.forecastKey) return;
    this.forecastKey = key;

    const host = this.el['forecast'];
    host.innerHTML = '';
    fc.forEach((d, i) => {
      const div = document.createElement('div');
      div.className = `fc ${i === 0 ? 'today' : ''} ${d.kind === 'storm' ? 'storm' : d.kind === 'heavy' ? 'heavy' : ''}`;
      div.innerHTML = `<div class="fc-day">${i === 0 ? '今日' : `+${i}日`}</div>
        <div class="fc-icon">${SKY_ICON[d.kind]}</div>
        <div class="fc-mm">${d.rainMm > 0.5 ? `${d.rainMm.toFixed(0)}mm` : '—'}</div>`;
      div.title = `${d.season.name} / ${SKY_LABEL[d.kind]} / ${d.rainMm.toFixed(0)}mm / ${d.tempC.toFixed(0)}℃`;
      host.appendChild(div);
    });
  }

  /* ---------------------------------------------------------------- */
  /* インスペクタ                                                      */
  /* ---------------------------------------------------------------- */

  select(b: Building | null, cell: { x: number; y: number } | null): void {
    this.selected = b;
    this.selectedCell = b ? null : cell;
    this.el['inspector'].classList.toggle('hidden', !b && !cell);
  }

  clearSelection(): void {
    this.selected = null;
    this.selectedCell = null;
    this.el['inspector'].classList.add('hidden');
  }

  private row(k: string, v: string): string {
    return `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  }

  private bar(v: number, color = 'var(--accent)'): string {
    return `<div class="bar"><i style="width:${clamp(v, 0, 1) * 100}%;background:${color}"></i></div>`;
  }

  private renderInspector(sim: Simulation): void {
    const b = this.selected;
    if (!b) return;
    if (!sim.world.buildings.has(b.id)) {
      this.clearSelection();
      return;
    }
    const def = BUILDINGS[b.kind];
    const w = sim.world;
    const i = w.idx(b.x, b.y);
    this.el['insp-title'].textContent = `${def.name} (${b.x}, ${b.y})`;

    let html = '';
    html += this.row('健全度', `${Math.round(b.hp * 100)}%`) + this.bar(b.hp, b.hp > 0.5 ? 'var(--good)' : 'var(--danger)');
    html += this.row('標高', `${w.height[i].toFixed(1)} m`);
    html += this.row('水深', `${w.water[i].toFixed(2)} m`);
    html += this.row('維持費', `￥${def.upkeep.toFixed(1)}/h`);

    switch (b.kind) {
      case 'dam':
      case 'floodgate': {
        html += this.row('堰高', `${def.wallHeight} m`);
        html += this.row('有効天端', `${w.solid[i].toFixed(1)} m`);
        if (b.kind === 'dam') html += this.row('発電収入', `￥${b.rate.toFixed(1)}/h`);
        html += `<div class="gate-row">
            <label><span>ゲート開度</span><span id="gate-val">${Math.round(b.gate * 100)}%</span></label>
            <input type="range" min="0" max="100" value="${Math.round(b.gate * 100)}" id="gate-slider" />
          </div>
          <p class="insp-note">開けると下流へ流す (洪水前に空けておく)。閉めると貯めるが、満水を超えて越流すると決壊の危険。</p>`;
        break;
      }
      case 'levee':
        html += this.row('堤防高', `${def.wallHeight} m`);
        html += this.row('天端標高', `${w.solid[i].toFixed(1)} m`);
        html += `<p class="insp-note">${w.water[i] > 0.08 ? '⚠ 越流中！ 損傷が進んでいます。' : '越流していません。'}</p>`;
        break;
      case 'intake':
        html += this.row('取水量', `${b.rate.toFixed(1)} / ${INTAKE_CAPACITY} m³/h`);
        html += this.bar(b.rate / INTAKE_CAPACITY);
        break;
      case 'treatment':
        html += this.row('処理能力', `${TREATMENT_CAPACITY} m³/h`);
        break;
      case 'tower':
        html += this.row('貯水量', `${b.stored.toFixed(0)} / ${TOWER_CAPACITY} m³`);
        html += this.bar(b.stored / TOWER_CAPACITY);
        break;
      case 'well':
        html += this.row('揚水量', `${b.rate.toFixed(2)} m³/h`);
        break;
      case 'drainpump':
        html += this.row('排水量', `${b.rate.toFixed(0)} m³/h`);
        html += this.row('排水半径', `${DRAINPUMP_RADIUS} セル`);
        break;
      case 'house':
        html += this.row('入居', `${Math.round(b.occupancy * CITY.HOUSE_CAPACITY)} / ${CITY.HOUSE_CAPACITY} 人`);
        html += this.bar(b.occupancy);
        html += this.row('給水', `${Math.round(b.rate * 100)}%`);
        html += this.row('水道網', describeNet(sim, b.net));
        if (!netHasSource(sim, b.net)) {
          html += `<p class="insp-note" style="color:var(--warn)">この住宅がつながっている水道網に取水施設・井戸がありません。水道管でたどれる位置に水源をつなげてください。</p>`;
        }
        break;
      case 'farm':
      case 'paddy': {
        const spec = CROPS[b.kind];
        html += this.row('湿潤度', `${Math.round(w.moisture[i] * 100)}% / 必要 ${Math.round((spec?.need ?? 0) * 100)}%`);
        html += this.bar(w.moisture[i], w.moisture[i] >= (spec?.need ?? 1) ? 'var(--good)' : 'var(--warn)');
        html += this.row('生育', `${Math.round(b.growth * 100)}%`);
        html += this.bar(b.growth, '#d7e84a');
        html += `<p class="insp-note">${sim.agriculture.describe(b)}</p>`;
        break;
      }
      default:
        break;
    }

    html += `<p class="insp-note">${def.desc}</p>`;
    const body = this.el['insp-body'];
    body.innerHTML = html;

    const slider = document.getElementById('gate-slider') as HTMLInputElement | null;
    if (slider) {
      slider.addEventListener('input', () => {
        const v = Number(slider.value) / 100;
        this.cb.onGate(b, v);
        const label = document.getElementById('gate-val');
        if (label) label.textContent = `${Math.round(v * 100)}%`;
      });
    }
  }

  private renderCellInspector(sim: Simulation, x: number, y: number): void {
    const w = sim.world;
    if (!w.inBounds(x, y)) return;
    const i = w.idx(x, y);
    this.el['insp-title'].textContent = `地点 (${x}, ${y})`;
    const speed = Math.hypot(w.vx[i], w.vy[i]);
    const m = w.moisture[i];
    let html = '';
    html += this.row('標高', `${w.height[i].toFixed(2)} m`);
    html += this.row('水深', `${w.water[i].toFixed(3)} m`);
    html += this.row('水面標高', `${w.level(i).toFixed(2)} m`);
    html += this.row('流速', `${speed.toFixed(2)} m/s`);
    html += this.row('湿潤度', `${Math.round(m * 100)}%`);
    html += this.bar(m, m > 0.6 ? 'var(--good)' : 'var(--warn)');
    html += this.row('土壌水分', `${Math.round((w.soil[i] / 0.42) * 100)}%`);
    html += this.row('最大浸水履歴', `${w.floodMax[i].toFixed(2)} m`);
    html += this.row('上流域', `${Math.round(w.flowAcc[i])} セル (${((w.flowAcc[i] * CELL * CELL) / 1e6).toFixed(2)} km²)`);
    html += this.row('傾斜', `${(w.slope(x, y) / CELL * 100).toFixed(1)} %`);
    html += `<p class="insp-note">灌漑は水面から最大 ${IRRIGATION.RANGE} セル、水面 +${IRRIGATION.CLIMB}m の高さまで届きます。</p>`;
    this.el['insp-body'].innerHTML = html;
  }

  /* ---------------------------------------------------------------- */

  showTooltip(html: string, x: number, y: number): void {
    const t = this.el['tooltip'];
    t.innerHTML = html;
    t.classList.remove('hidden');
    const r = t.getBoundingClientRect();
    t.style.left = `${Math.min(x, window.innerWidth - r.width - 10)}px`;
    t.style.top = `${Math.min(y, window.innerHeight - r.height - 10)}px`;
  }

  hideTooltip(): void {
    this.el['tooltip'].classList.add('hidden');
  }

  /** マップ上のホバー情報 */
  hoverInfo(sim: Simulation, x: number, y: number, sx: number, sy: number): void {
    const w = sim.world;
    if (!w.inBounds(x, y)) {
      this.hideTooltip();
      return;
    }
    const i = w.idx(x, y);
    const b = w.buildingAt(x, y);
    const parts: string[] = [];
    if (b) parts.push(`<b>${BUILDINGS[b.kind].name}</b> (健全度 ${Math.round(b.hp * 100)}%)`);
    parts.push(`標高 ${w.height[i].toFixed(1)}m`);
    if (w.water[i] > 0.02) parts.push(`水深 <b>${w.water[i].toFixed(2)}m</b>`);
    if (w.moisture[i] > 0.02) parts.push(`湿潤 ${Math.round(w.moisture[i] * 100)}%`);
    if (this.tool !== 'inspect' && this.tool !== 'bulldoze' && this.tool !== 'dig' && this.tool !== 'fill') {
      const check = w.canPlace(this.tool as BuildingKind, x, y);
      parts.push(check.ok ? '<span style="color:#64d18a">建設可</span>' : `<span style="color:#e8695a">${check.reason}</span>`);
    }
    this.showTooltip(parts.join('<br>'), sx + 16, sy + 16);
  }
}
