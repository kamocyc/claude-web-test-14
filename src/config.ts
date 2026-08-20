/**
 * ゲーム全体のチューニング定数。
 * 単位系: 長さ = メートル, 時間 = ゲーム内時間 (h) もしくは水理計算用の秒 (hydro-sec)。
 */

/** マップ一辺のセル数 (正方形) */
export const MAP = 192;
/** 1セルの一辺 (m) */
export const CELL = 12;
/** セル面積 (m^2) */
export const CELL_AREA = CELL * CELL;
/** 総セル数 */
export const N_CELLS = MAP * MAP;
/** 海水面の標高 (m) */
export const SEA_LEVEL = 0;

/* ------------------------------------------------------------------ */
/* 水理シミュレーション (Virtual Pipes / 浅水近似)                      */
/* ------------------------------------------------------------------ */

/**
 * 時間について:
 * このマップは河川の「一区間」(約2.3km) を切り出したもので、上流の広大な流域は
 * マップ外にある。したがって洪水の主因は源流セルからの流入量 (m^3/s) であり、
 * 直接降雨による地表流出はそれを補助する形で扱う。
 * 水理計算は独自の時間 (hydro-sec) で回り、1 ゲーム時間 = DT * STEPS_PER_HOUR
 * hydro-sec に対応する (= 実河川より圧縮された時間軸)。
 */
export const HYDRO = {
  /** 重力加速度 */
  G: 9.81,
  /** 仮想パイプ断面積係数 (大きいほど水が速く動く) */
  PIPE_AREA: CELL * 1.0,
  /** パイプ長 = セルサイズ */
  PIPE_LEN: CELL,
  /** 1 水理ステップの dt (hydro-sec) */
  DT: 2.0,
  /** 1 ゲーム時間 (h) あたりに回す水理ステップ数 */
  STEPS_PER_HOUR: 36,
  /** 流束の減衰 (数値的な発散防止 & 摩擦の代用) */
  DAMPING: 0.9,
  /** マップ外 (海) との交換係数 (1/hydro-sec) */
  BOUNDARY_K: 0.35,
  /** これ以下の水深は描画・判定上「無し」とみなす (m) */
  EPS_DEPTH: 0.012,
  /** 蒸発量 (m / ゲーム時間) を気温 25℃ 基準で */
  EVAP_BASE: 0.00022,
  /** 地面への浸透速度 (m / ゲーム時間) */
  INFILTRATION: 0.0026,
  /** 土壌の最大保水量 (m 換算) */
  SOIL_CAPACITY: 0.42,
  /** 地下水が河川へ戻る割合 (/ゲーム時間) */
  BASEFLOW_RATE: 0.0075,
};

/** 1ゲーム時間に対応する水理時間 (hydro-sec) */
export const HOUR_HYDRO_SECONDS = HYDRO.DT * HYDRO.STEPS_PER_HOUR;

/**
 * 時間圧縮率。
 * ゲーム内の1時間を HOUR_HYDRO_SECONDS 秒ぶんの水理計算で表現しているので、
 * 「1時間あたり◯m^3」で与えられる量 (降雨・地下水流出) を流量 (m^3/s) に
 * 直すときは 3600 で割る。こうすると河川流量と降雨量が同じ物差しに乗る。
 */
export const TIME_COMPRESSION = HOUR_HYDRO_SECONDS / 3600;

/* ------------------------------------------------------------------ */
/* 灌漑 (Timberborn 方式の湿潤伝播)                                     */
/* ------------------------------------------------------------------ */

export const IRRIGATION = {
  /** 水源とみなす最低水深 (m) */
  SOURCE_DEPTH: 0.05,
  /** 最大伝播距離 (セル) */
  RANGE: 11,
  /** 水面より何 m 高い所まで湿らせられるか (段丘を登れる高さ) */
  CLIMB: 2.6,
  /** 乾燥時に湿潤が抜けていく速さ (/ゲーム時間) */
  DRY_RATE: 0.055,
  /** 湿潤が回復する速さ (/ゲーム時間) */
  WET_RATE: 0.32,
};

/* ------------------------------------------------------------------ */
/* 気象                                                                */
/* ------------------------------------------------------------------ */

export const WEATHER = {
  /** 1年の日数 */
  DAYS_PER_YEAR: 96,
  /** 1日の時間数 */
  HOURS_PER_DAY: 24,
  /** 降雨のうち地表流出になる割合 (残りは浸透) */
  RUNOFF_RATIO: 0.42,
  /** 予報を出せる日数 */
  FORECAST_DAYS: 7,
  /** 連続無降雨がこの日数を超えると渇水 */
  DROUGHT_DAYS: 9,
};

/* ------------------------------------------------------------------ */
/* 都市・経済                                                          */
/* ------------------------------------------------------------------ */

