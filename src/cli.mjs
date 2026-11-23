// 命令行演练入口：在一次性进程内启动来源 + 工作台，跑完整业务剧本并打印结论。
// 用法：node src/cli.mjs            （使用固定时钟复现 2026-11-20 的剧本）

import { readFile } from 'node:fs/promises';
import { startSources } from '../sources/server.mjs';
import { startWorkbench } from './server.mjs';

// 可控时钟：采集逐阶段推进，保证“观察时刻 <= 查询时刻”的时点视图语义。
class FakeClock {
  constructor(initial) {
    this.now = Date.parse(initial);
  }
  tick(ms) {
    this.now += ms;
  }
  date() {
    return new Date(this.now);
  }
}

const clockHolder = new FakeClock('2026-11-20T13:00:00Z');
const clock = () => clockHolder.date();

async function scenario(source, bench, stage) {
  await fetch(`${source.url}/scenario/${stage}`, { method: 'POST' });
  clockHolder.tick(60_000); // 每次采集推进 1 分钟，观察时刻严格递增
  const collected = await bench.collect({ history: [{ shop: 'east', issue: 40 }] });
  return collected;
}

const source = await startSources(0);
const service = await startWorkbench({ sourceUrl: source.url, clock });
const bench = service.bench;
bench.loadSeedOffers(JSON.parse(await readFile(new URL('../data/issued-offers.json', import.meta.url))));

console.log('=== initial 阶段采集（东店批次41发布中、排除页425） ===');
console.log(JSON.stringify(await scenario(source, bench, 'initial'), null, 2));

console.log('\n=== 顾客查东店 K-12 @16:00Z（只应得到基础价+等待原因） ===');
console.log(JSON.stringify(bench.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T16:00:00Z' }), null, 2));

console.log('\n=== 票据 Q-A / Q-B 状态 @16:00Z ===');
console.log(JSON.stringify(bench.offerStatus('Q-A', '2026-11-20T16:00:00Z'), null, 2));
console.log(JSON.stringify(bench.offerStatus('Q-B', '2026-11-20T16:00:00Z'), null, 2));

console.log('\n=== published 阶段（排除页到齐） ===');
console.log(JSON.stringify(await scenario(source, bench, 'published'), null, 2));
console.log('\n=== 东店 K-12 报价（PR-1 排除 n8，仅基础价可兑现） ===');
console.log(JSON.stringify(bench.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T16:00:00Z' }).options, null, 2));

console.log('\n=== 西店 K-12 夜场报价（曼谷时区，PR-1 每克减15） ===');
console.log(JSON.stringify(bench.quote({ shop: 'west', model: 'K-12', at: '2026-11-20T14:30:00Z' }), null, 2));

console.log('\n=== 东店额度占用协商（台账修订冲突 → 回读 → 额度已满） ===');
console.log(JSON.stringify(await bench.quota('east'), null, 2));
console.log(JSON.stringify(await bench.issueOffer({
  shop: 'east',
  model: 'S-4',
  at: '2026-11-20T14:30:00Z',
  promotionIds: ['PR-2'],
}), null, 2));

console.log('\n=== clarified 阶段（PR-2 撤下、Q-A 停止兑现、台账 release-requested→released） ===');
console.log(JSON.stringify(await scenario(source, bench, 'clarified'), null, 2));
console.log('\n=== 人工联系队列（价差与更正出处） ===');
console.log(JSON.stringify(await bench.review('2026-11-20T16:20:00Z'), null, 2));
console.log('\n=== Q-A 现已停止兑现；Q-B 仍按原凭据 ===');
console.log(JSON.stringify(bench.offerStatus('Q-A', '2026-11-20T16:20:00Z'), null, 2));
console.log(JSON.stringify(bench.offerStatus('Q-B', '2026-11-20T16:20:00Z'), null, 2));

await service.close();
await source.close();
