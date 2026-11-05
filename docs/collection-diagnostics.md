# 生产采集诊断

这些日志需要部署包含本次改动的 Worker 后才会出现，不会补写历史运行日志。
`wrangler.jsonc` 已启用 Workers Logs，采样率为 1。

## 获取一次新运行的日志

1. 确认新分组及其目标都已保存并启用。仅添加分组不会产生检索任务。
2. 在项目目录运行 `npx wrangler tail skyeyes-monitor --format json`，或打开 Cloudflare 中该 Worker 的日志页面。
3. 在「数据」页点「手动运行」，只选择需要排查的新分组后开始采集（支持多选）；无须跑全量。记下 `run started` 的 `runId`。重新入队只沿用原任务目标列表，不会加入新增目标。
4. 按 `runId` 和新分组的 `countryId` / `countryName` 查找下列事件。运行级事件没有 countryId，要单独保留。
5. 导出这次运行的相关日志；如果仍在等待，保留最后的 `batch deferred` 和下一次 `batch started`。

日志包含分组名、目标名、检索词及实际查询表达式；没有请求头、API Key、响应正文或分页 cursor。
分享日志时可将业务名称和检索词一致地替换为代号，保留 ID、计数、HTTP 状态、step/page 和 reasons。

## 按事件定位

| message | 表示什么 | 需要看什么 |
| --- | --- | --- |
| `run group planned` | 启用的分组已被纳入本次计划 | `targetCount`、`termCount`、`sources`；目标数 0 表示没有启用的目标 |
| `run started` | 目标读取及批次创建完成 | `runId`、窗口起止、`deadlineAt`、目标总数；不代表队列已消费 |
| `batch started` | 某个来源开始或恢复执行 | `source`、`resumeStep`、`resumePage` |
| `source query request` | 等待限速和预算检查通过，开始调用上游 | 分组/目标、`terms`、实际 `query`、`step`、`page`、Google News 的 `edition` |
| `source query response` | 上游已返回 HTTP 响应头 | `status`、`elapsedMs`；200 仍需检查解析结果，耗时不含读取正文 |
| `source query error` | fetch 抛出网络异常 | 当前目标及异常类型；无响应正文 |
| `source query result` | 本页数据解析和命中校验完成 | `rawItems` 为上游列表条数；`matchedItems` 为有效命中；`rejectedItems` 为无效记录、排除词或未命中造成的差额 |
| `source page stored` | 本页记录处理及进度保存完成 | `inserted`、`added`、`storeOnly`、`reasons`、`unprocessed`、`nextStep` / `nextPage` |
| `batch deferred` | 限流、预算、执行时间或并发限制触发续跑 | `batchId`、`delaySeconds`、`deferCount`；结合前后的分页事件判断进度 |
| `batch done` | 当前来源链完成 | `scope: invocation` 表示仅本次队列调用处理的计数，包含分页回调；跨续跑累计值以 D1 batches 为准 |
| `batch retry` / `batch failed` | 本次批次出现异常 | `runId`、`batchId`、`error`；配合同一批次最后的查询事件 |
| `run finalized` | 运行收尾 | `reason: deadline` 表示按截止时间收尾，`incomplete` 表示不完整 |

没有新分组的 `run group planned`：先查任务启动时分组是否启用、是否保存到当前 Worker 绑定的 D1、是否查看了正确的 Worker 和 runId。若 D1 的 `countries` 表本身就找不到新分组，应先检查后台保存请求和生产数据库绑定。

有计划但没有该目标的 request：不能判定“上游没有数据”。查看相同 source 的最后一个 step、续跑位置和运行是否提前结束。step/page 从 0 开始；X 的 step 按目标/检索词，Google News 还按版本展开，GDELT 按打包查询展开，不直接等于目标序号。

有 response 但没有 result：可能在读取正文、解析数据时失败，或执行被中止。检查同一 batchId 的后续错误及平台异常。

`rawItems = 0` 表示解析后的上游列表为空；它不能单独证明上游返回格式正确。应结合 HTTP 状态和是否出现解析异常判断。

## 入库阶段 reasons

| reason | 含义 |
| --- | --- |
| `global_duplicate` | 与数据库已有记录或本页已接受内容的链接/标题重复；跨分组，也包含历史隐藏记录 |
| `page_duplicate_or_invalid` | 当前页按标识/URL 去重，或记录缺少有效 URL |
| `insert_conflict` | 写入时 dedupe_key 已存在，没有新增行 |
| `time:out_of_window` | 发布时间不在本次窗口，丢弃 |
| `time:unknown` | 发布时间不明，入库但不进入日报 |
| `relevance` | 相关度不通过，入库但不进入日报 |
| `rule:short` / `rule:word` / `rule:blocked` | 正文太短、命中全局排除词或账号被屏蔽 |
| `rule:retweet` / `rule:ad` | 转发或广告 |
| `rule:followers` / `rule:account_age` | 粉丝数或账号年龄不达标 |
| `missing_attribution` | 缺少目标或命中词 |
| `record_error` | 处理单条记录时异常，另查 `record skipped` |

`inserted` 是新增数据库行数，`added` 是其中可进入日报的行数，`storeOnly` 是其中仅入库的行数。
`unprocessed > 0` 且 `deferred = true` 表示本页尚未处理完，会重抓这一页；重抓可使 rawItems、去重等计数重复出现，不能把日志简单相加当作唯一新闻总数。

例如新分组出现 `rawItems: 10, matchedItems: 10`，随后 `added: 0, reasons: {global_duplicate: 10}`，说明确实查询到了内容，但全部与已有记录重复；应核对旧分组内容归属，而非重试上游接口。

## API 指定手动采集范围

`POST /api/runs` 的 JSON 请求体可传 `{"countryIds":["分组 ID"]}`，多选时传多个 ID。
省略 countryIds 表示全量；空数组、null、未知/停用分组，以及没有启用目标的所选分组都会返回 400，不会退回全量。
已有任务时仍返回 409；确认取消重开时传 `{"confirm":true,"countryIds":["原选择的分组 ID"]}` 保持范围。
范围校验发生在取消旧任务之前，无效范围不会取消旧任务。
