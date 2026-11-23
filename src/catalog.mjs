// 证据档案目录：保存所有追加式观察，并能回答两个不同的问题——
//   1) 在时点 T“当时能看到什么”（asOf 视图，只用 observedAt <= T 的资料）；
//   2) “当前已证实不适用”（最新视图里被撤下、被排除、被结束的事实）。
// 目录自身不做金额计算，只输出带出处的结构化事实。

import { parseLocalRange, isWithin } from './time.mjs';

export class Catalog {
  constructor() {
    this.brandSnapshots = []; // {observedAt, records}
    this.designSnapshots = []; // {observedAt, items}
    this.laborSnapshots = []; // {observedAt, items}
    this.shops = new Map(); // shop -> {timezone, url, selected, observedAt}
    this.saleSnapshots = []; // 门店活动页（含历史刊），每次观察一条
    this.termsByKey = new Map(); // `${shop}:${batch}` -> 最新条款观察
    this.clarificationSnapshots = []; // {observedAt, batch, items, rejected}
    this.rejectedClarifications = []; // 越权或结构非法的店员核定
  }

  ingestShops(shops, observedAt) {
    for (const shop of shops) {
      this.shops.set(shop.shop, { ...shop, observedAt });
    }
  }

  ingestBrand(records, observedAt) {
    this.brandSnapshots.push({ observedAt, records });
  }

  ingestDesigns(items, observedAt) {
    this.designSnapshots.push({ observedAt, items });
  }

  ingestLabor(items, observedAt) {
    this.laborSnapshots.push({ observedAt, items });
  }

  ingestSale(shop, sale) {
    const timezone = this.shops.get(shop)?.timezone;
    // 该批公告发布时点的款号目录快照：公告只写款号/品名时，构建代按当时现行规格绑定，
    // 这样历史刊 PR-2“K-12 细链”锁定 n7，不会错误沿用到款式拆分后的 n8。
    const designSnapshot = Catalog._latest(this.designSnapshots, sale.observedAt);
    const promotions = sale.promotions.map(promotion => {
      const window = timezone
        ? parseLocalRange(promotion.windowRaw, timezone)
        : { startUtc: null, endUtc: null, raw: promotion.windowRaw };
      // 以活动窗口开始时刻作为“公告口径生效时点”来锁定当时现行构建代。
      const bindAt = window.startUtc ?? sale.observedAt;
      return { ...promotion, window, applies: this._bindApplies(promotion.applies, designSnapshot, bindAt) };
    });
    this.saleSnapshots.push({
      shop,
      path: sale.path,
      issue: sale.issue ?? null,
      observedAt: sale.observedAt,
      batch: sale.batch,
      coverage: sale.coverage,
      statusText: sale.statusText,
      termsAvailable: sale.termsAvailable,
      termsReason: sale.termsReason,
      termsObservationId: sale.termsObservationId ?? null,
      promotions,
    });
  }

  _bindApplies(applies, designSnapshot, bindAt) {
    if (!applies || applies.scope !== 'models' || !designSnapshot) return applies;
    const models = applies.models.map(entry => {
      if (entry.generation) return entry;
      const current = designSnapshot.items.find(
        item =>
          item.model === entry.model &&
          item.validFrom <= bindAt &&
          (item.validUntil === null || bindAt < item.validUntil),
      );
      return current ? { ...entry, generation: current.generation, boundFromCatalog: true } : entry;
    });
    return { scope: 'models', models };
  }

  ingestTerms(shop, terms) {
    if (!terms) return;
    this.termsByKey.set(`${shop}:${terms.batch}`, { ...terms, shop });
  }

