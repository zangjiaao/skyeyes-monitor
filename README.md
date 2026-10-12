# skyeyes-monitor

Cloudflare Workers 上的每日监测：按北京时间每天 10:00，把过去 24 小时里与监测对象相关的 X 帖子和网页/新闻收进 D1，译成中文，重新生成一份累积 Excel，并给同一份收件人名单发一封汇总邮件。

监测窗口是 **昨天 10:00（含）到今天 10:00（不含）**，时区固定为 Asia/Shanghai（UTC+8，无夏令时）。对应的 Cron 是 UTC `0 2 * * *`。11:00（UTC `0 3 * * *`）如果还有批次没跑完，会把已经入库的内容发出去，并在邮件里注明未完成批次。

国家、监测对象、关键词和收件人只放在 D1。仓库里的 `seed/example.sql` 全是占位符，不要把真实名单提交到这个公开仓库。

## 架构

```text
Cron 10:00 北京时间
  -> 按国家、按来源把监测对象拼成 OR 查询
  -> 每个批次一条 Cloudflare Queue 消息（并发 1，失败重试）
       -> X：twitterapi.io advanced search（可替换）
       -> 网页：Google News RSS 和/或 GDELT（可替换）
  -> 按 URL / 帖子 ID 去重后写入 D1，并用 Workers AI 译成中文
  -> 全部批次完成，或延迟约 1 小时 / 11:00 截止
  -> 用 D1 全量历史重写 R2 里的 skyeyes.xlsx
  -> 一封邮件发给全部收件人（正文是当日摘要，附件或下载链接是 Excel）
```

Excel 只有一个固定对象名（默认 `skyeyes.xlsx`），每次运行都覆盖。里面有：

- `总览`：每个国家的累计、今日、昨日条数
- `今日` / `昨日`：按收集日筛出的视图（收集日是本次窗口结束那天的北京日期）
- 每个有数据的国家一张表，列里带「是否今日」「是否昨日」

来源、邮件通道都走接口，换实现时改 `src/providers/index.ts` 或 `src/email/index.ts`，再用 Wrangler 变量选中它。

## 你需要事先准备

