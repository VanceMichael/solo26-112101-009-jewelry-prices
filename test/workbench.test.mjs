import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';

import { startSources } from '../sources/server.mjs';
import { Workbench } from '../src/workbench.mjs';
import { startWorkbench } from '../src/server.mjs';

class FakeClock {
  constructor(initial) {
    this.t = Date.parse(initial);
  }
  tick(ms) {
    this.t += ms;
  }
  date() {
    return new Date(this.t);
  }
}

async function setup() {
  const source = await startSources(0);
  const clockHolder = new FakeClock('2026-11-20T13:00:00Z');
  const bench = new Workbench({ sourceUrl: source.url, clock: () => clockHolder.date() });
  const seeded = JSON.parse(
    await readFile(new URL('../data/issued-offers.json', import.meta.url)),
  );
  bench.loadSeedOffers(seeded);
  async function collect(stage, history = [{ shop: 'east', issue: 40 }]) {
    await fetch(`${source.url}/scenario/${stage}`, { method: 'POST' });
    clockHolder.tick(60_000);
    return bench.collect({ history });
  }
  return { source, bench, clockHolder, collect };
}

test('initial：批次发布中且排除页未到，东店 n8 只能报公开基础价并附等待原因', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    const quote = bench.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T16:00:00Z' });
    assert.equal(quote.cashable, true);
    assert.equal(quote.design.generation, 'n8');
    assert.equal(quote.baseOnly, true);
    assert.deepEqual(quote.options.map(o => o.kind), ['base']);
    assert.equal(quote.base.amountFen, 444386);
    assert.equal(quote.promotions.evidencePending[0].promotionId, 'PR-1');
    assert.equal(
      quote.waitingReasons.some(f => f.code === 'promotion-evidence-pending'),
      true,
    );
    // 历史刊 PR-2 锁定 n7：对 n8 是已证实不适用，而不是可兑现。
    assert.equal(quote.promotions.inapplicable[0].promotionId, 'PR-2');
    assert.equal(quote.promotions.inapplicable[0].state, 'excluded');
  } finally {
    await source.close();
  }
});

test('initial：历史刊 n7 活动对仍在售的 n7 规格可兑现并复现 Q-A 金额', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    const quote = bench.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T14:41:00Z' });
    assert.equal(quote.design.generation, 'n7');
    const promo = quote.options.find(o => o.promotions.includes('PR-2'));
    assert.equal(promo.amountFen, 501613);
    assert.equal(quote.options[0].amountFen, 506510);
  } finally {
    await source.close();
  }
});

test('initial：西店夜场按曼谷时区换算，PR-1 每克减15，复现 Q-B 金额', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial', []);
    const quote = bench.quote({ shop: 'west', model: 'K-12', at: '2026-11-20T14:30:00Z' });
    assert.equal(quote.design.generation, 'n7');
    const promo = quote.options.find(o => o.promotions.includes('PR-1'));
    assert.equal(promo.amountFen, 497765);
    assert.equal(quote.promotions.cashable[0].window.startUtc, '2026-11-20T13:00:00.000Z');
  } finally {
    await source.close();
  }
});

test('published：排除页到齐后，PR-1 排除 n8、PR-2 限 n7，东店 n8 仍仅基础价', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    await collect('published');
    const quote = bench.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T16:00:00Z' });
    assert.deepEqual(quote.options.map(o => o.kind), ['base']);
    const states = Object.fromEntries(
      quote.promotions.inapplicable.map(p => [p.promotionId, p.state]),
    );
    assert.equal(states['PR-1'], 'excluded');
    assert.equal(states['PR-2'], 'excluded');
  } finally {
    await source.close();
  }
});

test('published：S-4 全足金可享 PR-1，每克减38正确计价', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    await collect('published');
    const quote = bench.quote({ shop: 'east', model: 'S-4', at: '2026-11-20T14:30:00Z' });
    const promo = quote.options.find(o => o.promotions.includes('PR-1'));
    assert.equal(promo.amountFen, 317373);
    assert.equal(quote.options[0].amountFen, 331851);
  } finally {
    await source.close();
  }
});

test('额度：修订冲突后回读最新台账，额度已满时拒绝新票据，不猜测占用', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    await collect('published');
    const quota = await bench.quota('east');
    assert.equal(quota.available, 0);
    const result = await bench.issueOffer({
      shop: 'east',
      model: 'S-4',
      at: '2026-11-20T14:30:00Z',
      promotionIds: ['PR-2'],
    });
    assert.equal(result.created, false);
    // 指定活动不可静默降级为基础价。
    assert.equal(result.reason, 'option-not-available');
  } finally {
    await source.close();
  }
});