  /**
   * 店员核定的准入校验：只能对自己门店的条款更正生效时间/归属，
   * 任何试图改写品牌克价（price/karat/unit 等字段）的条目一律拒绝并留痕。
   */
  ingestClarification(clarification, observedAt) {
    const allowedActions = new Set(['end', 'extend', 'withdraw', 'reattribute']);
    const brandFields = ['price', 'priceYuan', 'karat', 'unit', 'brandPrice'];
    const accepted = [];
    const rejected = [];
    for (const item of clarification.items) {
      const problems = [];
      if (!item.source || !this.shops.has(item.source)) problems.push('unknown-source-shop');
      if (brandFields.some(field => field in item)) problems.push('cannot-override-brand-price');
      if (item.offerId) {
        if (item.action !== 'stop-honoring') problems.push('offer-binding-only-allows-stop-honoring');
      } else if (!item.appliesTo || !allowedActions.has(item.action)) {
        problems.push('unsupported-clause-action');
      }
      if (problems.length) rejected.push({ item, problems });
      else accepted.push(item);
    }
    this.clarificationSnapshots.push({ observedAt, batch: clarification.batch, items: accepted });
    if (rejected.length) this.rejectedClarifications.push({ observedAt, rejected });
  }

  // ---------- 时点视图 ----------

  static _latest(snapshots, at) {
    let chosen = null;
    for (const snapshot of snapshots) {
      if (snapshot.observedAt <= at && (!chosen || snapshot.observedAt > chosen.observedAt)) {
        chosen = snapshot;
      }
    }
    return chosen;
  }

  brandPriceAt(karat, at) {
    const snapshot = Catalog._latest(this.brandSnapshots, at);
    if (!snapshot) return { record: null, finding: { code: 'brand-not-collected', severity: 'blocker' } };
    const record = [...snapshot.records]
      .filter(row => row.karat === karat && row.effectiveAt <= at)
      .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
    if (!record) return { record: null, finding: { code: 'brand-price-not-yet-effective', severity: 'blocker' } };
    return { record, source: { path: '/brands/yun/gold', observedAt: snapshot.observedAt, identity: record.identity } };
  }

  designAt(model, at) {
    const snapshot = Catalog._latest(this.designSnapshots, at);
    if (!snapshot) return { item: null, finding: { code: 'design-catalog-not-collected', severity: 'blocker' } };
    const item = snapshot.items.find(
      row =>
        row.model === model &&
        row.validFrom <= at &&
        (row.validUntil === null || at < row.validUntil),
    );
    if (!item) {
      return { item: null, finding: { code: 'design-generation-unconfirmed', severity: 'blocker', model } };
    }
    return { item, source: { path: '/designs', observedAt: snapshot.observedAt } };
  }

  laborAt(generation, at) {
    const snapshot = Catalog._latest(this.laborSnapshots, at);
    if (!snapshot) return { item: null, finding: { code: 'labor-not-collected', severity: 'blocker' } };
    const item = snapshot.items.find(row => row.generation === generation);
    if (!item) {
      return { item: null, finding: { code: 'labor-tariff-unconfirmed', severity: 'blocker', generation } };
    }
    return { item, source: { path: '/labor', observedAt: snapshot.observedAt } };
  }

  _completedBatches(shop, at) {
    // 同一批取 observedAt <= at 的最新观察；历史刊也是“已覆盖结束”的完整批次。
    const latestByBatch = new Map();
    for (const snapshot of this.saleSnapshots) {
      if (snapshot.shop !== shop || snapshot.observedAt > at) continue;
      const key = snapshot.batch ?? `issue-${snapshot.issue}`;
      const previous = latestByBatch.get(key);
      if (!previous || snapshot.observedAt > previous.observedAt) latestByBatch.set(key, snapshot);
    }
    const completed = [];
    const incomplete = [];
    for (const [key, snapshot] of latestByBatch) {
      const terms = this.termsByKey.get(`${shop}:${snapshot.batch}`);
      const termsCollected = Boolean(terms && terms.observedAt <= at);
      const hasTermsLink =
        snapshot.termsObservationId !== null && snapshot.termsReason !== 'no-terms-link';
      // “覆盖已结束”且其链接页（排除条款）实际到齐，才算可信完整批次；
      // “发布中”永远不是完整批次；无条款链接的历史刊按无附加限制处理。
      const isComplete =
        snapshot.coverage === 'ended' && (!hasTermsLink || termsCollected);
      const entry = { key, snapshot, terms: termsCollected ? terms : null };
      if (isComplete) completed.push(entry);
      else incomplete.push(entry);
    }
    const batchNumber = key => Number(String(key).replace(/\D/g, '')) || 0;
    completed.sort((a, b) => batchNumber(b.key) - batchNumber(a.key));
    return { completed, incomplete, latestByBatch };
  }