1. Node.js 22 或更新版本。
2. Cloudflare 账户。Queues、D1、R2、Workers AI、Cron 和 Email Sending 以你账户当前套餐为准。Email Sending 需要把发信域名接到 Cloudflare DNS，并且目前在 Workers Paid 上提供，见 [Email Service 文档](https://developers.cloudflare.com/email-service/)。
3. [twitterapi.io](https://twitterapi.io/) 的 API Key，用于 X advanced search。网页源（Google News RSS、GDELT）不需要密钥。
4. 若用 Resend 而不是 Cloudflare Email：已验证的发信域名和 Resend API Key。

克隆后安装依赖：

```bash
npm ci
```

## 手动设置（按顺序做完才能真正跑起来）

下面每一步都要人来做。GitHub Actions 只会在 `main` 上执行迁移和 `wrangler deploy`，它不会替你创建数据库、桶、密钥或监测名单。

### 1. 登录 Wrangler

```bash
npx wrangler login
```

### 2. 创建 D1，并把 database_id 写进配置

```bash
npx wrangler d1 create skyeyes-monitor
```

把命令输出的 `database_id` 填进 `wrangler.jsonc` 里 `d1_databases[0].database_id`，替换占位 UUID `00000000-0000-4000-8000-000000000000`。数据库名字保持 `skyeyes-monitor`，绑定名保持 `DB`。

资源 ID 不是密钥，可以提交。不要把 API Token 写进这个文件。

### 3. 创建 R2 桶

```bash
npx wrangler r2 bucket create skyeyes-exports
```

名字必须和 `wrangler.jsonc` 里的 `bucket_name` 一致。Worker 会把 Excel 写到这个桶的固定对象名（默认 `skyeyes.xlsx`）。

### 4. 创建队列

部署时 Wrangler 也会按配置创建队列。建议先显式建好，避免第一次部署因权限失败：

```bash
npx wrangler queues create skyeyes-collect
npx wrangler queues create skyeyes-collect-dlq
```

消费者配置是：主队列并发 1、每批 1 条、最多重试 3 次、重试间隔 60 秒，耗尽后进入 `skyeyes-collect-dlq`。这是限速手段。X 和网页共用这条队列，所以同一时刻只会打一个外部请求。监测对象变多、想加快时，再把 `max_concurrency` 调大，并留意 twitterapi.io 的额度。

### 5. 开通 Workers AI

在 Cloudflare 仪表盘确认账户可以使用 Workers AI。翻译默认模型是 `@cf/meta/m2m100-1.2b`（绑定名 `AI`）。

可选备用模型写在变量 `TRANSLATION_FALLBACK_MODEL`。留空表示没有备用。主模型失败或返回空译文时才会调用备用模型；两个都失败时，该行的中文译文留空，下次汇总会再补一批。已经主要是中文的正文不会再译。

### 6. 准备发信

二选一，并让 `wrangler.jsonc` 的 `EMAIL_PROVIDER` 与之对应。

**Cloudflare Email Service（默认 `EMAIL_PROVIDER=cloudflare`）**

1. 打开仪表盘 **Compute → Email Service → Email Sending**，Onboard 你的域名。
2. 确认 Cloudflare 写入的 SPF、DKIM、DMARC 记录已经生效。
3. 把 `EMAIL_FROM` 设成该域名上的地址，例如 `monitor@yourdomain.com`。
4. Worker 使用 `send_email` 绑定 `EMAIL`，不需要把 Cloudflare API Token 放进 Worker。

文档：[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)。单封邮件含附件不超过约 5 MiB，收件人合计不超过 50。程序会按 40 人一封拆开，内容相同。附件更大时只放下载链接。

**Resend（`EMAIL_PROVIDER=resend`）**

1. 在 Resend 验证发信域名。
2. `EMAIL_FROM` 使用该域名上的地址。
3. 把 Resend API Key 放到下面的 `RESEND_API_KEY`。

用 Cloudflare Email 时，`RESEND_API_KEY` 仍然要存在，因为 `secrets.required` 会在部署时检查这个名字。值可以是 `unused`。

### 7. 修改非密钥变量

在 `wrangler.jsonc` 的 `vars` 里至少改这两项，然后随代码一起部署：

| 变量 | 作用 |
| --- | --- |
| `EMAIL_FROM` | 发信地址。空字符串时仍会生成 Excel，但不会发信，运行备注里会写明原因。 |
| `PUBLIC_BASE_URL` | Worker 的公网根地址，不要末尾斜杠。第一次部署后从 `*.workers.dev` 或自定义域抄过来，再部署一次。邮件里的下载链接用它签名。 |

其他常用变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `X_PROVIDER` | `twitterapi_io` | X 实现的 id |
| `WEB_PROVIDER` | `both` | `google_news`、`gdelt` 或 `both` |
| `EMAIL_PROVIDER` | `cloudflare` | `cloudflare` 或 `resend` |
| `EXCEL_OBJECT_KEY` | `skyeyes.xlsx` | R2 对象名，只允许字母、数字、`.`、`_`、`-` |
| `BATCH_MAX_TERMS` | `12` | 一条 OR 查询最多几个监测对象 |
| `BATCH_MAX_QUERY_CHARS` | `400` | OR 子句的字符预算（时间条件另加） |
| `MAX_SEARCH_PAGES` | `5` | twitterapi.io 每个批次最多翻页数，每页最多约 20 条 |
| `X_QUERY_SUFFIX` | `-filter:replies` | 追加到 X 查询后的操作符；置空则不加 |
| `X_MAX_QUERY_CHARS` | `900` | 完整 X 查询超过此长度则该批次失败且不重试 |
| `FINALIZE_DELAY_SECONDS` | `3600` | 开始采集后多久强制汇总（约 11:00） |
| `DEADLINE_MIN_AGE_SECONDS` | `3000` | 11:00 的 Cron 只汇总创建时间早于此值的运行，避免误伤刚手动触发的任务 |
| `MAX_EXCEL_ROWS` | `20000` | Excel 最多行数，超出时保留最近的行并在邮件里说明 |
| `NEWS_HL` / `NEWS_GL` / `NEWS_CEID` | `en-US` / `US` / `US:en` | Google News RSS 的地区版本 |

`BATCH_MAX_QUERY_CHARS` 只限制 OR 子句。X 查询还会加上 `since_time` / `until_time`（Unix 秒）。twitterapi.io 不支持旧的 `since:YYYY-MM-DD` 写法。

### 8. 写入 Worker 密钥

这些密钥只通过 Wrangler 进 Worker，不要写进 Git、不要写进 `wrangler.jsonc`、也不要只放在 GitHub Actions 里（Actions 读不到 Worker 的运行时密钥）。

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put TWITTERAPI_IO_KEY
npx wrangler secret put RESEND_API_KEY
```

| 密钥 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 管理接口的 Bearer。也用来给 Excel 下载链接做 HMAC。请用长随机串。 |
| `TWITTERAPI_IO_KEY` | twitterapi.io 的 `X-API-Key`。 |
| `RESEND_API_KEY` | Resend 的 API Key。用 Cloudflare Email 时填 `unused`。 |

本地开发把同样三个名字写进 `.dev.vars`（可从 `.dev.vars.example` 复制）。`.dev.vars` 已被 gitignore。

`wrangler secret put` 会立刻部署一个新版本。第一次可以先跳过，等配置改完后在下面的部署步骤里一起做；但如果 `secrets.required` 里的名字还没设置，`wrangler deploy` 会失败并列出缺哪些。

### 9. 准备 GitHub Actions 密钥

仓库 **Settings → Secrets and variables → Actions** 新增：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 给 Actions 里的 `wrangler d1 migrations apply` 和 `wrangler deploy` 用 |
| `CLOUDFLARE_ACCOUNT_ID` | 账户 ID |

Token 用账户 API Token，不要用全局 API Key。建议权限：

- Account / Workers Scripts / Edit
- Account / D1 / Edit
- Account / Queues / Edit
- Account / Workers R2 Storage / Edit（绑定已有桶时，若部署报权限不足再补上）
- Account / Account Settings / Read

Workers AI 和 Email Sending 在运行时走绑定，一般不需要把它们的 Token 放进 GitHub。若部署日志要求额外权限，按报错补上最小权限即可。说明见 [GitHub Actions 部署文档](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。

不要把 `ADMIN_TOKEN`、`TWITTERAPI_IO_KEY`、`RESEND_API_KEY` 放进 GitHub。它们属于 Worker，用第 8 步的 `wrangler secret put`。

### 10. 执行数据库迁移

```bash
npx wrangler d1 migrations apply DB --remote
```

本地模拟库：

```bash
npx wrangler d1 migrations apply DB --local
```

`main` 分支上的 GitHub Actions 会在部署前再执行一次远程迁移。迁移文件在 `migrations/`，只建表，不含名单。

### 11. 写入监测对象和收件人

真实名单不要进 Git。两种方式：

**管理 API（推荐）**

部署完成后，用 `ADMIN_TOKEN`：

```bash
BASE=https://skyeyes-monitor.<account>.workers.dev
TOKEN=你的ADMIN_TOKEN

curl -sS -X POST "$BASE/admin/countries" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"code":"country-a","name":"Country A"}'

curl -sS -X POST "$BASE/admin/targets" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"countryCode":"country-a","kind":"person","name":"显示名","query":"检索短语"}'