test('额度：西店 POST 仅 202 收件，回查未见登记则转人工，不出票', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial', []);
    const result = await bench.issueOffer({
      shop: 'west',
      model: 'K-12',
      at: '2026-11-20T14:30:00Z',
      promotionIds: ['PR-1'],
    });
    assert.equal(result.created, false);
    assert.equal(result.reason, 'needs-manual-check');
  } finally {
    await source.close();
  }
});

test('clarified：绑定票号的撤销确认停止 Q-A 兑现，Q-B 仍按原凭据', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    await collect('published');
    await collect('clarified');
    const qa = bench.offerStatus('Q-A', '2026-11-20T16:20:00Z');
    assert.equal(qa.status, 'stopped');
    assert.equal(qa.honoredPerOriginalBasis, false);
    const qb = bench.offerStatus('Q-B', '2026-11-20T16:20:00Z');
    assert.equal(qb.status, 'honorable');
    assert.equal(qb.honoredPerOriginalBasis, true);
    // 撤销确认之前，Q-A 仍按原凭据可兑现。
    assert.equal(bench.offerStatus('Q-A', '2026-11-20T16:05:00Z').status, 'honorable');
  } finally {
    await source.close();
  }
});

test('clarified：PR-2 被明确撤下且店员 end，新报价不再出现 PR-2 可兑现口径', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    await collect('published');
    await collect('clarified');
    const quote = bench.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T14:41:00Z' });
    assert.equal(quote.design.generation, 'n7');
    const pr2 = quote.promotions.inapplicable.find(p => p.promotionId === 'PR-2');
    assert.ok(pr2);
    assert.equal(pr2.state, 'withdrawn');
    assert.ok(pr2.reasons.some(r => r.code === 'terms-withdrawn' || r.code === 'clarified-end'));
  } finally {
    await source.close();
  }
});

test('复核：资料更正产生价差进入人工联系队列并附更正出处，票据仍按原凭据', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    await collect('published');
    await collect('clarified');
    const review = await bench.review('2026-11-20T16:20:00Z');
    const qb = review.manualContactQueue.find(r => r.offerId === 'Q-B');
    assert.ok(qb);
    assert.equal(qb.diffFen, -5502); // B1→B2 品牌降价
    assert.equal(qb.honorablePerOriginal, true);
    const sourcePaths = JSON.stringify(qb.findings[0].currentSources);
    assert.ok(sourcePaths.includes('/brands/yun/gold'));
    assert.ok(sourcePaths.includes('/shops/clarifications'));
  } finally {
    await source.close();
  }
});

test('clarified：西店店员 extend 延长活动窗口，窗口事实与适用款范围正交', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial', []);
    await collect('clarified', []);
    // 原窗口 13:00–18:00Z，extend 至 19:15Z；18:30 仍在窗口内。
    const inside = bench.quote({ shop: 'west', model: 'K-12', at: '2026-11-20T18:30:00Z' });
    const promo = inside.promotions.inapplicable[0];
    assert.equal(promo.promotionId, 'PR-1');
    assert.equal(promo.inWindow, true); // extend 生效
    assert.equal(promo.scopeMatched, false); // 但公告锁 n7，当前款为 n8
    // 19:30 已过 extend 后的窗口。
    const after = bench.quote({ shop: 'west', model: 'K-12', at: '2026-11-20T19:30:00Z' });
    assert.equal(after.promotions.inapplicable[0].inWindow, false);
  } finally {
    await source.close();
  }
});

test('店员核定越权改写品牌价被拒绝并留痕，合法 end 仍生效', async () => {
  const { source, bench, clockHolder, collect } = await setup();
  try {
    await collect('initial');
    // 直接注入一条含品牌价字段的非法核定与一条合法核定。
    bench.catalog.ingestClarification(
      {
        batch: 99,
        items: [
          { source: 'east', appliesTo: 'PR-1', action: 'end', effectiveAt: '2026-11-20T15:00:00Z' },
          { source: 'east', appliesTo: 'B2', action: 'end', priceYuan: 1 },
        ],
      },
      clockHolder.date().toISOString(),
    );
    assert.equal(bench.catalog.rejectedClarifications[0].rejected[0].problems[0], 'cannot-override-brand-price');
    const accepted = bench.catalog.clarificationSnapshots.at(-1).items;
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].appliesTo, 'PR-1');
  } finally {
    await source.close();
  }
});

