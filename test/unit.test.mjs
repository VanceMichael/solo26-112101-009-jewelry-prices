import assert from 'node:assert/strict';
import { test } from 'node:test';

import { roundFen, fenToYuan, parseLocalRange } from '../src/time.mjs';
import { priceOptions, baseComponents } from '../src/pricing.mjs';
import { parseApplies, parseBrandPage, parseTermsPage, parseSalePage } from '../src/parsers.mjs';
import { quotaSummary } from '../src/ledger.mjs';

test('金额四舍五入到分（half-up），中间过程不提前舍入', () => {
  assert.equal(roundFen(50.16125), 5016);
  assert.equal(roundFen(0.005), 1);
  assert.equal(roundFen(44.4386), 4444);
  assert.equal(fenToYuan(501613), '5016.13');
});

test('夜场本地时段按门店时区换算 UTC，跨日正确', () => {
  const shanghai = parseLocalRange('2026-11-20 21:00 至次日 02:00', 'Asia/Shanghai');
  assert.equal(shanghai.startUtc, '2026-11-20T13:00:00.000Z');
  assert.equal(shanghai.endUtc, '2026-11-20T18:00:00.000Z');
  const bangkok = parseLocalRange('2026-11-20 20:00 至次日 01:00', 'Asia/Bangkok');
  assert.equal(bangkok.startUtc, '2026-11-20T13:00:00.000Z');
  assert.equal(bangkok.endUtc, '2026-11-20T18:00:00.000Z');
});

test('品牌页解析出按生效时刻排序的克价行', () => {
  const html =
    '<table><tr data-identity="B2"><td>2026-11-20T15:30:00Z</td><td>足金</td><td>元/克</td><td>826.50</td></tr>' +
    '<tr data-identity="B1"><td>2026-11-20T10:00:00Z</td><td>足金</td><td>元/克</td><td>852.00</td></tr></table>';
  const parsed = parseBrandPage(html);
  assert.deepEqual(parsed.records.map(r => r.identity), ['B1', 'B2']);
  assert.equal(parsed.records[1].priceYuan, 826.5);
});

test('适用款解析：全部、仅款号、款号加构建代', () => {
  assert.deepEqual(parseApplies('全部足金'), { scope: 'all', models: [] });
  assert.deepEqual(parseApplies('K-12 细链'), {
    scope: 'models',
    models: [{ model: 'K-12', generation: null }],
  });
  assert.deepEqual(parseApplies('PR-2 限 K-12/n7'.replace('PR-2 限 ', '')), {
    scope: 'models',
    models: [{ model: 'K-12', generation: 'n7' }],
  });
});

test('条款页识别排除、限制与明确撤下', () => {
  const html =
    '<p data-batch="41">PR-1 不含 K-12/n8</p><p data-batch="41">PR-2 限 K-12/n7</p><p data-batch="42">PR-2 编号明确撤下</p>';
  const terms = parseTermsPage(html, { path: '/t', observedAt: '2026-11-20T13:00:00Z', batch: '41' });
  assert.equal(terms.rules[0].type, 'excludes');
  assert.equal(terms.rules[1].type, 'limits-to');
  assert.equal(terms.rules[2].type, 'withdrawn');
});

test('活动页解析批次状态、减免类型与排除链接', () => {
  const html =
    '<main><p data-batch="41">发布中</p>' +
    '<table><tr data-id="PR-1"><td>2026-11-20 21:00 至次日 02:00</td><td>每克减 38 元</td><td>全部足金</td><td>可与工费券同用</td></tr>' +
    '<tr data-id="PR-2"><td>2026-11-20 21:00 至次日 02:00</td><td>工费减半</td><td>K-12 细链</td><td>与 PR-1 互斥</td></tr></table>' +
    '<a href="/shops/east/sale/terms">排除条款</a></main>';
  const sale = parseSalePage(html, { path: '/shops/east/sale', observedAt: '2026-11-20T13:00:00Z' });
  assert.equal(sale.coverage, 'publishing');
  assert.equal(sale.batch, '41');
  assert.equal(sale.promotions[0].kind, 'per-gram-reduction');
  assert.equal(sale.promotions[0].value, 38);
  assert.equal(sale.promotions[1].kind, 'labor-discount');
  assert.equal(sale.promotions[1].value, 0.5);
  assert.equal(sale.termLinks[0].href, '/shops/east/sale/terms');
});

