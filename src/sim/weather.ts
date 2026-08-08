import { WEATHER } from '../config';
import { clamp, hash01, lerp } from '../core/rng';

export type SeasonId = 'spring' | 'tsuyu' | 'summer' | 'autumn' | 'winter';
export type SkyKind = 'clear' | 'cloudy' | 'rain' | 'heavy' | 'storm' | 'snow';

export interface Season {
  id: SeasonId;
  name: string;
  /** 年内の開始日 */
  from: number;
  to: number;
  /** 平均気温 */
  temp: number;
  /** 降雨確率 */
  rainChance: number;
  /** 降ったときの平均日雨量 (mm) */
  rainAmount: number;
  color: string;
}

export const SEASONS: Season[] = [
  { id: 'spring', name: '春', from: 0, to: 23, temp: 15, rainChance: 0.3, rainAmount: 14, color: '#8fd08f' },
  { id: 'tsuyu', name: '梅雨', from: 24, to: 35, temp: 22, rainChance: 0.68, rainAmount: 34, color: '#6fa8d0' },
  { id: 'summer', name: '夏', from: 36, to: 59, temp: 29, rainChance: 0.3, rainAmount: 26, color: '#e2c463' },
  { id: 'autumn', name: '秋', from: 60, to: 83, temp: 19, rainChance: 0.36, rainAmount: 22, color: '#d99a5b' },
  { id: 'winter', name: '冬', from: 84, to: 95, temp: 5, rainChance: 0.22, rainAmount: 9, color: '#a9c6d8' },
];

export function seasonOfDay(day: number): Season {
  const d = ((day % WEATHER.DAYS_PER_YEAR) + WEATHER.DAYS_PER_YEAR) % WEATHER.DAYS_PER_YEAR;
  for (const s of SEASONS) if (d >= s.from && d <= s.to) return s;
  return SEASONS[0];
}

export interface DayWeather {
  day: number;
  season: Season;
  /** 日雨量 (mm) */
  rainMm: number;
  tempC: number;
  kind: SkyKind;
  /** 台風 */
  typhoon: boolean;
}

/**
 * その日の天気は「日番号とシードから決まる純関数」。
 * だから予報は嘘をつかない (プレイヤーは予報を信じて備えられる)。
 */
export function dayWeather(seed: number, day: number): DayWeather {
  const season = seasonOfDay(day);
  const r1 = hash01(day, seed, 1);
  const r2 = hash01(day, seed, 2);
  const r3 = hash01(day, seed, 3);

  // 数日単位でまとまる天気 (前線の通過) を表現するため低周波成分を混ぜる
  const wave =
    Math.sin(day * 0.7 + hash01(Math.floor(day / 6), seed, 7) * 6.28) * 0.5 +
    Math.sin(day * 0.23 + seed * 0.0001) * 0.3;
  const wet = clamp(season.rainChance + wave * 0.22, 0.02, 0.96);

  // 台風: 夏〜秋にまれに発生し、2日にわたる
  const typhoonSeed = hash01(Math.floor(day / 2), seed, 11);
  const typhoonSeason = season.id === 'summer' || season.id === 'autumn';
  const typhoon = typhoonSeason && typhoonSeed > 0.965;

  let rainMm = 0;
  let kind: SkyKind = 'clear';

  if (typhoon) {
    rainMm = 150 + r1 * 190;
    kind = 'storm';
  } else if (r1 < wet) {
    const heavy = r2 * r2;
    rainMm = season.rainAmount * (0.3 + 2.4 * heavy);
    if (season.id === 'tsuyu' && r3 > 0.8) rainMm *= 2.3;
    kind = rainMm > 70 ? 'heavy' : 'rain';
  } else {
    kind = r2 > 0.55 ? 'cloudy' : 'clear';
  }

  let tempC = season.temp + (r3 - 0.5) * 8 + Math.sin(day * 0.4) * 1.5;
  if (rainMm > 0) tempC -= 2;
  if (tempC < 2 && rainMm > 0) kind = 'snow';

  return { day, season, rainMm, tempC, kind, typhoon };
}