test('复盘：区分当时未采到与当前已证实不适用，并能重看票据凭据', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    const early = bench.evidence({
      shop: 'east',
      model: 'K-12',
      at: '2026-11-20T13:01:30Z',
      offerId: 'Q-A',
    });
    const termsObs = early.observations.filter(o => o.kind === 'terms');
    assert.equal(termsObs[0].available, false);
    assert.equal(termsObs[0].reason, 'exclusion-page-pending');
    assert.equal(early.offer.offerId, 'Q-A');

    await collect('published');
    await collect('clarified');
    const later = bench.evidence({ shop: 'east', model: 'K-12', at: '2026-11-20T13:03:30Z' });
    const withdrawn = later.currentQuote.promotions.inapplicable.find(p => p.promotionId === 'PR-2');
    assert.equal(withdrawn.state, 'withdrawn');
  } finally {
    await source.close();
  }
});

test('同门店串行、不同门店并发：票据票号不冲突，门店台账相互独立', async () => {
  const { source, bench, collect } = await setup();
  try {
    await collect('initial');
    const [a, b, c] = await Promise.all([
      bench.issueOffer({ shop: 'east', model: 'S-4', at: '2026-11-20T14:30:00Z' }),
      bench.issueOffer({ shop: 'east', model: 'S-4', at: '2026-11-20T14:31:00Z' }),
      bench.issueOffer({ shop: 'west', model: 'K-12', at: '2026-11-20T14:32:00Z' }),
    ]);
    const ids = [a, b].filter(r => r.created).map(r => r.offer.offerId);
    assert.equal(new Set(ids).size, ids.length);
    const east = await bench.quota('east');
    const west = await bench.quota('west');
    assert.notEqual(east.promotion, west.promotion);
  } finally {
    await source.close();
  }
});

test('持久化：落盘后重开工作台，票据与档案完整恢复', async () => {
  const source = await startSources(0);
  const stateFile = new URL('../state/test-workbench.json', import.meta.url).pathname;
  try {
    const holder1 = new FakeClock('2026-11-20T13:00:00Z');
    const first = new Workbench({ sourceUrl: source.url, clock: () => holder1.date(), stateFile });
    first.loadSeedOffers(
      JSON.parse(await readFile(new URL('../data/issued-offers.json', import.meta.url))),
    );
    await fetch(`${source.url}/scenario/initial`, { method: 'POST' });
    holder1.tick(60_000);
    await first.collect({ history: [{ shop: 'east', issue: 40 }] });
    await first.save();

    const reopened = new Workbench({ sourceUrl: source.url, stateFile });
    assert.equal(await reopened.load(), true);
    assert.equal(reopened.offers.offers.has('Q-A'), true);
    const quote = reopened.quote({ shop: 'east', model: 'K-12', at: '2026-11-20T14:41:00Z' });
    assert.equal(quote.options[0].amountFen, 506510);
  } finally {
    await rm(new URL('../state/', import.meta.url).pathname, { recursive: true, force: true });
    await source.close();
  }
});

test('HTTP 服务：采集、报价、票据状态端到端可用', async () => {
  const source = await startSources(0);
  try {
    const holder = new FakeClock('2026-11-20T13:00:00Z');
    const service = await startWorkbench({
      sourceUrl: source.url,
      clock: () => holder.date(),
      seedOffersFile: new URL('../data/issued-offers.json', import.meta.url),
    });
    await fetch(`${source.url}/scenario/initial`, { method: 'POST' });
    holder.tick(60_000);
    const collect = await fetch(`${service.url}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ shop: 'east', issue: 40 }] }),
    });
    assert.equal(collect.status, 200);
    const quoteResponse = await fetch(
      `${service.url}/quote?shop=east&model=K-12&at=2026-11-20T16:00:00Z`,
    );
    const quote = await quoteResponse.json();
    assert.equal(quote.baseOnly, true);
    const offerResponse = await fetch(`${service.url}/offers/Q-A?at=2026-11-20T16:00:00Z`);
    const offer = await offerResponse.json();
    assert.equal(offer.status, 'honorable');
    await service.close();
  } finally {
    await source.close();
  }
});