curl -sS -X POST "$BASE/admin/recipients" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"ops@example.com"}'
```

`kind` 只能是 `person`、`organization` 或 `keyword`。`query` 是一条检索短语：含空格时会加引号；像 `from:example` 这样没有空格的写法会原样放进查询。每个对象是一个短语，不要在一个 `query` 里写 `OR`。

当前规模按两个国家、每国大约 50–100 个对象设计。程序会把它们拼成 OR 批次，而不是一人一次 API。

删除：

```bash
curl -sS -X DELETE "$BASE/admin/targets/1" -H "authorization: Bearer $TOKEN"
curl -sS -X DELETE "$BASE/admin/recipients/1" -H "authorization: Bearer $TOKEN"
curl -sS -X DELETE "$BASE/admin/countries/1" -H "authorization: Bearer $TOKEN"
```

国家下面还有监测对象时不能删国家。历史记录会保留当时的国家名和命中对象，不随删除而消失。

查看：

```bash
curl -sS "$BASE/admin/countries" -H "authorization: Bearer $TOKEN"
curl -sS "$BASE/admin/targets?country=country-a" -H "authorization: Bearer $TOKEN"
curl -sS "$BASE/admin/recipients" -H "authorization: Bearer $TOKEN"
```

**SQL 种子**

`seed/example.sql` 只有占位国家、占位对象和 `ops-placeholder@example.com`。可以拿它做一次冒烟测试：

```bash
npx wrangler d1 execute DB --remote --file=seed/example.sql
```

要写入真实数据时，把文件复制为 `seed/local.sql`（已被 gitignore）再执行，不要提交那个文件。冒烟之后请删掉占位收件人，避免日报发到 example.com。

### 12. 部署

本地第一次：

```bash
npx wrangler deploy
```

之后推到 `main` 即可。`.github/workflows/ci.yml` 会：

- 所有 PR：`npm run typecheck` 和 `npm test`
- 推到 `main`：`npx wrangler d1 migrations apply DB --remote`，然后 `npx wrangler deploy`

PR 不会部署，所以没有 Cloudflare 密钥时 PR 检查仍然可以是绿的。`main` 上的部署在第 2–9 步完成之前会失败，这是预期行为。

部署成功后，把 `https://skyeyes-monitor.<你的子域>.workers.dev` 写入 `PUBLIC_BASE_URL`，再部署一次，邮件里才会有下载链接。

### 13. 手动触发（测试）

不必等到 10:00。手动触发使用「最近一个已经到达的北京时间 10:00」作为窗口结束点：下午触发拿到的仍是当天 10:00 往前 24 小时，不会把下午的新内容算进窗口。同一收集日已有运行记录时会跳过，除非加上 `force=1`。`force=1` 会再打一遍外部 API。