test('计价复现票据 Q-A：B1 + n7 按克工费 + 工费减半 = 501613 分', () => {
  const brandRecord = { priceYuan: 852 };
  const design = { model: 'K-12', generation: 'n7', weightGrams: 5.83, karat: '足金' };
  const labor = { generation: 'n7', type: 'per-gram', valueYuan: 16.8 };
  const promotions = [
    {
      promotionId: 'PR-2',
      state: 'cashable',
      kind: 'labor-discount',
      value: 0.5,
      applies: { scope: 'models', models: [{ model: 'K-12', generation: 'n7' }] },
      stackingRaw: '与 PR-1 互斥',
    },
  ];
  const { options } = priceOptions({ brandRecord, design, labor, promotions });
  assert.equal(options[0].amountFen, 506510); // 基础价
  assert.equal(options[1].amountFen, 501613); // 工费减半（即票据 Q-A 金额）
});

test('计价复现票据 Q-B：B1 + n8 按件工费 + 每克减15 = 449888 分', () => {
  const brandRecord = { priceYuan: 852 };
  const design = { model: 'K-12', generation: 'n8', weightGrams: 5.24, karat: '足金' };
  const labor = { generation: 'n8', type: 'per-item', valueYuan: 113 };
  const promotions = [
    {
      promotionId: 'PR-1',
      state: 'cashable',
      kind: 'per-gram-reduction',
      value: 15,
      applies: { scope: 'models', models: [{ model: 'K-12', generation: null }] },
      stackingRaw: '工费照常',
    },
  ];
  const { options } = priceOptions({ brandRecord, design, labor, promotions });
  assert.equal(options[0].amountFen, 457748); // 基础价
  assert.equal(options[1].amountFen, 449888); // 每克减15（即票据 Q-B 金额）
});

test('活动适用款不覆盖构建代时不产生促销口径', () => {
  const design = { model: 'K-12', generation: 'n8', weightGrams: 5.24, karat: '足金' };
  const promotions = [
    {
      promotionId: 'PR-2',
      state: 'cashable',
      kind: 'labor-discount',
      value: 0.5,
      applies: { scope: 'models', models: [{ model: 'K-12', generation: 'n7' }] },
      stackingRaw: '',
    },
  ];
  const { options } = priceOptions({
    brandRecord: { priceYuan: 826.5 },
    design,
    labor: { type: 'per-item', valueYuan: 113 },
    promotions,
  });
  assert.equal(options.length, 1);
  assert.equal(options[0].kind, 'base');
});

test('互斥活动不叠加；多个可选促销要求人工选择', () => {
  const design = { model: 'K-12', generation: 'n7', weightGrams: 5.83, karat: '足金' };
  const promotions = [
    {
      promotionId: 'PR-1',
      state: 'cashable',
      kind: 'per-gram-reduction',
      value: 38,
      applies: { scope: 'all', models: [] },
      stackingRaw: '可与工费券同用',
    },
    {
      promotionId: 'PR-2',
      state: 'cashable',
      kind: 'labor-discount',
      value: 0.5,
      applies: { scope: 'all', models: [] },
      stackingRaw: '与 PR-1 互斥',
    },
  ];
  const { options } = priceOptions({
    brandRecord: { priceYuan: 852 },
    design,
    labor: { type: 'per-gram', valueYuan: 16.8 },
    promotions,
  });
  // 基础价 + 两个单活动；互斥声明使组合不成立。
  assert.equal(options.length, 3);
  assert.ok(options.every(option => option.promotions.length <= 1));
  assert.ok(options.filter(o => o.kind === 'promotion').every(o => o.selectionRequired));
});

test('额度台账：申请释放仍占用，确认释放才回收，兑现计入消耗', () => {
  const ledger = {
    ledgerRevision: 3,
    period: 'E41',
    promotion: 'PR-2',
    limit: 2,
    items: [
      { offerId: 'Q-A', pieces: 1, state: 'release-requested' },
      { offerId: 'Q-C', pieces: 1, state: 'allocated' },
    ],
  };
  const summary = quotaSummary(ledger);
  assert.equal(summary.used, 2);
  assert.equal(summary.available, 0);
  const after = quotaSummary({
    ...ledger,
    ledgerRevision: 4,
    items: [
      { offerId: 'Q-A', pieces: 1, state: 'released' },
      { offerId: 'Q-C', pieces: 1, state: 'redeemed' },
    ],
  });
  assert.equal(after.used, 1);
  assert.equal(after.available, 1);
});

test('基础价构成按克/按件工费分别计算', () => {
  const perGram = baseComponents({
    brandRecord: { priceYuan: 852 },
    design: { weightGrams: 5.83 },
    labor: { type: 'per-gram', valueYuan: 16.8 },
  });
  assert.equal(perGram.laborYuan, 97.944);
  const perItem = baseComponents({
    brandRecord: { priceYuan: 852 },
    design: { weightGrams: 5.24 },
    labor: { type: 'per-item', valueYuan: 113 },
  });
  assert.equal(perItem.laborYuan, 113);
});
