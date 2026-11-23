// 柜台额度协商。额度是“实际获准占用的件数”，不是网页活动可见就能重算：
//  - allocated / release-requested / redeemed 都继续占用；只有 released 才回收；
//  - POST 收到 409（修订冲突）必须回读最新台账后重试；
//  - POST 收到 202 仅表示“已收件”，必须回查台账确认票号真正登记；
//  - 窗口超时同样回查，绝不猜测成功。

import { SourceClient } from './source-client.mjs';

const STATE_OCCUPIED = new Set(['allocated', 'release-requested', 'redeemed', 'pending-confirm']);

export function quotaSummary(ledger) {
  const used = ledger.items
    .filter(item => STATE_OCCUPIED.has(item.state))
    .reduce((sum, item) => sum + item.pieces, 0);
  return {
    ledgerRevision: ledger.ledgerRevision,
    period: ledger.period,
    promotion: ledger.promotion,
    limit: ledger.limit,
    used,
    available: Math.max(0, ledger.limit - used),
    items: ledger.items,
  };
}

export class LedgerClient {
  constructor(sourceClient, { maxAttempts = 3, settleDelayMs = 0 } = {}) {
    this.source = sourceClient;
    this.maxAttempts = maxAttempts;
    this.settleDelayMs = settleDelayMs;
  }

  /**
   * 为新票据尝试占用额度。
   * @returns {{status:'occupied'|'full'|'needs-manual-check', ...}}
   */
  async reserve(shop, { offerId, promotion, period, pieces }) {
    let ledger = await this.source.collectAllocation(shop);
    if (!ledger) {
      return { status: 'needs-manual-check', reason: 'ledger-unreadable', offerId };
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const summary = quotaSummary(ledger);
      if (summary.promotion !== promotion || summary.period !== period) {
        return {
          status: 'needs-manual-check',
          reason: 'ledger-period-mismatch',
          offerId,
          ledger: summary,
        };
      }
      if (summary.available < pieces) {
        return { status: 'full', offerId, ledger: summary };
      }
      const reply = await this.source.postAllocation(shop, {
        offerId,
        promotion,
        period,
        pieces,
        ledgerRevision: ledger.ledgerRevision,
      });
      if (reply.status === 202) {
        // 已收件但未裁决：等待后回查门店实际登记。
        await SourceClient.wait(this.settleDelayMs);
        const refreshed = await this.source.collectAllocation(shop);
        if (!refreshed) {
          return { status: 'needs-manual-check', reason: 'settle-read-failed', offerId, ledger: summary };
        }
        const registered = refreshed.items.find(item => item.offerId === offerId);
        if (registered && STATE_OCCUPIED.has(registered.state)) {
          return { status: 'occupied', offerId, ledger: quotaSummary(refreshed), provisional: true };
        }
        return {
          status: 'needs-manual-check',
          reason: 'accepted-but-not-registered',
          offerId,
          ledger: quotaSummary(refreshed),
        };
      }
      if (reply.status === 409) {
        // 修订已变化：以来源给出的或回读到的最新修订重试。
        const nextRevision = reply.json?.ledgerRevision;
        const refreshed = await this.source.collectAllocation(shop);
        if (!refreshed) {
          return { status: 'needs-manual-check', reason: 'conflict-read-failed', offerId, ledger: summary };
        }
        if (nextRevision !== undefined && refreshed.ledgerRevision < nextRevision) {
          refreshed.ledgerRevision = nextRevision;
        }
        ledger = refreshed;
        continue;
      }
      if (reply.ok) {
        const refreshed = await this.source.collectAllocation(shop);
        const registered = refreshed?.items.find(item => item.offerId === offerId);
        if (registered && STATE_OCCUPIED.has(registered.state)) {
          return { status: 'occupied', offerId, ledger: quotaSummary(refreshed) };
        }
        return {
          status: 'needs-manual-check',
          reason: 'post-ok-but-unconfirmed',
          offerId,
          ledger: refreshed ? quotaSummary(refreshed) : summary,
        };
      }
      return {
        status: 'needs-manual-check',
        reason: `unexpected-status-${reply.status}`,
        offerId,
        detail: reply.json,
      };
    }
    return { status: 'needs-manual-check', reason: 'revision-conflict-exhausted', offerId, ledger: quotaSummary(ledger) };
  }

  /** 票据是否已在门店台账登记为占用态（用于窗口超时后的回查）。 */
  async lookup(shop, offerId) {
    const ledger = await this.source.collectAllocation(shop);
    if (!ledger) return { found: false, reason: 'ledger-unreadable' };
    const item = ledger.items.find(entry => entry.offerId === offerId);
    return {
      found: Boolean(item),
      item: item ?? null,
      occupying: item ? STATE_OCCUPIED.has(item.state) : false,
      ledger: quotaSummary(ledger),
    };
  }
}