export const CITY = {
  START_MONEY: 30000,
  /** 住宅1棟の定員 */
  HOUSE_CAPACITY: 12,
  /** 1人あたりの水需要 (m^3 / ゲーム時間) */
  WATER_PER_CAPITA: 0.006,
  /** 1人あたりの食料消費 (units / ゲーム時間) */
  FOOD_PER_CAPITA: 0.0016,
  /**
   * 1人あたりの税収 (￥ / ゲーム時間)。
   * 住宅1棟 (12人) で 3.6￥/h の収入に対し維持費 0.8￥/h なので、
   * 町を大きくするほど儲かる (規模の経済) が、上水道の固定費を賄うには
   * ある程度の人口が要る、というバランスにしてある。
   */
  TAX_PER_CAPITA: 0.3,
  /** 余剰food の出荷能力 (units / ゲーム時間) */
  FOOD_SHIP_RATE: 0.8,
  /** 食料の販売単価 (￥ / unit) */
  FOOD_PRICE: 3.5,
  /** 人口の変化速度 */
  GROWTH_RATE: 0.02,
  /** 浸水がこの深さを超えると建物が損傷 (m) */
  FLOOD_DAMAGE_DEPTH: 0.32,
  /** 損傷速度 (hp / ゲーム時間 / 超過1m) */
  FLOOD_DAMAGE_RATE: 0.11,
  /** 修復速度 (hp / ゲーム時間) */
  REPAIR_RATE: 0.02,
};

/** 時間倍率のプリセット */
export const SPEEDS = [0, 1, 3, 8] as const;

/** 実時間1秒あたりに進むゲーム時間 (h) — 速度1倍のとき */
export const HOURS_PER_REAL_SEC = 1.1;

/* ------------------------------------------------------------------ */
/* ボクセル表示 (Timberborn 方式)                                       */
/* ------------------------------------------------------------------ */

/**
 * 地形をブロックの積み重ねとして描くための設定。
 *
 * 現状 `enabled` が効くのは**描画だけ**で、シミュレーションは連続標高の
 * まま回っている。`quantizeTerrainData` を true にすると `World.height`
 * 自体を格子へ丸める (地形生成・灌漑・建設判定にまで影響が及ぶので、
 * 有効化するときは README の「ボクセル表示」節の但し書きを読むこと)。
 */
export const VOXEL = {
  /** 描画をボクセル化する */
  enabled: true,
  /** ブロック1個の高さ (m) */
  SIZE: 3,
  /** 地形データそのものを格子へ丸める (未実装のフェーズ2) */
  quantizeTerrainData: false,
};

/**
 * 標高をボクセル格子へ丸める。
 *
 * GLSL 側 (`VOXEL_GLSL` の `voxelH`) と**完全に同じ値**を返す必要がある。
 * `Math.round(x)` と `floor(x + 0.5)` は負値も含めて一致するので、両者が
 * ずれてオブジェクトがブロックから浮くことはない。
 *
 * 切り捨て (floor) ではなく四捨五入なのは、マップ全体が平均 SIZE/2 だけ
 * 沈んで海岸線が動いてしまうのを避けるため。
 */
export function voxelH(h: number): number {
  return VOXEL.enabled ? Math.round(h / VOXEL.SIZE) * VOXEL.SIZE : h;
}

/**
 * 1セルの一辺に並べるブロック数。
 *
 * 高さは uVScale 倍して描くので、3m のブロックは既定 (1.45倍) では画面上
 * 4.35m の高さに見える。目地を 3m 間隔で引くと立方体ではなく縦長のレンガに
 * なってしまうので、**目地の間隔を1段の見かけの高さに合わせる**。
 * こうすると強調率スライダをどこに動かしてもブロックが立方体に見え、かつ
 * セルの一辺を割り切るので目地がセル境界と必ず揃う。
 */
export function voxelBlocksPerCell(vscale: number): number {
  // 目地はセルの一辺を割り切る必要がある (割り切らないと目地がセル境界を
  // またいでずれる) ので、ブロック数は整数。ただの四捨五入だと 2個 → 1個の
  // 段でブロックが一気に横長になるため、**比で近いほう**を選ぶ。
  const ideal = CELL / (VOXEL.SIZE * vscale);
  const lo = Math.max(1, Math.floor(ideal));
  const hi = lo + 1;
  return ideal / lo <= hi / ideal ? lo : hi;
}

/**
 * 表示上の水面標高 (m)。
 *
 * 地形を丸めた分だけ河床も上がるので、素の `solid + water` のままだと
 * 丸め上がったブロックの中に水面が埋もれてしまう。GLSL 側 `cellWater()` と
 * 同じ式で、必ずブロック上面より上に出す。
 * 堤防・ダムによる嵩上げ (solid - height) は丸めずそのまま足す。
 */
export function voxelLevel(height: number, solid: number, water: number): number {
  if (!VOXEL.enabled) return solid + water;
  const bed = voxelH(height) + (solid - height);
  return Math.max(solid + water, bed + (water > 0.006 ? 0.06 : 0));
}