  _clarificationsFor(shop, at) {
    const items = [];
    for (const snapshot of this.clarificationSnapshots) {
      if (snapshot.observedAt > at) continue;
      items.push(...snapshot.items.filter(item => item.source === shop));
    }
    return items;
  }

  /**
   * 列出门店在时点 T 对某款某构建代的全部活动及其可兑现状态。
   * 状态机：
   *  - cashable        证据完整、窗口内、未被排除/撤下/结束
   *  - outside-window  窗口外（含被店员 extend/end 调整后）
   *  - excluded        排除/限制条款排除该构建代
   *  - withdrawn       目录/条款明确撤下或店员 end
   *  - evidence-pending 批次仍在发布中或排除页未采到（区别于证实不适用）
   *  - suspended       页面缺失且未得到目录覆盖确认（本合成数据用 publishing 表达）
   */
  promotionView(shop, model, generation, at) {
    const { completed, incomplete } = this._completedBatches(shop, at);
    const clarifications = this._clarificationsFor(shop, at);
    const result = [];
    const seen = new Set();

    const evaluate = (promotion, batchEntry) => {
      if (seen.has(promotion.id)) return;
      seen.add(promotion.id);
      const reasons = [];
      const sources = [
        { path: batchEntry.snapshot.path, observedAt: batchEntry.snapshot.observedAt, batch: batchEntry.key },
      ];
      let window = promotion.window;
      let state = 'cashable';

      // 店员对本店活动的时间更正（end / extend）。
      for (const clarification of clarifications.filter(c => c.appliesTo === promotion.id)) {
        if (clarification.action === 'end') {
          window = { ...window, endUtc: clarification.effectiveAt };
          reasons.push({ code: 'clarified-end', at: clarification.effectiveAt });
          sources.push({ path: '/shops/clarifications', action: 'end' });
        } else if (clarification.action === 'extend' && clarification.until) {
          if (Date.parse(clarification.until) > Date.parse(window.endUtc)) {
            window = { ...window, endUtc: clarification.until };
          }
          reasons.push({ code: 'clarified-extend', until: clarification.until });
          sources.push({ path: '/shops/clarifications', action: 'extend' });
        } else if (clarification.action === 'withdraw') {
          state = 'withdrawn';
          reasons.push({ code: 'clarified-withdraw', at: clarification.effectiveAt });
          sources.push({ path: '/shops/clarifications', action: 'withdraw' });
        } else if (clarification.action === 'reattribute') {
          // 条款归属更正：在本店把该活动替代/归并到另一活动编号，原编号不再独立兑现。
          state = 'withdrawn';
          reasons.push({
            code: 'clarified-reattributed',
            at: clarification.effectiveAt,
            reassignTo: clarification.reassignTo ?? null,
          });
          sources.push({ path: '/shops/clarifications', action: 'reattribute' });
        }
      }

      // 批次附带的排除/限制/撤下条款。
      if (batchEntry.terms) {
        sources.push({ path: batchEntry.terms.path, observedAt: batchEntry.terms.observedAt });
        for (const rule of batchEntry.terms.rules.filter(rule => rule.promotion === promotion.id)) {
          if (rule.type === 'withdrawn') {
            state = 'withdrawn';
            reasons.push({ code: 'terms-withdrawn' });
          } else if (
            rule.type === 'excludes' &&
            rule.model === model &&
            rule.generation === generation
          ) {
            state = state === 'cashable' ? 'excluded' : state;
            reasons.push({ code: 'terms-excludes', model, generation });
          } else if (rule.type === 'limits-to') {
            if (rule.model !== model || rule.generation !== generation) {
              state = state === 'cashable' ? 'excluded' : state;
              reasons.push({ code: 'terms-limits-to', model: rule.model, generation: rule.generation });
            } else {
              reasons.push({ code: 'terms-limits-to-match', model, generation });
            }
          }
        }
      }

      // 两个正交事实分开记录：
      //  - inWindow：活动自身窗口（含店员 end/extend 更正）在时点 T 是否有效；
      //  - scopeMatched：公告“适用款”是否覆盖当前查询的款号/构建代。
      let inWindow = true;
      if (window?.startUtc && window?.endUtc) {
        inWindow = isWithin(window.startUtc, window.endUtc, at);
        if (!inWindow) reasons.push({ code: 'window', window });
      }
      let scopeMatched = true;
      if (promotion.applies?.scope === 'models') {
        scopeMatched = promotion.applies.models.some(
          entry =>
            entry.model === model && (entry.generation === null || entry.generation === generation),
        );
        if (!scopeMatched) {
          reasons.push({
            code: 'outside-announced-applies',
            applies: promotion.applies,
            model,
            generation,
          });
        }
      }

      // 状态优先级：撤下/排除条款 > 适用款范围 > 时间窗口。
      if (state === 'cashable' && !scopeMatched) state = 'excluded';
      if (state === 'cashable' && !inWindow) state = 'outside-window';

      result.push({
        promotionId: promotion.id,
        kind: promotion.kind,
        value: promotion.value,
        applies: promotion.applies,
        appliesRaw: promotion.appliesRaw,
        stackingRaw: promotion.stackingRaw,
        batch: batchEntry.key,
        window,
        inWindow,
        scopeMatched,
        state,
        reasons,
        sources,
      });
    };

    // 完整批次按批号新到旧，每个活动只取最新完整批次的口径。
    for (const batchEntry of completed) {
      for (const promotion of batchEntry.snapshot.promotions) evaluate(promotion, batchEntry);
    }

    // 未完整批次中的活动：不能兑现促销，但要显式告诉柜台“还没采到”。
    const pending = [];
    for (const batchEntry of incomplete) {
      const termsMissing = !batchEntry.terms;
      for (const promotion of batchEntry.snapshot.promotions) {
        if (seen.has(promotion.id)) continue;
        seen.add(promotion.id);
        const reasonCode =
          batchEntry.snapshot.coverage === 'publishing'
            ? 'batch-publishing'
            : termsMissing
              ? 'exclusion-page-pending'
              : 'batch-incomplete';
        pending.push({
          promotionId: promotion.id,
          kind: promotion.kind,
          value: promotion.value,
          applies: promotion.applies,
          appliesRaw: promotion.appliesRaw,
          stackingRaw: promotion.stackingRaw,
          batch: batchEntry.key,
          state: 'evidence-pending',
          reasons: [{ code: reasonCode }],
          sources: [
            {
              path: batchEntry.snapshot.path,
              observedAt: batchEntry.snapshot.observedAt,
              batch: batchEntry.key,
            },
          ],
        });
      }
    }

    return { cashable: result, pending };
  }

