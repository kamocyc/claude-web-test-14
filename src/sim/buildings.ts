/** 建造物の定義 (純データ)。配置可否の判定は World 側で行う。 */

export type BuildingKind =
  | 'levee'
  | 'dam'
  | 'floodgate'
  | 'drainpump'
  | 'intake'
  | 'treatment'
  | 'tower'
  | 'pipe'
  | 'well'
  | 'farm'
  | 'paddy'
  | 'house';

export type ToolKind = BuildingKind | 'dig' | 'fill' | 'bulldoze' | 'inspect';

export type Category = 'flood' | 'water' | 'agri' | 'city' | 'terrain';

export interface BuildingDef {
  kind: BuildingKind;
  name: string;
  nameEn: string;
  category: Category;
  cost: number;
  /** 維持費 (￥/ゲーム時間) */
  upkeep: number;
  /** 構造物による嵩上げ高さ (m)。0 なら水を堰き止めない */
  wallHeight: number;
  /** ゲートを持つ (開度を操作できる) */
  hasGate: boolean;
  /** 川に隣接している必要がある */
  needsWater: boolean;
  /** 建設可能な最大地形傾斜 (m/セル) */
  maxSlope: number;
  /** 水道網に接続する設備か */
  network: boolean;
  /** この水深 (m) を超えると浸水被害を受ける。水際に建てる施設ほど大きい */
  floodTolerance: number;
  color: string;
  label: string;
  desc: string;
  /** ドラッグで連続設置できるか */
  drag: boolean;
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  levee: {
    kind: 'levee',
    name: '堤防',
    nameEn: 'Levee',
    category: 'flood',
    cost: 240,
    upkeep: 0.7,
    wallHeight: 5,
    hasGate: false,
    needsWater: false,
    maxSlope: 99,
    network: false,
    floodTolerance: 0,
    color: '#8d7b5f',
    label: '堤',
    desc: '高さ5mの盛土。越流すると徐々に損傷し、決壊すると一気に浸水する。',
    drag: true,
  },
  dam: {
    kind: 'dam',
    name: 'ダム',
    nameEn: 'Dam',
    category: 'flood',
    cost: 4200,
    upkeep: 11,
    wallHeight: 16,
    hasGate: true,
    needsWater: false,
    maxSlope: 99,
    network: false,
    floodTolerance: 0,
    color: '#9aa3ad',
    label: 'ダ',
    desc: '高さ16mの堰。ゲート開度で放流量を調節し、洪水調節と渇水時の補給を行う。放流量に応じて売電収入。',
    drag: true,
  },
  floodgate: {
    kind: 'floodgate',
    name: '水門',
    nameEn: 'Floodgate',
    category: 'flood',
    cost: 950,
    upkeep: 2.6,
    wallHeight: 7,
    hasGate: true,
    needsWater: false,
    maxSlope: 99,
    network: false,
    floodTolerance: 0,
    color: '#b58b4c',
    label: '門',
    desc: '開閉できる堰。用水路への取水や、逆流防止に使う。',
    drag: true,
  },
  drainpump: {
    kind: 'drainpump',
    name: '排水機場',
    nameEn: 'Drainage Pump',
    category: 'flood',
    cost: 2600,
    upkeep: 9,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 1.8,
    network: false,
    floodTolerance: 1.4,
    color: '#5f8fb5',
    label: '排',
    desc: '半径6セルの内水を強制排除する。堤防の内側に溜まった水を汲み出す最後の砦。',
    drag: false,
  },
  intake: {
    kind: 'intake',
    name: '取水施設',
    nameEn: 'Intake',
    category: 'water',
    cost: 1400,
    upkeep: 4.5,
    wallHeight: 0,
    hasGate: false,
    needsWater: true,
    maxSlope: 2.4,
    network: true,
    floodTolerance: 4.0,
    color: '#3f9bd6',
    label: '取',
    desc: '河川から原水を取水する。川が涸れると取水できない。',
    drag: false,
  },
  treatment: {
    kind: 'treatment',
    name: '浄水場',
    nameEn: 'Water Treatment',
    category: 'water',
    cost: 3400,
    upkeep: 13,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 1.6,
    network: true,
    floodTolerance: 0.45,
    color: '#54c2b8',
    label: '浄',
    desc: '原水を上水に変える。処理能力を超えた分は未処理水として配られ、住民の満足度が下がる。',
    drag: false,
  },
  tower: {
    kind: 'tower',
    name: '配水池',
    nameEn: 'Reservoir Tank',
    category: 'water',
    cost: 2100,
    upkeep: 3.4,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 2.2,
    network: true,
    floodTolerance: 0.5,
    color: '#7fb2e5',
    label: '池',
    desc: '上水を貯めて需要のピークや渇水を凌ぐ。容量 260m³。',
    drag: false,
  },
  pipe: {
    kind: 'pipe',
    name: '水道管',
    nameEn: 'Pipe',
    category: 'water',
    cost: 85,
    upkeep: 0.22,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 3.5,
    network: true,
    floodTolerance: 2.0,
    color: '#4a6b86',
    label: '管',
    desc: '施設と住宅をつなぐ。つながっていない住宅には給水されない。',
    drag: true,
  },
  well: {
    kind: 'well',
    name: '井戸',
    nameEn: 'Well',
    category: 'water',
    cost: 900,
    upkeep: 2.2,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 2.4,
    network: true,
    floodTolerance: 0.5,
    color: '#8f7fd6',
    label: '井',
    desc: '地下水を汲み上げる。処理不要だが量は少なく、渇水で地下水位が下がると弱る。',
    drag: false,
  },
  farm: {
    kind: 'farm',
    name: '畑',
    nameEn: 'Field',
    category: 'agri',
    cost: 420,
    upkeep: 1.1,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 1.5,
    network: false,
    floodTolerance: 0.5,
    color: '#a8b25c',
    label: '畑',
    desc: '湿潤度 35% 以上で育つ。冠水には弱い。',
    drag: true,
  },
  paddy: {
    kind: 'paddy',
    name: '水田',
    nameEn: 'Rice Paddy',
    category: 'agri',
    cost: 600,
    upkeep: 1.6,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 0.85,
    network: false,
    floodTolerance: 1.0,
    color: '#7fbf6a',
    label: '田',
    desc: '湿潤度 80% 以上を要求するが収量が高い。浅い湛水には耐える。',
    drag: true,
  },
  house: {
    kind: 'house',
    name: '住宅',
    nameEn: 'House',
    category: 'city',
    cost: 680,
    upkeep: 1.0,
    wallHeight: 0,
    hasGate: false,
    needsWater: false,
    maxSlope: 1.9,
    network: true,
    floodTolerance: 0.32,
    color: '#e0b060',
    label: '住',
    desc: '最大12人が住む。給水・食料・浸水しない立地が必要。',
    drag: true,
  },
};

