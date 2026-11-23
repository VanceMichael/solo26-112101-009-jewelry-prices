// 已发出报价票据库。
// 核心不可违背的事实：
//  - 票据在有效期内按原凭据兑现，后台补来的新活动不改写票据；
//  - 只有门店发来“绑定报价号”的 stop-honoring 确认才停止兑现；
//  - 到期未兑现自动失效；
//  - 资料更正产生价差并影响履约时，输出需人工联系的单与更正出处。

function Catalog_latest(snapshots, at) {
  let chosen = null;
  for (const snapshot of snapshots) {
    if (snapshot.observedAt <= at && (!chosen || snapshot.observedAt > chosen.observedAt)) {
      chosen = snapshot;
    }
  }
  return chosen;
}

export class OfferStore {
  constructor() {
    this.offers = new Map();
    this.stopConfirmations = []; // {offerId, shop, at, source}
    this._counter = 0;
  }

  loadSeed(offers) {
    for (const offer of offers) {
      this.offers.set(offer.offerId, { ...offer, seeded: true });
    }
  }

  nextOfferId() {
    this._counter += 1;
    return `Q-N${this._counter}`;
  }

  /** 向柜台登记前先占住票号，确保台账票号与最终票据一致。 */
  reserveId() {
    return this.nextOfferId();
  }

  issue(record) {
    const offer = {
      offerId: record.offerId ?? this.nextOfferId(),
      issuedAt: record.issuedAt,
      validUntil: record.validUntil,
      shop: record.shop,
      model: record.model,
      generation: record.generation,
      amountFen: record.amountFen,
      basis: record.basis,
      promotionIds: record.promotionIds ?? [],
      allocation: record.allocation ?? null,
      option: record.option ?? null,
      seeded: false,
    };
    this.offers.set(offer.offerId, offer);
    return offer;
  }

  /** 门店绑定报价号的撤销确认（只接受本店票据）。 */
  confirmStop(offerId, shop, at, source = '/shops/clarifications') {
    const offer = this.offers.get(offerId);
    if (!offer) return { accepted: false, reason: 'unknown-offer' };
    if (offer.shop !== shop) return { accepted: false, reason: 'cross-shop-denied' };
    if (!this.stopConfirmations.some(entry => entry.offerId === offerId)) {
      this.stopConfirmations.push({ offerId, shop, at, source });
    }
    return { accepted: true, offerId, at };
  }

  statusAt(offerId, at) {
    const offer = this.offers.get(offerId);
    if (!offer) return null;
    const stop = this.stopConfirmations.find(entry => entry.offerId === offerId);
    if (stop && stop.at <= at) {
      return { status: 'stopped', since: stop.at, offer };
    }
    if (Date.parse(at) >= Date.parse(offer.validUntil)) {
      return { status: 'expired', offer };
    }
    return { status: 'honorable', offer };
  }

  listOpen(at) {
    return [...this.offers.values()]
      .map(offer => ({ offer, state: this.statusAt(offer.offerId, at) }))
      .filter(entry => entry.state.status === 'honorable');
  }

  /** 在时点 T 的目录快照中找指定款号的指定构建代（忽略有效期，只认确证的规格行）。 */
  _frozenDesign(catalog, model, generation, at) {
    const snapshot = Catalog_latest(catalog.designSnapshots, at);
    if (!snapshot) return { item: null, finding: { code: 'design-catalog-not-collected', severity: 'blocker' } };
    const item = snapshot.items.find(row => row.model === model && row.generation === generation);
    if (!item) {
      return { item: null, finding: { code: 'frozen-generation-not-confirmed', severity: 'blocker', model, generation } };
    }
    return { item, source: { path: '/designs', observedAt: snapshot.observedAt, frozen: true } };
  }

  /**
   * 履约价差复核：对每张仍可兑现票据，用当前可信资料按其冻结的款号/构建代重算，
   * 找出价差与更正出处。无法用当前资料重算（规格已停用等）也列为人工联系。
   */
  async reviewFulfillment(at, { catalog, pricing }) {
    const reviews = [];
    for (const { offer, state } of this.listOpen(at)) {
      const review = {
        offerId: offer.offerId,
        shop: offer.shop,
        model: offer.model,
        generation: offer.generation,
        originalAmountFen: offer.amountFen,
        basis: offer.basis,
        findings: [],
        needsManualContact: false,
      };
      // 规格号可能随款式拆分被重用：复核必须按票据冻结的构建代取目录与工费口径，
      // 不能拿当前目录里的新款重量去重算旧票据。
      const designResult = this._frozenDesign(catalog, offer.model, offer.generation, at);
      const brandResult = catalog.brandPriceAt(
        designResult.item?.karat ?? '足金',
        at,
      );
      const laborResult = designResult.item
        ? catalog.laborAt(offer.generation, at)
        : { item: null, finding: { code: 'design-unavailable', severity: 'blocker' } };

      if (!designResult.item || !brandResult.record || !laborResult.item) {
        review.needsManualContact = true;
        review.findings.push({
          code: 'current-basis-incomplete',
          detail: {
            design: designResult.finding ?? null,
            brand: brandResult.finding ?? null,
            labor: laborResult.finding ?? null,
          },
        });
        // 票据本身仍然按原凭据兑现，只是当前价无法复核。
        review.honorablePerOriginal = true;
        reviews.push(review);
        continue;
      }

      const promoView = catalog.promotionView(
        offer.shop,
        offer.model,
        // 用票据冻结的构建代评估活动口径（公告限制针对构建代）。
        offer.generation,
        at,
      );
      const currentOptions = pricing.priceOptions({
        brandRecord: brandResult.record,
        design: designResult.item,
        labor: laborResult.item,
        promotions: promoView.cashable,
      });
      // 当前最有利于顾客的可兑现口径，用于判断更正是否改变履约金额。
      const currentBest = currentOptions.options.reduce((a, b) =>
        b.amountFen < a.amountFen ? b : a,
      );
      review.currentBestAmountFen = currentBest.amountFen;
      review.diffFen = currentBest.amountFen - offer.amountFen;
      if (review.diffFen !== 0) {
        review.needsManualContact = true;
        review.findings.push({
          code: 'price-difference',
          diffFen: review.diffFen,
          currentSources: {
            brand: brandResult.source,
            design: designResult.source,
            labor: laborResult.source,
            promotions: promoView.cashable.flatMap(p => p.sources),
            pending: promoView.pending.map(p => ({ promotionId: p.promotionId, reasons: p.reasons })),
          },
        });
      }
      review.honorablePerOriginal = true;
      reviews.push(review);
    }
    return reviews;
  }
}

/** 票据有效期：默认给 2 小时（演练数据 Q-A/Q-B 也是 2~3 小时窗口）。 */
export function defaultValidUntil(issuedAt, hours = 2) {
  return new Date(Date.parse(issuedAt) + hours * 3600_000).toISOString();
}
