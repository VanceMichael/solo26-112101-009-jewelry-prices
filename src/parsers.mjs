// 本地合成页面的解析层。来源均为受信的合成 HTML/JSON，不引入任何 HTML 解析依赖，
// 以结构化标记（data-*、表格行）为依据做稳健抽取；解析失败会抛出并由采集层记为观察失败。

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = text => text.replace(/&[a-z#0-9]+;/g, entity => ENTITIES[entity] ?? entity);
const stripTags = html => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

function rows(html) {
  return [...html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)].map(match => ({
    attrs: match[1],
    cells: [...match[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => stripTags(cell[1])),
  }));
}

function attr(attrs, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match ? decode(match[1]) : null;
}

function paragraphs(html) {
  return [...html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].map(match => ({
    batch: attr(match[1], 'data-batch'),
    text: stripTags(match[2]),
  }));
}

function links(html) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => ({
    href: decode(match[1]),
    label: stripTags(match[2]),
  }));
}

/** 品牌基础牌价页：得到按 UTC 生效时刻排列的克价行。 */
export function parseBrandPage(html) {
  const result = { records: [] };
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (title) result.pageTitle = stripTags(title[1]);
  for (const row of rows(html)) {
    const identity = attr(row.attrs, 'data-identity');
    if (!identity) continue;
    const [effectiveAt, karat, unit, price] = row.cells;
    result.records.push({
      identity,
      effectiveAt: new Date(effectiveAt).toISOString(),
      karat,
      unit,
      priceYuan: Number(price),
    });
  }
  result.records.sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt));
  return result;
}

const PER_GRAM_RE = /每克减\s*([0-9]+(?:\.[0-9]+)?)\s*元/;
const HALF_LABOR_RE = /工费减半/;
const FULL_LABOR_RE = /(?:全|免)免?工费|工费全免|免工费/;
const MODEL_GEN_RE = /([A-Z]+-\d+)\s*(?:\/\s*([a-z][a-z0-9]*))?/g;

/**
 * 从“适用款”文本抽取结构化适用范围。
 * “全部足金”→ 全成色通用；“K-12 细链”→ 仅款号；“K-12/n7”→ 款号+构建代。
 */
export function parseApplies(text) {
  if (/全部/.test(text)) return { scope: 'all', models: [] };
  const models = [];
  for (const match of text.matchAll(MODEL_GEN_RE)) {
    models.push({ model: match[1], generation: match[2] ?? null });
  }
  return { scope: 'models', models };
}

/**
 * 门店活动页（含历史刊）。
 * 保留批次状态、每行活动、排除条款链接与原始文本。
 */
export function parseSalePage(html, { path, observedAt }) {
  const batchParagraph = paragraphs(html).find(paragraph => paragraph.batch !== null);
  const batch = batchParagraph?.batch ?? null;
  const statusText = batchParagraph?.text ?? null;
  const promotions = [];
  for (const row of rows(html)) {
    const id = attr(row.attrs, 'data-id');
    if (!id) continue;
    const [windowText, discountText, appliesText, stackingText] = row.cells;
    let kind = null;
    let value = null;
    if (PER_GRAM_RE.test(discountText)) {
      kind = 'per-gram-reduction';
      value = Number(PER_GRAM_RE.exec(discountText)[1]);
    } else if (HALF_LABOR_RE.test(discountText)) {
      kind = 'labor-discount';
      value = 0.5;
    } else if (FULL_LABOR_RE.test(discountText)) {
      kind = 'labor-discount';
      value = 1;
    }
    promotions.push({
      id,
      windowRaw: windowText,
      discountRaw: discountText,
      appliesRaw: appliesText,
      applies: parseApplies(appliesText),
      stackingRaw: stackingText ?? '',
      kind,
      value,
    });
  }
  return {
    path,
    observedAt,
    batch,
    statusText,
    // “覆盖已结束”表示该批链接页需要实际到齐；“发布中”表示批次尚未签发完整。
    coverage:
      statusText === '覆盖已结束' ? 'ended' : statusText === '发布中' ? 'publishing' : 'unknown',
    promotions,
    termLinks: links(html).filter(link => /条款|限制|terms/.test(link.label + link.href)),
  };
}

/**
 * 排除/限制页。识别三类句子：
 *  - “PR-1 不含 K-12/n8” → 排除具体款号/构建代
 *  - “PR-2 限 K-12/n7”   → 仅限具体款号/构建代
 *  - “PR-2 编号明确撤下” → 整活动撤下（以批次为单位的明确事实）
 */
export function parseTermsPage(html, { path, observedAt, batch }) {
  const batchPara = paragraphs(html).find(paragraph => paragraph.batch !== null);
  const rules = [];
  for (const paragraph of paragraphs(html)) {
    const text = paragraph.text;
    const promoId = /(PR-\d+)/.exec(text)?.[1] ?? null;
    if (!promoId) continue;
    const target = /([A-Z]+-\d+)\s*\/\s*([a-z0-9]+)/.exec(text);
    if (/明确撤下|撤下|终止/.test(text)) {
      rules.push({ type: 'withdrawn', promotion: promoId });
    } else if (/不含|排除/.test(text) && target) {
      rules.push({
        type: 'excludes',
        promotion: promoId,
        model: target[1],
        generation: target[2],
      });
    } else if (/限/.test(text) && target) {
      rules.push({
        type: 'limits-to',
        promotion: promoId,
        model: target[1],
        generation: target[2],
      });
    } else {
      rules.push({ type: 'note', promotion: promoId, text });
    }
  }
  return { path, observedAt, batch: batch ?? batchPara?.batch ?? null, rules };
}

/** 款号目录页（支持分页：nextPage 或 Link 形式由采集层归一，这里解析数组）。 */
export function parseDesigns(payload) {
  const list = Array.isArray(payload) ? payload : payload.items;
  return list.map(item => ({
    model: item.model,
    generation: item.generation,
    label: item.label ?? '',
    karat: item.karat,
    weightGrams: Number(item.weight),
    validFrom: item.validFrom ? new Date(item.validFrom).toISOString() : null,
    validUntil: item.validUntil ? new Date(item.validUntil).toISOString() : null,
  }));
}

/** 工费页：按构建代索引，按件或按克。 */
export function parseLabor(payload) {
  const list = Array.isArray(payload) ? payload : payload.items;
  return list.map(item => ({
    generation: item.generation,
    type: item.type, // per-item | per-gram
    valueYuan: Number(item.value),
  }));
}

/** 店员核定页：只接受结构化字段；非法门店/越权改品牌价由上层拒绝。 */
export function parseClarifications(payload) {
  return {
    batch: payload.batch ?? null,
    items: Array.isArray(payload.items) ? payload.items : [],
  };
}

/** 柜台额度台账。 */
export function parseAllocation(payload) {
  return {
    ledgerRevision: payload.ledgerRevision,
    period: payload.period,
    promotion: payload.promotion,
    limit: payload.limit,
    items: payload.items.map(item => ({
      offerId: item.offerId,
      pieces: item.pieces,
      state: item.state,
    })),
  };
}
