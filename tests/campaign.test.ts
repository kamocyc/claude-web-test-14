import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { runCampaign, type CampaignReport } from '../tools/autoplay';

/**
 * 「何もない状態から実際に町を作れるか」の検証。
 * 完全版 (2年) は `npm run campaign` で走らせる。ここでは 40 日ぶんだけ回して、
 * 立ち上がりが成立していることを確認する。
 */
describe('自動プレイ (立ち上げ)', () => {
  let report: CampaignReport;

  beforeAll(() => {
    const sim = new Simulation(20260808, 0.2);
    report = runCampaign(sim, { days: 40 });
  }, 600000);

  it('上水道を敷いて人が住み始める', () => {
    expect(report.population).toBeGreaterThan(150);
    expect(report.counts['取水施設']).toBeGreaterThan(0);
    expect(report.counts['浄水場']).toBeGreaterThan(0);
    expect(report.counts['住宅']).toBeGreaterThan(10);
  });

  it('給水が需要に追いついている', () => {
    expect(report.minWaterRatio).toBeGreaterThan(0.9);
  });

  it('農地を拓いて食料を切らさない', () => {
    expect(report.counts['水田'] ?? 0).toBeGreaterThan(0);
    expect(report.minFood).toBeGreaterThan(0);
  });

  it('破産しない', () => {
    expect(report.minMoney).toBeGreaterThan(0);
  });

  it('立ち上げ期に住宅・上水道を失わない', () => {
    // 氾濫原の田畑が大出水で傷むのは想定内。守るべきは人と上水道。
    expect(report.criticalLost).toBe(0);
    expect(report.leveeBreaches).toBe(0);
  });

  it('人口が単調に増えていく', () => {
    const early = report.history[8].population;
    const late = report.history[report.history.length - 1].population;
    expect(late).toBeGreaterThan(early);
  });
});
