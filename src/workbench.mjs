// 采集与报价工作台总装：编排来源客户端、证据目录、计价引擎、额度协商与票据库。
// 同一门店的写操作串行化（不同门店可同时报价），票据与档案可落盘重开。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SourceClient } from './source-client.mjs';
import { Catalog } from './catalog.mjs';
import { LedgerClient, quotaSummary } from './ledger.mjs';
import { OfferStore, defaultValidUntil } from './offers.mjs';
import { priceOptions } from './pricing.mjs';
import { fenToYuan } from './time.mjs';

export class Workbench {
  constructor({ sourceUrl, clock = () => new Date(), stateFile = null, settleDelayMs = 0 } = {}) {
    this.clock = clock;
    this.client = new SourceClient(sourceUrl, clock);
    this.catalog = new Catalog();
    this.offers = new OfferStore();
    this.ledger = new LedgerClient(this.client, { settleDelayMs });
    this.stateFile = stateFile;
    this.locks = new Map();
  }

  /** 同门店串行：不同门店互不阻塞，同门店写操作按序执行。 */
  async withShopLock(shop, task) {
    const previous = this.locks.get(shop) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => {
      release = resolve;
    });
    this.locks.set(shop, previous.then(() => next));
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * 一次完整采集：品牌、目录、工费、门店活动（含历史刊）、店员核定、柜台台账。
   * 所有原始请求在 SourceClient 内留痕；归一化事实进入 Catalog。
   */
  async collect({ history = [] } = {}) {
    const observedAt = this.clock().toISOString();
    const shops = await this.client.collectShops();
    this.catalog.ingestShops(shops, observedAt);

    const brand = await this.client.collectBrand();
    this.catalog.ingestBrand(brand.records, observedAt);

    const designs = await this.client.collectDesigns();
    this.catalog.ingestDesigns(designs, observedAt);

    const labor = await this.client.collectLabor();
    this.catalog.ingestLabor(labor, observedAt);

    const clarification = await this.client.collectClarifications();
    this.catalog.ingestClarification(clarification, observedAt);
    // 门店绑定报价号的撤销确认：立即作用于票据库。
    for (const item of clarification.items ?? []) {
      if (item.offerId && item.action === 'stop-honoring') {
        this.offers.confirmStop(item.offerId, item.source, item.at ?? observedAt);
      }
    }

    for (const shop of shops.map(entry => entry.shop)) {
      const { sale, terms } = await this.client.collectSale(shop);
      if (sale) this.catalog.ingestSale(shop, sale);
      if (terms) this.catalog.ingestTerms(shop, terms);
      await this.client.collectAllocation(shop); // 台账观察留痕，供额度判断使用最新回读
    }
    for (const { shop, issue } of history) {
      const historical = await this.client.collectHistory(shop, issue);
      if (historical) this.catalog.ingestSale(shop, historical);
    }

    if (this.stateFile) await this.save();
    return {
      observedAt,
      shops: shops.map(shop => shop.shop),
      observations: this.client.observations.length,
      rejectedClarifications: this.catalog.rejectedClarifications,
    };
  }

  /**
   * 客户查询：门店 + 款号 + 时点的可兑现报价。
   * 证据不全（排除页未收齐等）时只给公开基础价与等待原因，绝不猜促销总价。
   */
  quote({ shop, model, at = this.clock().toISOString() }) {
    const findings = [];
    const designResult = this.catalog.designAt(model, at);
    if (!designResult.item) {
      return {
        shop,
        model,
        at,
        cashable: false,
        findings: [designResult.finding, ...this._pendingFindings(shop, model, null, at)],
      };
    }
    const brandResult = this.catalog.brandPriceAt(designResult.item.karat, at);
    const laborResult = this.catalog.laborAt(designResult.item.generation, at);
    if (!brandResult.record || !laborResult.item) {
      return {
        shop,
        model,
        at,
        cashable: false,
        design: designResult.item,
        findings: [
          ...(brandResult.record ? [] : [brandResult.finding]),
          ...(laborResult.item ? [] : [laborResult.finding]),
          ...this._pendingFindings(shop, model, designResult.item.generation, at),
        ],
      };
    }

    const promoView = this.catalog.promotionView(shop, model, designResult.item.generation, at);
    const { base, options } = priceOptions({
      brandRecord: brandResult.record,
      design: designResult.item,
      labor: laborResult.item,
      promotions: promoView.cashable,
    });

    const pendingFindings = this._pendingFindings(shop, model, designResult.item.generation, at);
    findings.push(...pendingFindings);
    const cashablePromotions = promoView.cashable.filter(
      promotion => promotion.state === 'cashable',
    );
    const inapplicable = promoView.cashable
      .filter(promotion => promotion.state !== 'cashable')
      .map(promotion => ({
        promotionId: promotion.promotionId,
        state: promotion.state,
        inWindow: promotion.inWindow,
        scopeMatched: promotion.scopeMatched,
        reasons: promotion.reasons,
        sources: promotion.sources,
      }));

    return {
      shop,
      model,
      at,
      cashable: true,
      design: designResult.item,
      brand: brandResult.record,
      labor: laborResult.item,
      sources: {
        brand: brandResult.source,
        design: designResult.source,
        labor: laborResult.source,
      },
      base: {
        materialYuan: base.materialYuan,
        laborYuan: base.laborYuan,
        amountFen: options[0].amountFen,
        amountYuan: fenToYuan(options[0].amountFen),
      },
      options: options.map(option => ({
        ...option,
        amountYuan: fenToYuan(option.amountFen),
      })),
      promotions: {
        cashable: cashablePromotions,
        inapplicable, // 当前已证实不适用（撤下/排除/窗口外/超出公告适用款）
        evidencePending: promoView.pending, // 当时未采到，不能当作不适用
      },
      // 存在未采全的活动证据，且当前没有任何可兑现促销 → 只能报公开基础价。
      baseOnly:
        cashablePromotions.length === 0 &&
        (promoView.pending.length > 0 || pendingFindings.length > 0),
      waitingReasons: pendingFindings,
      findings,
    };
  }

