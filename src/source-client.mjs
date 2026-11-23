// 来源客户端：只负责抓取与留痕。每次请求都产生一条不可变观察记录，
// 无论成功、失败、空白还是暂缓（425），都进入追加式档案，供“当时所见”复盘。

import {
  parseBrandPage,
  parseSalePage,
  parseTermsPage,
  parseDesigns,
  parseLabor,
  parseClarifications,
  parseAllocation,
} from './parsers.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SourceClient {
  /**
   * @param {string} baseUrl 本地演练来源地址
   * @param {() => Date} clock 可注入时钟
   */
  constructor(baseUrl, clock = () => new Date()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clock = clock;
    this.observations = [];
    this._seq = 0;
  }

  _record(entry) {
    const observation = {
      observationId: `O-${++this._seq}`,
      observedAt: this.clock().toISOString(),
      ...entry,
    };
    this.observations.push(observation);
    return observation;
  }

  async _request(method, path, body) {
    const url = this.baseUrl + path;
    const started = this.clock().toISOString();
    try {
      const response = await fetch(url, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      });
      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        contentType,
        raw,
        json: contentType.includes('application/json') ? JSON.parse(raw || 'null') : null,
        requestedAt: started,
      };
    } catch (error) {
      return { ok: false, status: 0, error: error.message, requestedAt: started };
    }
  }

  async getHtml(kind, path) {
    const reply = await this._request('GET', path);
    if (reply.status !== 200) {
      return this._record({
        kind,
        path,
        status: reply.status,
        available: false,
        reason: reply.status === 425 ? 'exclusion-page-pending' : reply.error ?? `http-${reply.status}`,
        raw: reply.raw ?? null,
      });
    }
    return this._record({
      kind,
      path,
      status: 200,
      available: true,
      html: reply.raw,
    });
  }

  /**
   * JSON 采集，支持两种分页约定：载荷中的 nextPage 字段，或 Link 头（本合成来源未启用，
   * 但真实目录分页可直接复用）。
   */
  async getJson(kind, path, { maxPages = 20 } = {}) {
    const pages = [];
    let current = path;
    for (let pageNo = 0; pageNo < maxPages && current; pageNo += 1) {
      const reply = await this._request('GET', current);
      if (reply.status !== 200) {
        return this._record({
          kind,
          path,
          status: reply.status,
          available: false,
          reason: reply.error ?? `http-${reply.status}`,
        });
      }
      pages.push(reply.json);
      const next =
        reply.json && typeof reply.json === 'object' && !Array.isArray(reply.json)
          ? reply.json.nextPage
          : null;
      current = next ?? null;
    }
    // 合并分页：数组直接拼接；对象形式取 items。
    let merged;
    if (pages.every(page => Array.isArray(page))) {
      merged = pages.flat();
    } else {
      merged = pages.flatMap(page => page.items ?? []);
    }
    return this._record({ kind, path, status: 200, available: true, payload: merged, pages: pages.length });
  }

  async collectBrand() {
    const observation = await this.getHtml('brand', '/brands/yun/gold');
    return observation.available ? parseBrandPage(observation.html) : { records: [] };
  }

  async collectShops() {
    const observation = await this.getJson('shops', '/shops');
    return observation.available ? observation.payload : [];
  }

  async collectSale(shop) {
    const path = `/shops/${shop}/sale`;
    const observation = await this.getHtml('sale', path);
    if (!observation.available) return { sale: null, terms: null };
    const sale = parseSalePage(observation.html, {
      path,
      observedAt: observation.observedAt,
    });
    let terms = null;
    const termsLink = sale.termLinks[0];
    if (termsLink) {
      const termsObs = await this.getHtml('terms', termsLink.href);
      if (termsObs.available) {
        terms = parseTermsPage(termsObs.html, {
          path: termsLink.href,
          observedAt: termsObs.observedAt,
          batch: sale.batch,
        });
      }
      // 不可用时不造规则：termsObs 已作为观察留痕，判定层据此识别“尚未采到”。
      sale.termsObservationId = termsObs.observationId;
      sale.termsAvailable = termsObs.available;
      sale.termsReason = termsObs.available ? null : termsObs.reason;
    } else {
      sale.termsAvailable = false;
      sale.termsReason = 'no-terms-link';
    }
    return { sale, terms };
  }

  async collectHistory(shop, issue) {
    const path = `/shops/${shop}/history/${issue}`;
    const observation = await this.getHtml('history', path);
    if (!observation.available) return null;
    const sale = parseSalePage(observation.html, {
      path,
      observedAt: observation.observedAt,
    });
    sale.issue = String(issue);
    return sale;
  }

  async collectDesigns() {
    const observation = await this.getJson('designs', '/designs');
    return observation.available ? parseDesigns(observation.payload) : [];
  }

  async collectLabor() {
    const observation = await this.getJson('labor', '/labor');
    return observation.available ? parseLabor(observation.payload) : [];
  }

  async collectClarifications() {
    const observation = await this.getJsonObject('clarifications', '/shops/clarifications');
    if (!observation.available) return { batch: null, items: [] };
    return parseClarifications(observation.payload);
  }

  /** 抓取对象型 JSON（保留外壳元数据，如台账的 ledgerRevision/limit）。 */
  async getJsonObject(kind, path) {
    const reply = await this._request('GET', path);
    if (reply.status !== 200) {
      return this._record({
        kind,
        path,
        status: reply.status,
        available: false,
        reason: reply.error ?? `http-${reply.status}`,
      });
    }
    return this._record({ kind, path, status: 200, available: true, payload: reply.json });
  }

  async collectAllocation(shop) {
    const observation = await this.getJsonObject('allocation', `/counter/${shop}/allocations`);
    if (!observation.available) return null;
    return parseAllocation(observation.payload);
  }

  /**
   * 提交占用。返回来源的原始裁决，绝不把超时/冲突猜测为成功。
   */
  async postAllocation(shop, body) {
    const reply = await this._request('POST', `/counter/${shop}/allocations`, body);
    this._record({
      kind: 'allocation-post',
      path: `/counter/${shop}/allocations`,
      status: reply.status,
      request: body,
      response: reply.json,
      error: reply.error ?? null,
    });
    return reply;
  }

  /** 窗口超时辅助：演练时可用 0ms，真实环境配置超时后回查台账。 */
  static async wait(ms) {
    if (ms > 0) await sleep(ms);
  }
}
