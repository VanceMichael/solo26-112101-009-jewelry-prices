# 黄金饰品门店牌价和工费的有效报价采集

品牌页 `/brands/yun/gold` 给出基准克价的 UTC 生效时间和成色。门店目录 `/shops` 给出门店 IANA 时区和价目链接，夜场日期按门店本地时间读取。活动编号只在门店内有意义，列表页的 `data-batch` 表示一起签发的页面集合。活动发布有“发布中”和“覆盖已结束”，后者还需实际到齐目录链接的页，页面空白和收到撤下是不同事实。新批在 `data-batch` 给出替换范围。排除页会限制某活动适用的具体构建代。
 
`/designs` 给出款号、构建代、重量及生效区间，`/labor` 给出按件或按克的工费，同款号的新构建代不自动继承报价规则。以分计算的最后结果按小数两位四舍五入；如果条款不说明两个可选折扣的选择权，由店员或顾客选择一种合法报价，不能默认作承诺。门店核定与已经发出的票据分别从 `/shops/clarifications` 和 `data/issued-offers.json` 获取。核定只覆盖本店明确列出的条款。报价票据撤销记录包含唯一票据号。历史公示的东店第 40 期仍可在 `/shops/east/history/40` 查看。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t jewelry-prices-sources .`，再执行 `docker run --rm jewelry-prices-sources`。镜像准备完成后的验证不需要外网。

## 柜台优惠额度

`/counter/门店/allocations` 返回活动期件数上限与门店柜台实际占用回执。 `release-requested` 为申请释放，`released` 确认已回收，`redeemed` 表示已兑现并计入当期消耗。报价占用请求可提交到 `POST /counter/门店/allocations`，字段 `offerId`、`promotion`、`period`、`pieces` 和所观察的 `ledgerRevision`。柜台按自身修订判断占用，一家店的明细与另一家独立。窗口超时时可查询该门店实际登记的票号。

# 采集与报价工作台（src/）

工作台只消费上面的本地合成来源，不接外网；全部代码仅用 Node.js 22 标准库。

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `src/time.mjs` | IANA 时区墙钟→UTC、夜场跨日时段解析、分单位四舍五入 |
| `src/parsers.mjs` | 品牌页/活动页/排除页/目录/工费/核定/台账的结构化解析 |
| `src/source-client.mjs` | 抓取与分页，每次成功或失败都留下不可变观察记录 |
| `src/catalog.mjs` | 追加式证据档案；时点视图、批次生命周期、活动状态机 |
| `src/pricing.mjs` | 纯计价：基础价、按克减、工费折扣、互斥/可叠加组合、选择权 |
| `src/ledger.mjs` | 额度占用协商：409 回读重试、202 回查确认、窗口超时处理 |
| `src/offers.mjs` | 票据库：原凭据兑现、绑定票号撤销、到期、履约价差复核 |
| `src/workbench.mjs` | 总装：采集编排、报价、出票、门店并发锁、落盘恢复 |
| `src/server.mjs` / `src/cli.mjs` | HTTP 接口与一次性剧本演练 |

## 关键判定口径

- **证据不全只报基础价**：批次“发布中”或排除页未到齐（HTTP 425 等）时，活动进入 `evidence-pending`，报价只含公开基础价并附等待原因；绝不把猜测的促销总价发成可兑现报价。
- **旧批何时失效**：页面缺失只视为暂停；只有目录确证覆盖结束且链接页实际到齐，或条款/核定明确撤下，旧活动才转为 `withdrawn`。新批未完整签发前，历史刊（如东店第 40 期）仍是可信依据。
- **构建代不自动继承**：公告“适用款”只写款号时，按活动窗口开始时点的目录快照绑定当时现行构建代（PR-2“K-12 细链”锁 n7，不沿用到拆分后的 n8）。
- **店员核定的边界**：只能更正本店条款的生效时间/归属；任何携带品牌价字段或来源门店不明的条目都会被拒绝并留痕，品牌克价始终以品牌页为准。
- **票据不可改写**：已发出票据在有效期内按原凭据兑现；只有绑定报价号的 `stop-honoring` 确认或到期才终止。资料更正产生价差时，票据进人工联系队列并附更正出处，但不改变原票据金额。
- **额度按实际占用**：`allocated`、`release-requested`、`redeemed` 都占额度，仅 `released` 回收。POST 返回 409 回读最新修订重试；返回 202 只算收件，须回查台账确认票号，未确认不出票。
- **互斥与选择权**：公告声明互斥的活动不组合；未指定两个可选折扣的选择权时，候选报价标记 `selectionRequired`，由店员或顾客选定，工作台不默认承诺。
- **复盘双视角**：`evidence-pending` 表达“当时未采到”，`excluded/withdrawn/outside-window` 表达“当前已证实不适用”，两者在复盘接口中分别呈现。

## 运行方式

```bash
npm ci
npm run sources          # 终端 A：合成来源，:4180
npm run workbench        # 终端 B：工作台 HTTP，:4181（SOURCE_URL/PORT/STATE_FILE 可覆盖）
npm run demo             # 单进程跑完 initial → published → clarified 三阶段剧本
npm test                 # 来源契约 + 单元 + 端到端，共 29 项
```

## HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /collect` | 采集一轮，body 可带 `history:[{shop,issue}]` 补采历史刊 |
| `GET /quote?shop=&model=&at=` | 门店、款号、时点的可兑现报价与全部出处 |
| `POST /offers` | 按所选口径出票；促销口径先过额度协商，未确认占用不出票 |
| `GET /offers/:id?at=` | 票据状态：honorable / stopped / expired，声明是否按原凭据兑现 |
| `GET /review?at=` | 履约价差与人工联系队列，附每条更正出处 |
| `GET /evidence?shop=&model=&at=&offerId=` | 当时所见的牌价、工费、活动来源与未采/不适用区分 |
| `GET /quota/:shop` | 门店额度台账摘要（上限、已占、可用、逐项状态） |

工作台状态默认落盘到 `state/workbench.json`（已在 `.gitignore` 忽略），重开服务后票据与档案完整恢复；`data/issued-offers.json` 作为启动种子票据载入，工作台自身不回写该文件。
