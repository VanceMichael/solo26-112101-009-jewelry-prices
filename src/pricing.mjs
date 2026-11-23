// 计价引擎：纯函数。输入已证实的克价、规格、工费与可兑现活动，输出以分计的候选报价。
// 规则：
//  - 最终结果才做四舍五入到分，中间过程保留完整精度；
//  - 互斥/叠加完全按公告文本（“与 PR-x 互斥”“可与…同用”）；
//  - 公告未说明两个可选折扣由谁选择时，不默认承诺，标记 selectionRequired。

import { roundFen } from './time.mjs';

const MUTEX_PATTERN = /与\s*(PR-\d+)\s*互斥/;

function isMutex(promotion, otherId) {
  const match = MUTEX_PATTERN.exec(promotion.stackingRaw ?? '');
  return match !== null && match[1] === otherId;
}

function pairMutex(a, b) {
  return isMutex(a, b.promotionId) || isMutex(b, a.promotionId);
}

/**
 * 活动是否覆盖该款号/构建代。公告“适用款”里写明构建代时按构建代严格匹配，
 * 例如历史刊 PR-2“K-12 细链”只覆盖当时的 n7，不能沿用到拆分后的 n8。
 */
function appliesToModel(promotion, design) {
  const applies = promotion.applies;
  if (!applies || applies.scope === 'all') return true;
  return applies.models.some(
    entry =>
      entry.model === design.model &&
      (entry.generation === null || entry.generation === design.generation),
  );
}

/** 计算基础价与工费（元，未舍入）。 */
export function baseComponents({ brandRecord, design, labor }) {
  const materialYuan = brandRecord.priceYuan * design.weightGrams;
  let laborYuan;
  if (labor.type === 'per-item') {
    laborYuan = labor.valueYuan;
  } else {
    laborYuan = labor.valueYuan * design.weightGrams;
  }
  return { materialYuan, laborYuan };
}

function applyPromotions({ materialYuan, laborYuan, design, combo }) {
  let perGramReductionYuan = 0;
  let laborDiscountRate = 0;
  const applied = [];
  for (const promotion of combo) {
    if (promotion.kind === 'per-gram-reduction') {
      perGramReductionYuan += promotion.value;
      applied.push({ promotionId: promotion.promotionId, kind: promotion.kind, value: promotion.value });
    } else if (promotion.kind === 'labor-discount') {
      // 多个工费折扣取幅度最大者，不重复减免（公告没有叠加工费的口径）。
      laborDiscountRate = Math.max(laborDiscountRate, promotion.value);
      applied.push({ promotionId: promotion.promotionId, kind: promotion.kind, value: promotion.value });
    }
  }
  const material = Math.max(0, materialYuan - perGramReductionYuan * design.weightGrams);
  const labor = laborYuan * (1 - laborDiscountRate);
  return { totalYuan: material + labor, applied };
}

/** 枚举互不冲突的活动组合（单活动与可叠加组合），并计价。 */
export function priceOptions({ brandRecord, design, labor, promotions }) {
  const base = baseComponents({ brandRecord, design, labor });
  const usable = promotions.filter(
    promotion => promotion.state === 'cashable' && appliesToModel(promotion, design),
  );

  const options = [
    {
      kind: 'base',
      amountFen: roundFen(base.materialYuan + base.laborYuan),
      promotions: [],
      applied: [],
      selectionRequired: false,
    },
  ];

  // 单活动
  const combos = usable.map(promotion => [promotion]);
  // 两两组合：双方都不声明互斥才允许（“可与…同用”是肯定授权；未声明互斥的谨慎起见不自动叠加，
  // 因为公告本身没有给出叠加授权）。
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      const explicitlyStackable =
        (a.stackingRaw ?? '').includes(b.promotionId) || (b.stackingRaw ?? '').includes(a.promotionId);
      if (!pairMutex(a, b) && explicitlyStackable) combos.push([a, b]);
    }
  }

  for (const combo of combos) {
    const priced = applyPromotions({
      materialYuan: base.materialYuan,
      laborYuan: base.laborYuan,
      design,
      combo,
    });
    options.push({
      kind: combo.length > 1 ? 'stacked' : 'promotion',
      amountFen: roundFen(priced.totalYuan),
      promotions: combo.map(p => p.promotionId),
      applied: priced.applied,
      selectionRequired: false,
    });
  }

  // 存在多个金额不同的可兑现促销口径，而公告未指定选择权归属：店员/顾客二选一，工作台不默认承诺。
  const promoOptions = options.filter(option => option.kind !== 'base');
  const distinctAmounts = new Set(promoOptions.map(option => option.amountFen));
  if (distinctAmounts.size > 1) {
    for (const option of promoOptions) option.selectionRequired = true;
  }
  return { base, options };
}

/** 供履约复核使用：按指定单活动/无活动重算当前可信价格。 */
export function recomputeAmount({ brandRecord, design, labor, promotions }) {
  const { options } = priceOptions({ brandRecord, design, labor, promotions });
  return options;
}