export const SKY_LABEL: Record<SkyKind, string> = {
  clear: '晴れ',
  cloudy: 'くもり',
  rain: '雨',
  heavy: '大雨',
  storm: '台風',
  snow: '雪',
};

export const SKY_ICON: Record<SkyKind, string> = {
  clear: '☀',
  cloudy: '☁',
  rain: '☂',
  heavy: '☔',
  storm: '🌀',
  snow: '❄',
};

/* ------------------------------------------------------------------ */
/* 流域応答 (上流のマップ外流域からの流入)                              */
/* ------------------------------------------------------------------ */

export interface WeatherState {
  day: number;
  hour: number;
  year: number;
  today: DayWeather;
  /** 現在の降雨強度 (mm/h) */
  rainRate: number;
  tempC: number;
  /** 源流からの流入量 (m^3/s) */
  inflow: number;
  /** 連続無降雨日数 */
  dryDays: number;
  drought: boolean;
  flooding: boolean;
}

/** 湧水由来の最低流量 (m^3/s) */
const Q_BASE = 2.0;
/** 速い応答 (表面流出) の減衰時定数 (h) */
const TAU_QUICK = 9;
/** 遅い応答 (地下水) の減衰時定数 (h) */
const TAU_SLOW = 520;
/** 貯留量 → 流量 の変換係数。速い成分は非線形にして出水を鋭くする */
const K_QUICK = 0.35;
const EXP_QUICK = 1.35;
const K_SLOW = 0.06;
/** この流量を下回り、かつ無降雨が続くと渇水とみなす (m^3/s) */
const DROUGHT_INFLOW = 6;

export class Weather {
  day = 0;
  hour = 6;
  private quick = 6;
  private slow = 95;
  dryDays = 0;
  rainRate = 0;
  inflow = Q_BASE;
  tempC = 15;
  today: DayWeather;
  /** 過去 24 ゲーム時間の降水量 (mm) */
  private recentRain: number[] = [];

  constructor(private seed: number) {
    this.today = dayWeather(seed, 0);
  }

  get year(): number {
    return Math.floor(this.day / WEATHER.DAYS_PER_YEAR) + 1;
  }

  get dayOfYear(): number {
    return this.day % WEATHER.DAYS_PER_YEAR;
  }

  get season(): Season {
    return this.today.season;
  }

  get drought(): boolean {
    return this.dryDays >= WEATHER.DROUGHT_DAYS && this.inflow < DROUGHT_INFLOW;
  }

  /** 1時間あたりの降雨強度 (mm/h) を求める。日雨量を時間分布に割り振る。 */
  private hourlyRain(day: number, hour: number): number {
    const dw = dayWeather(this.seed, day);
    if (dw.rainMm <= 0) return 0;
    // 降り出しと降り止みの時刻を決めて、その間に山なりに配分する
    const start = hash01(day, this.seed, 21) * 14;
    const span = 4 + hash01(day, this.seed, 22) * (dw.typhoon ? 18 : 12);
    const t = (hour - start) / span;
    if (t < 0 || t > 1) return 0;
    const shape = Math.sin(Math.PI * t);
    // 正規化: sin の平均は 2/π
    const mean = 2 / Math.PI;
    const noise = 0.7 + hash01(day * 24 + hour, this.seed, 31) * 0.6;
    return (dw.rainMm / span) * (shape / mean) * noise;
  }

  /** 1ゲーム時間進める */
  advanceHour(): void {
    this.hour += 1;
    if (this.hour >= WEATHER.HOURS_PER_DAY) {
      this.hour = 0;
      this.day += 1;
      const prev = dayWeather(this.seed, this.day - 1);
      this.dryDays = prev.rainMm < 1 ? this.dryDays + 1 : 0;
      this.today = dayWeather(this.seed, this.day);
    }

    this.rainRate = this.hourlyRain(this.day, this.hour);
    this.tempC = this.today.tempC + Math.sin(((this.hour - 9) / 24) * Math.PI * 2) * 4;

    this.recentRain.push(this.rainRate);
    if (this.recentRain.length > 24) this.recentRain.shift();

    // 流域貯留の更新 (マップ外の上流域が受けた雨も含む)
    const catchmentRain = this.rainRate * 1.35;
    this.quick += catchmentRain * 0.62;
    this.slow += catchmentRain * 0.38;
    this.quick *= Math.exp(-1 / TAU_QUICK);
    this.slow *= Math.exp(-1 / TAU_SLOW);

    const dryFactor = clamp(1 - this.dryDays / 26, 0.28, 1);
    this.inflow = Q_BASE * dryFactor + K_QUICK * Math.pow(this.quick, EXP_QUICK) + this.slow * K_SLOW;
  }

