// 工作台 HTTP 接口。全部 JSON，供柜台/演练脚本调用。
// 路由：
//   POST /collect                采集一轮（body 可传 history:[{shop,issue}]）
//   GET  /quote?shop=&model=&at= 顾客可兑现报价
//   POST /offers                 出票（额度协商在内部完成）
//   GET  /offers/:id?at=         票据状态（仍按原凭据兑现/已撤销/到期）
//   GET  /review?at=             履约价差与人工联系队列
//   GET  /evidence?shop=&model=&at=&offerId=  当时所见复盘
//   GET  /quota/:shop            门店额度台账摘要

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Workbench } from './workbench.mjs';

const json = (response, status, payload) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
};

export async function startWorkbench({
  sourceUrl,
  port = 0,
  clock = () => new Date(),
  stateFile = null,
  seedOffersFile = null,
  settleDelayMs = 0,
} = {}) {
  const bench = new Workbench({ sourceUrl, clock, stateFile, settleDelayMs });
  await bench.load();
  if (seedOffersFile) {
    const seeded = JSON.parse(await readFile(seedOffersFile, 'utf8'));
    bench.loadSeedOffers(seeded);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString();
    let body = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        return json(response, 400, { error: '请求体不是合法 JSON' });
      }
    }
    try {
      if (request.method === 'POST' && url.pathname === '/collect') {
        const result = await bench.collect(body ?? {});
        return json(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/quote') {
        const shop = url.searchParams.get('shop');
        const model = url.searchParams.get('model');
        const at = url.searchParams.get('at') ?? undefined;
        if (!shop || !model) return json(response, 400, { error: 'shop 与 model 必填' });
        return json(response, 200, bench.quote({ shop, model, at }));
      }
      if (request.method === 'POST' && url.pathname === '/offers') {
        const result = await bench.issueOffer(body);
        return json(response, result.created ? 201 : 409, result);
      }
      const offerMatch = /^\/offers\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && offerMatch) {
        const at = url.searchParams.get('at') ?? undefined;
        const result = bench.offerStatus(offerMatch[1], at);
        return json(response, result.found ? 200 : 404, result);
      }
      if (request.method === 'GET' && url.pathname === '/review') {
        const at = url.searchParams.get('at') ?? undefined;
        return json(response, 200, await bench.review(at));
      }
      if (request.method === 'GET' && url.pathname === '/evidence') {
        const shop = url.searchParams.get('shop');
        const model = url.searchParams.get('model');
        const at = url.searchParams.get('at');
        const offerId = url.searchParams.get('offerId');
        if (!shop || !at) return json(response, 400, { error: 'shop 与 at 必填' });
        return json(response, 200, bench.evidence({ shop, model, at, offerId }));
      }
      const quotaMatch = /^\/quota\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && quotaMatch) {
        return json(response, 200, await bench.quota(quotaMatch[1]));
      }
      return json(response, 404, { error: '未知路由' });
    } catch (error) {
      return json(response, 500, { error: error.message, stack: error.stack });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    bench,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await startWorkbench({
    sourceUrl: process.env.SOURCE_URL ?? 'http://127.0.0.1:4180',
    port: Number(process.env.PORT ?? 4181),
    stateFile: process.env.STATE_FILE ?? new URL('../state/workbench.json', import.meta.url).pathname,
    seedOffersFile: new URL('../data/issued-offers.json', import.meta.url),
  });
  console.log(`报价工作台已启动：${service.url}`);
}
