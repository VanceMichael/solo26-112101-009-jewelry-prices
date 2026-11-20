# 黄金饰品门店牌价和工费的有效报价采集

品牌页 `/brands/yun/gold` 给出基准克价的 UTC 生效时间和成色。门店目录 `/shops` 给出门店 IANA 时区和价目链接，夜场日期按门店本地时间读取。活动编号只在门店内有意义，列表页的 `data-batch` 表示一起签发的页面集合。活动发布有“发布中”和“覆盖已结束”，后者还需实际到齐目录链接的页，页面空白和收到撤下是不同事实。新批在 `data-batch` 给出替换范围。排除页会限制某活动适用的具体构建代。
 
`/designs` 给出款号、构建代、重量及生效区间，`/labor` 给出按件或按克的工费，同款号的新构建代不自动继承报价规则。以分计算的最后结果按小数两位四舍五入；如果条款不说明两个可选折扣的选择权，由店员或顾客选择一种合法报价，不能默认作承诺。门店核定与已经发出的票据分别从 `/shops/clarifications` 和 `data/issued-offers.json` 获取。核定只覆盖本店明确列出的条款。报价票据撤销记录包含唯一票据号。历史公示的东店第 40 期仍可在 `/shops/east/history/40` 查看。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t jewelry-prices-sources .`，再执行 `docker run --rm jewelry-prices-sources`。镜像准备完成后的验证不需要外网。

## 柜台优惠额度

`/counter/门店/allocations` 返回活动期件数上限与门店柜台实际占用回执。 `release-requested` 为申请释放，`released` 确认已回收，`redeemed` 表示已兑现并计入当期消耗。报价占用请求可提交到 `POST /counter/门店/allocations`，字段 `offerId`、`promotion`、`period`、`pieces` 和所观察的 `ledgerRevision`。柜台按自身修订判断占用，一家店的明细与另一家独立。窗口超时时可查询该门店实际登记的票号。