export const CATEGORY_LABEL: Record<Category, string> = {
  flood: '治水',
  water: '利水・水道',
  agri: '農業',
  city: '都市',
  terrain: '地形',
};

/** 施設インスタンス */
export interface Building {
  id: number;
  kind: BuildingKind;
  x: number;
  y: number;
  /** 健全度 0..1 */
  hp: number;
  /** ゲート開度 0..1 (1 = 全開) */
  gate: number;
  /** 稼働中か (住民が使えるか) */
  active: boolean;
  /** 水道網の連結成分 ID */
  net: number;
  /** 作物の生育度 0..1 (農地のみ) */
  growth: number;
  /** 入居率 0..1 (住宅のみ) */
  occupancy: number;
  /** 配水池の貯水量 (m^3) */
  stored: number;
  /** 直近の稼働実績 (UI 表示用, m^3/h など) */
  rate: number;
  /** 建設された日 */
  builtDay: number;
}

export const TOWER_CAPACITY = 260; // m^3
export const INTAKE_CAPACITY = 9; // m^3/h
export const TREATMENT_CAPACITY = 14; // m^3/h
export const WELL_CAPACITY = 2.2; // m^3/h
export const DRAINPUMP_RADIUS = 6;
export const DRAINPUMP_RATE = 0.055; // m/ゲーム時間 (半径内の水深をこの分だけ下げる)