  /** 票据复盘：列出时点 T 对某门店可见的全部原始观察摘要。 */
  evidenceTimeline(shop, at) {
    return {
      brand: this.brandSnapshots
        .filter(snapshot => snapshot.observedAt <= at)
        .map(snapshot => ({ observedAt: snapshot.observedAt, path: '/brands/yun/gold', identities: snapshot.records.map(r => r.identity) })),
      sale: this.saleSnapshots
        .filter(snapshot => snapshot.shop === shop && snapshot.observedAt <= at)
        .map(snapshot => ({
          observedAt: snapshot.observedAt,
          path: snapshot.path,
          batch: snapshot.batch,
          coverage: snapshot.coverage,
          termsAvailable: snapshot.termsAvailable,
          termsReason: snapshot.termsReason,
          promotions: snapshot.promotions.map(p => p.id),
        })),
      terms: [...this.termsByKey.values()]
        .filter(terms => terms.shop === shop && terms.observedAt <= at)
        .map(terms => ({ observedAt: terms.observedAt, path: terms.path, batch: terms.batch, rules: terms.rules })),
      clarifications: this.clarificationSnapshots
        .filter(snapshot => snapshot.observedAt <= at)
        .flatMap(snapshot =>
          snapshot.items
            .filter(item => item.source === shop)
            .map(item => ({ observedAt: snapshot.observedAt, ...item })),
        ),
      designs: Catalog._latest(this.designSnapshots, at)
        ? [{ observedAt: Catalog._latest(this.designSnapshots, at).observedAt, path: '/designs' }]
        : [],
      labor: Catalog._latest(this.laborSnapshots, at)
        ? [{ observedAt: Catalog._latest(this.laborSnapshots, at).observedAt, path: '/labor' }]
        : [],
    };
  }
}