  /** セーブ用の内部状態 (流域貯留は復元しないと洪水/渇水の位相がずれる) */
  snapshotState(): { day: number; hour: number; quick: number; slow: number; dryDays: number } {
    return {
      day: this.day,
      hour: this.hour,
      quick: this.quick,
      slow: this.slow,
      dryDays: this.dryDays,
    };
  }

  restoreState(s: { day: number; hour: number; quick: number; slow: number; dryDays: number }): void {
    this.day = s.day;
    this.hour = s.hour;
    this.quick = s.quick;
    this.slow = s.slow;
    this.dryDays = s.dryDays;
    this.today = dayWeather(this.seed, this.day);
    this.rainRate = this.hourlyRain(this.day, this.hour);
    this.tempC = this.today.tempC;
    this.recentRain = [];
    this.inflow =
      Q_BASE * clamp(1 - this.dryDays / 26, 0.28, 1) +
      K_QUICK * Math.pow(this.quick, EXP_QUICK) +
      this.slow * K_SLOW;
  }

  /** 直近24時間の積算雨量 (mm) */
  rain24h(): number {
    return this.recentRain.reduce((a, b) => a + b, 0);
  }

  /** 蒸発の強さ (気温依存) */
  evapScale(): number {
    return clamp(0.25 + this.tempC / 26, 0.1, 2.2);
  }

  /** これから FORECAST_DAYS 日ぶんの予報 */
  forecast(days = WEATHER.FORECAST_DAYS): DayWeather[] {
    const out: DayWeather[] = [];
    for (let d = 0; d < days; d++) out.push(dayWeather(this.seed, this.day + d));
    return out;
  }

  /** 予想される最大流入量 (今後 days 日) — 警報の根拠に使う */
  forecastPeakInflow(days = 3): number {
    let quick = this.quick;
    let slow = this.slow;
    let peak = this.inflow;
    for (let d = 0; d < days; d++) {
      const dw = dayWeather(this.seed, this.day + d);
      for (let h = 0; h < 24; h++) {
        const r = d === 0 && h < this.hour ? 0 : this.hourlyRain(this.day + d, h);
        const cr = r * 1.35;
        quick = (quick + cr * 0.62) * Math.exp(-1 / TAU_QUICK);
        slow = (slow + cr * 0.38) * Math.exp(-1 / TAU_SLOW);
        const q = Q_BASE + K_QUICK * Math.pow(quick, EXP_QUICK) + slow * K_SLOW;
        if (q > peak) peak = q;
      }
      void dw;
    }
    return peak;
  }

  timeLabel(): string {
    return `${String(this.hour).padStart(2, '0')}:00`;
  }

  dateLabel(): string {
    const doy = this.dayOfYear;
    return `${this.year}年目 ${doy + 1}日 (${this.season.name})`;
  }

  state(): WeatherState {
    return {
      day: this.day,
      hour: this.hour,
      year: this.year,
      today: this.today,
      rainRate: this.rainRate,
      tempC: this.tempC,
      inflow: this.inflow,
      dryDays: this.dryDays,
      drought: this.drought,
      flooding: this.inflow > 90,
    };
  }
}

/** 流量 (m^3/s) を人が読める規模の言葉に */
export function inflowLabel(q: number): string {
  if (q < 6) return '渇水';
  if (q < 20) return '平水';
  if (q < 45) return '増水';
  if (q < 95) return '警戒';
  return '氾濫危険';
}

export function lerpColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
  const bl = Math.round(lerp(pa & 255, pb & 255, t));
  return `rgb(${r},${g},${bl})`;
}