```bash
curl -sS -X POST "$BASE/admin/trigger" -H "authorization: Bearer $TOKEN"
curl -sS -X POST "$BASE/admin/trigger?force=1" -H "authorization: Bearer $TOKEN"
curl -sS "$BASE/admin/runs/latest" -H "authorization: Bearer $TOKEN"
```

队列在生产环境是异步的。想立刻生成 Excel 和邮件，而不是等批次跑完或等到 11:00：

```bash
curl -sS -X POST "$BASE/admin/runs/<runId>/finalize" -H "authorization: Bearer $TOKEN"
```

这会把当时已经入库的数据发出去，未完成批次记在备注里。已经汇总过的运行要重发邮件：

```bash
curl -sS -X POST "$BASE/admin/runs/<runId>/finalize?force=1" -H "authorization: Bearer $TOKEN"
```

如果入队中途失败，批次还是 `pending`，可以补投队列：

```bash
curl -sS -X POST "$BASE/admin/runs/<runId>/requeue" -H "authorization: Bearer $TOKEN"
```

健康检查不需要令牌，也不读数据库：

```bash
curl -sS "$BASE/health"
```

本地：

```bash
npx wrangler dev
```

默认打到本地 D1/R2/Queue 模拟。不要随手加 `--remote`，那会连到生产库。twitterapi.io 只要 `.dev.vars` 里有密钥，就会打到真实 API 并消耗额度。本地 Email 绑定只会把邮件写到 Wrangler 的本地输出，不会真的送出。

看日志：

```bash
npx wrangler tail
```

日志是 JSON。里面不会写监测词、国家名或收件人地址。

## 定时与补跑

| 北京时间 | UTC Cron | 行为 |
| --- | --- | --- |
| 10:00 | `0 2 * * *` | 创建运行，按国家/来源/OR 批次入队 |
| 批次全部完成时 | 无 | 立刻汇总 |
| 开始后约 1 小时 | 队列延迟消息 | 没完成也汇总，邮件注明未完成批次 |
| 11:00 | `0 3 * * *` | 再扫一遍创建时间已超过 `DEADLINE_MIN_AGE_SECONDS` 的未完成运行 |

晚到的批次仍会入库。当天那封邮件可能不包含它们，下一次生成 Excel 时会从 D1 重新导出，所以会进历史表。

去重键是 `来源:帖子ID`，没有帖子 ID 时用 URL。重复内容不会再插一行。

X 结果会丢掉回复和转推。网页结果会尽量按发布时间再滤一遍窗口；没有发布时间的网页条目会保留。

## Excel 和邮件

邮件只有一封逻辑上的日报（收件人多于 40 时拆成多封相同内容），名单是 D1 里全部 `active` 收件人，不按国家拆分。

正文是中文摘要：窗口、完成/部分完成、新增条数、未翻译条数、未完成批次数、各国 X/网页新增数。

附件是 `skyeyes.xlsx`。超过通道上限时不附件，只给链接。链接形如：

```text
https://<PUBLIC_BASE_URL>/download/skyeyes.xlsx?exp=<unix>&sig=<hmac>
```

签名密钥是 `ADMIN_TOKEN`，默认 7 天有效（`DOWNLOAD_TTL_SECONDS`）。没有有效签名会返回 403。对象不存在会返回 404。

## 换数据源或邮件通道

1. 实现 `ContentProvider`（`src/providers/types.ts`）或 `EmailProvider`（`src/email/types.ts`）。
2. 在 `src/providers/index.ts` 或 `src/email/index.ts` 里用一个新的 id 注册。
3. 把 `X_PROVIDER`、`WEB_PROVIDER` 或 `EMAIL_PROVIDER` 改成那个 id 并部署。

队列消息里只有 `runId` 和 `batchId`。检索词在消费者里从 D1 读取，避免出现在 Queue 的消息预览里。

## 记录字段

每条命中写入 `records`：原文、发布时间、作者账号、作者显示名、作者主页、来源（`x` 或 `web`）、URL、国家、命中对象、收集日、中文译文。命中对象优先用正文里真正出现的名字；对不上时记下该批次的全部对象，避免丢行。

## 开发

```bash
npm run typecheck
npm test
npm run build   # wrangler deploy --dry-run，只检查打包
```

测试覆盖北京时间窗口、OR 分批、以及 Excel（总览 / 今日 / 昨日 / 分国家、历史行、公式转义和 xlsx 回读）。

生成绑定类型（改 `wrangler.jsonc` 后执行，并提交 `worker-configuration.d.ts`）：

```bash
npm run cf-typegen
```
