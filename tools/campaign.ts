/**
 * 自動プレイヤーに 2 年ぶん通しでプレイさせ、結果を検証して
 * サンプルセーブデータ (public/saves/sample.json) を書き出す。
 *
 *   npm run campaign
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSeed } from '../src/core/rng';
import { serialize } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';
import { runCampaign } from './autoplay';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../public/saves/sample.json');

const SEED_NAME = process.env.SEED ?? 'hydro-demo';
const DAYS = Number(process.env.DAYS ?? 192); // 2年

const seed = /^\d+$/.test(SEED_NAME) ? Number(SEED_NAME) : hashSeed(SEED_NAME);

console.log(`シード "${SEED_NAME}" (${seed}) の流域を生成中…`);
const t0 = Date.now();
const sim = new Simulation(seed);
console.log(`地形生成 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const report = runCampaign(sim, {
  days: DAYS,
  log: (line) => console.log('  ' + line),
});

/* ------------------------------------------------------------------ */
/* レポート                                                            */
/* ------------------------------------------------------------------ */

console.log('\n── 経過 ──────────────────────────────────────────────');
console.log('  日  季節  人口    資金     給水   食料   流入   浸水  施設');
for (const r of report.history) {
  if (r.day % 8 !== 0 && r.floodedBuildings === 0) continue;
  console.log(
    `${String(r.day).padStart(4)} ${r.season.padEnd(3)} ` +
      `${String(r.population).padStart(5)} ` +
      `${String(r.money).padStart(8)} ` +
      `${String(Math.round(r.waterRatio * 100)).padStart(4)}% ` +
      `${String(r.food).padStart(6)} ` +
      `${r.inflow.toFixed(0).padStart(5)} ` +
      `${String(r.floodedBuildings).padStart(4)} ` +
      `${String(r.buildings).padStart(5)}`,
  );
}

console.log('\n── 結果 ──────────────────────────────────────────────');
console.log(`  プレイ日数        ${report.days} 日 (${(report.days / 96).toFixed(1)} 年)`);
console.log(`  人口              ${report.population} 人`);
console.log(`  資金              ￥${report.money.toLocaleString('ja-JP')} (最低 ￥${report.minMoney.toLocaleString('ja-JP')})`);
console.log(`  運転収支          ${report.operatingBalance > 0 ? '+' : ''}${report.operatingBalance.toFixed(1)} ￥/h (${report.financiallyStable ? '黒字で安定' : '不安定'})`);
console.log(`  給水率の最低値    ${Math.round(report.minWaterRatio * 100)}%`);
console.log(`  食料の最低在庫    ${report.minFood}`);
console.log(`  最大流入量        ${report.peakInflow.toFixed(1)} m³/s`);
console.log(`  氾濫面積 (最大)   ${report.peakFloodedCells} セル`);
console.log(`  浸水した建物 (最大) ${report.maxFloodedBuildings}`);
const lost = Object.entries(report.lostByKind).map(([k, v]) => `${k}×${v}`).join(' ') || 'なし';
console.log(`  失った建物        ${report.buildingsLost} (${lost})`);
console.log(`  うち守るべき施設  ${report.criticalLost} (住宅・上水道・治水施設)`);
console.log(`  堤防の決壊        ${report.leveeBreaches}`);
console.log('  施設:', Object.entries(report.counts).map(([k, v]) => `${k}×${v}`).join(' '));

/* ------------------------------------------------------------------ */
/* 達成判定                                                            */
/* ------------------------------------------------------------------ */

const goals: [string, boolean][] = [
  ['町を大きくできた (人口 400 人以上)', report.population >= 400],
  ['財政が安定している (破産せず、資金が増加傾向)', report.financiallyStable],
  ['利水を達成 (給水率が常に 85% 以上)', report.minWaterRatio >= 0.85],
  ['食料を切らさなかった', report.minFood > 0],
  // 氾濫原の水田が大出水で傷むのは想定内 (遊水地としての性格もある)。
  // 守るべきは人と上水道なので、そこを1つも失っていないことを条件にする。
  ['治水を達成 (住宅・上水道・治水施設を1つも失っていない)', report.criticalLost === 0],
  ['ダム・堤防が決壊していない', report.leveeBreaches === 0],
];

console.log('\n── 達成状況 ──────────────────────────────────────────');
let allOk = true;
for (const [name, ok] of goals) {
  console.log(`  ${ok ? '✔' : '✘'} ${name}`);
  if (!ok) allOk = false;
}

/* ------------------------------------------------------------------ */
/* 書き出し                                                            */
/* ------------------------------------------------------------------ */

const save = serialize(sim, `サンプル: ${report.days}日目の水都 (人口 ${report.population})`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(save));
const kb = (JSON.stringify(save).length / 1024).toFixed(0);
console.log(`\nサンプルセーブを書き出しました: public/saves/sample.json (${kb} KB)`);

if (!allOk) {
  console.error('\n達成できていない目標があります。');
  process.exit(1);
}