  _pendingFindings(shop, model, generation, at) {
    if (!generation) return [];
    const view = this.catalog.promotionView(shop, model, generation, at);
    return view.pending.map(promotion => ({
      code: 'promotion-evidence-pending',
      severity: 'warning',
      promotionId: promotion.promotionId,
      batch: promotion.batch,
      reason: promotion.reasons,
      message: `活动 ${promotion.promotionId} 的发布证据未收齐（${promotion.reasons
        .map(r => r.code)
        .join(',')}），本报价仅含公开基础价`,
    }));
  }

  /**
   * 出票：先报价、再按所选口径占用额度，额度未确认不出票。
   * 基础价口径无需额度，直接出票。
   */
  async issueOffer({
    shop,
    model,
    at = this.clock().toISOString(),
    promotionIds = [],
    pieces = 1,
    ttlHours = 2,
  }) {
    return this.withShopLock(shop, async () => {
      const quote = this.quote({ shop, model, at });
      if (!quote.cashable) {
        return { created: false, reason: 'quote-blocked', quote };
      }
      const option = this._selectOption(quote, promotionIds);
      if (!option) {
        return {
          created: false,
          reason: 'option-not-available',
          message: `所选活动口径 [${promotionIds.join(',')}] 在当前可信证据下不可兑现，不得改按其它口径出票`,
          quote,
        };
      }
      if (option.selectionRequired) {
        return {
          created: false,
          reason: 'selection-required',
          message: '公告未指定折扣选择权归属，须由店员或顾客明确选择一种合法口径',
          quote,
        };
      }

      let allocation = null;
      let reservedOfferId = null;
      if (option.promotions.length > 0) {
        const ledger = await this.client.collectAllocation(shop);
        if (!ledger) {
          return { created: false, reason: 'ledger-unreadable', quote };
        }
        const primaryPromotion = option.promotions[0];
        if (ledger.promotion !== primaryPromotion) {
          return {
            created: false,
            reason: 'ledger-promotion-mismatch',
            ledger: quotaSummary(ledger),
            quote,
          };
        }
        // 先在票据库占住票号，保证柜台登记与最终票据是同一张票。
        reservedOfferId = this.offers.reserveId();
        const reservation = await this.ledger.reserve(shop, {
          offerId: reservedOfferId,
          promotion: ledger.promotion,
          period: ledger.period,
          pieces,
        });
        if (reservation.status !== 'occupied') {
          return { created: false, reason: reservation.status, reservation, quote };
        }
        allocation = {
          period: reservation.ledger.period,
          promotion: reservation.ledger.promotion,
          pieces,
          ledgerRevision: reservation.ledger.ledgerRevision,
          provisional: reservation.provisional ?? false,
        };
      }

      const offer = this.offers.issue({
        offerId: reservedOfferId ?? undefined,
        issuedAt: at,
        validUntil: defaultValidUntil(at, ttlHours),
        shop,
        model,
        generation: quote.design.generation,
        amountFen: option.amountFen,
        basis: this._basis(quote, option),
        promotionIds: option.promotions,
        allocation,
        option,
      });
      if (this.stateFile) await this.save();
      return { created: true, offer, quote };
    });
  }

