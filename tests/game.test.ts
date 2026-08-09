import { describe, expect, it } from 'vitest';
import { WEATHER } from '../src/config';
import { Simulation } from '../src/sim/simulation';
import { Weather, dayWeather, seasonOfDay } from '../src/sim/weather';

describe('Weather', () => {
  it('同じ日の天気は何度呼んでも同じ (予報が嘘をつかない)', () => {
    const a = dayWeather(42, 37);
    const b = dayWeather(42, 37);
    expect(a).toEqual(b);
    expect(dayWeather(43, 37).rainMm).not.toBe(a.rainMm);
  });

  it('予報した日の天気が、その日になっても一致する', () => {
    const w = new Weather(2024);
    const forecast = w.forecast(5);
    const targetDay = w.day + 3;
    while (w.day < targetDay) w.advanceHour();
    expect(w.today.rainMm).toBeCloseTo(forecast[3].rainMm, 6);
    expect(w.today.kind).toBe(forecast[3].kind);
  });

  it('手動天気にすると、日付に関係なく指定した雨が降り続ける', () => {
    const w = new Weather(2024);
    // 暦では雨の日を選んでも、手動で快晴にしたら降らない
    while (w.today.rainMm < 5) w.advanceHour();
    w.setManual({ kind: 'clear', rainRate: 0, tempC: 25 });
    expect(w.rainRate).toBe(0); // 時刻を進めなくても即座に反映される
    expect(w.today.kind).toBe('clear');
    for (let i = 0; i < 48; i++) {
      w.advanceHour();
      expect(w.rainRate).toBe(0);
    }
    // 逆に、暦を無視して大雨を降らせられる
    w.setManual({ kind: 'heavy', rainRate: 20, tempC: 22 });
    for (let i = 0; i < 24; i++) w.advanceHour();
    expect(w.rainRate).toBe(20);
    expect(w.rain24h()).toBeCloseTo(20 * 24, 3);
  });

  it('手動天気の予報は「解除するまで同じ天気が続く」', () => {
    const w = new Weather(7);
    w.setManual({ kind: 'rain', rainRate: 4, tempC: 18 });
    const fc = w.forecast(7);
    expect(fc).toHaveLength(7);
    expect(new Set(fc.map((d) => d.kind)).size).toBe(1);
    expect(fc.every((d) => d.rainMm === 4 * 24)).toBe(true);
  });

  it('手動で晴れを続ければ渇水になり、解除すれば暦の天気に戻る', () => {
    const w = new Weather(99);
    w.setManual({ kind: 'clear', rainRate: 0, tempC: 28 });
    for (let d = 0; d < 30; d++) for (let h = 0; h < WEATHER.HOURS_PER_DAY; h++) w.advanceHour();
    expect(w.dryDays).toBeGreaterThanOrEqual(WEATHER.DROUGHT_DAYS);
    expect(w.drought).toBe(true);

    w.setManual(null);
    expect(w.manual).toBeNull();
    expect(w.today).toEqual(dayWeather(99, w.day));
  });

  it('手動天気はセーブ/ロードで復元される', () => {
    const w = new Weather(5);
    w.setManual({ kind: 'storm', rainRate: 31, tempC: 24 });
    const saved = w.snapshotState();

    const other = new Weather(5);
    other.restoreState(saved);
    expect(other.manual).toEqual({ kind: 'storm', rainRate: 31, tempC: 24 });
    expect(other.rainRate).toBe(31);

    // 古いセーブ (manual フィールドがない) は暦の天気として読める
    const legacy = new Weather(5);
    legacy.setManual({ kind: 'rain', rainRate: 9, tempC: 20 });
    legacy.restoreState({ day: saved.day, hour: saved.hour, quick: saved.quick, slow: saved.slow, dryDays: saved.dryDays });
    expect(legacy.manual).toBeNull();
  });

  it('梅雨は乾季より雨が多い', () => {
    let tsuyu = 0;
    let winter = 0;
    for (let seed = 0; seed < 40; seed++) {
      for (let d = 24; d <= 35; d++) tsuyu += dayWeather(seed, d).rainMm;
      for (let d = 84; d <= 95; d++) winter += dayWeather(seed, d).rainMm;
    }
    expect(tsuyu).toBeGreaterThan(winter * 1.5);
  });

  it('季節が日付から正しく決まる', () => {
    expect(seasonOfDay(0).id).toBe('spring');
    expect(seasonOfDay(30).id).toBe('tsuyu');
    expect(seasonOfDay(90).id).toBe('winter');
    expect(seasonOfDay(WEATHER.DAYS_PER_YEAR + 30).id).toBe('tsuyu');
  });

  it('雨が降ると数時間遅れて流入量が増える (流域応答)', () => {
    const w = new Weather(777);
    // 雨の多い日まで進める
    let guard = 0;
    while (w.today.rainMm < 40 && guard++ < 4000) w.advanceHour();
    const before = w.inflow;
    for (let i = 0; i < 30; i++) w.advanceHour();
    expect(w.inflow).toBeGreaterThan(before);
  });

  it('雨が降らない期間が続くと渇水になる', () => {
    const w = new Weather(5);
    let droughtSeen = false;
    for (let i = 0; i < 96 * 24 * 2 && !droughtSeen; i++) {
      w.advanceHour();
      if (w.drought) droughtSeen = true;
    }
    expect(droughtSeen).toBe(true);
  });
});