  _selectOption(quote, promotionIds) {
    const wanted = [...promotionIds].sort().join('|');
    const exact = quote.options.find(
      option => [...option.promotions].sort().join('|') === wanted,
    );
    if (exact) return exact;
    // 仅当调用方没有指定活动时才默认基础价；指定了活动却找不到口径必须显式失败，
    // 绝不静默降级为另一张可兑现票据。
    return promotionIds.length === 0 ? quote.options[0] : null;
  }

  _basis(quote, option) {
    const basis = [quote.brand.identity ?? quote.sources.brand.identity];
    for (const promotionId of option.promotions) {
      const promo = quote.promotions.cashable.find(entry => entry.promotionId === promotionId);
      if (promo) basis.push(`${promotionId}@批次${promo.batch}`);
    }
    basis.push(`designs:${quote.design.model}/${quote.design.generation}`, `labor:${quote.labor.generation}`);
    return basis;
  }

  offerStatus(offerId, at = this.clock().toISOString()) {
    const state = this.offers.statusAt(offerId, at);
    if (!state) return { found: false };
    return {
      found: true,
      offerId,
      status: state.status,
      since: state.since ?? null,
      offer: state.offer,
      amountYuan: fenToYuan(state.offer.amountFen),
      // 可兑现票据始终声明“按原凭据兑现”，不受后台新活动影响。
      honoredPerOriginalBasis: state.status === 'honorable',
    };
  }

  async review(at = this.clock().toISOString()) {
    const reviews = await this.offers.reviewFulfillment(at, {
      catalog: this.catalog,
      pricing: { priceOptions },
    });
    return {
      at,
      reviews,
      manualContactQueue: reviews.filter(review => review.needsManualContact),
    };
  }

  /** 店员复盘：当时所见的牌价、工费、活动来源，以及“未采到 vs 已证实不适用”。 */
  evidence({ shop, model, at, offerId = null }) {
    const response = {
      shop,
      model,
      at,
      timeline: this.catalog.evidenceTimeline(shop, at),
      observations: this.client.observations
        .filter(observation => observation.observedAt <= at)
        .map(observation => ({
          observationId: observation.observationId,
          observedAt: observation.observedAt,
          kind: observation.kind,
          path: observation.path,
          status: observation.status,
          available: observation.available,
          reason: observation.reason ?? null,
        })),
    };
    if (offerId) {
      const state = this.offers.statusAt(offerId, at);
      response.offer = state
        ? { ...state.offer, status: state.status, since: state.since ?? null }
        : null;
    }
    if (model) {
      const designResult = this.catalog.designAt(model, at);
      response.currentQuote = designResult.item
        ? this.quote({ shop, model, at })
        : { cashable: false, findings: [designResult.finding] };
    }
    return response;
  }

  async quota(shop) {
    const ledger = await this.client.collectAllocation(shop);
    if (!ledger) return { shop, available: false, reason: 'ledger-unreadable' };
    return { shop, ...quotaSummary(ledger) };
  }

  // ---------- 持久化（重开服务不丢票据与档案） ----------

  toJSON() {
    return {
      catalog: {
        brandSnapshots: this.catalog.brandSnapshots,
        designSnapshots: this.catalog.designSnapshots,
        laborSnapshots: this.catalog.laborSnapshots,
        shops: [...this.catalog.shops.entries()],
        saleSnapshots: this.catalog.saleSnapshots,
        termsByKey: [...this.catalog.termsByKey.entries()],
        clarificationSnapshots: this.catalog.clarificationSnapshots,
        rejectedClarifications: this.catalog.rejectedClarifications,
      },
      offers: {
        records: [...this.offers.offers.entries()],
        stopConfirmations: this.offers.stopConfirmations,
        counter: this.offers._counter,
      },
      observations: this.client.observations,
    };
  }

  async save() {
    if (!this.stateFile) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.toJSON(), null, 2), 'utf8');
  }

  async load() {
    if (!this.stateFile) return false;
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8'));
      const c = raw.catalog;
      this.catalog.brandSnapshots = c.brandSnapshots;
      this.catalog.designSnapshots = c.designSnapshots;
      this.catalog.laborSnapshots = c.laborSnapshots;
      this.catalog.shops = new Map(c.shops);
      this.catalog.saleSnapshots = c.saleSnapshots;
      this.catalog.termsByKey = new Map(c.termsByKey);
      this.catalog.clarificationSnapshots = c.clarificationSnapshots;
      this.catalog.rejectedClarifications = c.rejectedClarifications;
      this.offers.offers = new Map(raw.offers.records);
      this.offers.stopConfirmations = raw.offers.stopConfirmations;
      this.offers._counter = raw.offers.counter;
      this.client.observations = raw.observations ?? [];
      this.client._seq = this.client.observations.length;
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }

  loadSeedOffers(records) {
    this.offers.loadSeed(records);
  }
}