describe('Simulation (統合)', () => {
  it('起動でき、時間を進めても破綻しない', () => {
    const sim = new Simulation(24680, 0.12);
    expect(sim.world.sources.length).toBeGreaterThan(0);

    for (let i = 0; i < 72; i++) sim.stepHour();

    expect(sim.hydro.sanityCheck()).toBe(true);
    expect(Number.isFinite(sim.city.money)).toBe(true);
    expect(sim.snapshot.inflow).toBeGreaterThan(0);
  }, 60000);

  it('建設すると資金が減り、撤去すると一部戻る', () => {
    const sim = new Simulation(1357, 0.12);
    const money0 = sim.city.money;
    // 建設できる場所を探す
    let placed = false;
    for (let y = 4; y < sim.world.h - 4 && !placed; y += 3) {
      for (let x = 4; x < sim.world.w - 4; x += 3) {
        if (sim.build('house', x, y).ok) {
          placed = true;
          expect(sim.city.money).toBeLessThan(money0);
          const afterBuild = sim.city.money;
          expect(sim.bulldoze(x, y).ok).toBe(true);
          expect(sim.city.money).toBeGreaterThan(afterBuild);
          break;
        }
      }
    }
    expect(placed).toBe(true);
  }, 60000);

  it('資金が足りなければ建設できない', () => {
    const sim = new Simulation(999, 0.12);
    sim.city.money = 0;
    let sawRejection = false;
    for (let y = 4; y < 40 && !sawRejection; y += 2) {
      for (let x = 4; x < 40; x += 2) {
        const r = sim.build('house', x, y);
        if (!r.ok && r.message === '資金が足りません') {
          sawRejection = true;
          break;
        }
        expect(r.ok).toBe(false);
      }
    }
    expect(sawRejection).toBe(true);
    expect(sim.world.buildings.size).toBe(0);
  }, 60000);

  it('資金無制限モードでは資金 0 でも建設でき、残高が動かない', () => {
    const sim = new Simulation(999, 0.12);
    sim.city.money = 0;
    sim.city.unlimited = true;

    let spot: { x: number; y: number } | null = null;
    for (let y = 4; y < 40 && !spot; y += 2) {
      for (let x = 4; x < 40; x += 2) {
        if (sim.build('house', x, y).ok) {
          spot = { x, y };
          expect(sim.city.money).toBe(0);
          // 撤去の返金も入らない (残高は固定)
          expect(sim.bulldoze(x, y).ok).toBe(true);
          expect(sim.city.money).toBe(0);
          break;
        }
      }
    }
    expect(spot).not.toBeNull();

    // 維持費でも減らない
    expect(sim.build('house', spot!.x, spot!.y).ok).toBe(true);
    for (let i = 0; i < 24; i++) sim.stepHour();
    expect(sim.city.money).toBe(0);
  }, 60000);

  it('ダムのゲートを閉じると堰の天端が上がる', () => {
    const sim = new Simulation(555, 0.12);
    // 川沿いのセルを探してダムを置く
    let dam = null;
    for (let i = 0; i < sim.world.riverMask.length && !dam; i++) {
      if (!sim.world.riverMask[i]) continue;
      const x = i % sim.world.w;
      const y = (i / sim.world.w) | 0;
      if (x < 3 || y < 3 || x > sim.world.w - 4 || y > sim.world.h - 4) continue;
      sim.city.money = 99999;
      if (sim.build('dam', x, y).ok) dam = sim.world.buildingAt(x, y) ?? null;
    }
    expect(dam).not.toBeNull();
    if (!dam) return;
    const i = sim.world.idx(dam.x, dam.y);
    sim.setGate(dam, 1);
    const open = sim.world.solid[i];
    sim.setGate(dam, 0);
    const closed = sim.world.solid[i];
    expect(closed).toBeGreaterThan(open + 10);
  }, 60000);

  it('掘削で地形が下がり、盛土で上がる', () => {
    const sim = new Simulation(31415, 0.12);
    const x = 30;
    const y = 30;
    const h0 = sim.world.height[sim.world.idx(x, y)];
    expect(sim.terraform(x, y, -1).ok).toBe(true);
    expect(sim.world.height[sim.world.idx(x, y)]).toBeCloseTo(h0 - 1, 4);
    expect(sim.terraform(x, y, 1).ok).toBe(true);
    expect(sim.world.height[sim.world.idx(x, y)]).toBeCloseTo(h0, 4);
  }, 60000);
});
