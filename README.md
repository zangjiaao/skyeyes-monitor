# SkyEyes Monitor

每天从 X 和网页新闻里收集监测对象的新内容，存进 D1，翻译成中文，覆盖更新同一份 Excel，并给一组收件人发一封汇总邮件。管理后台和接口在同一个 Cloudflare Worker 里。

默认时区是 `Asia/Shanghai`。Cron 每小时触发一次，Worker 再对照数据库里的时刻决定要不要开跑。默认是每天 10:00，采集窗口是前一天 10:00 到当天 10:00。

分组、监测对象、关键词和收件人只放在 D1。这个仓库是公开的，迁移里只有占位示例。API 密钥只通过 Wrangler secrets 和 GitHub Secrets 注入，后台只显示「已配置 / 缺失」和开关，不会回显密钥。

## 仓库里有什么

- `src/`：Hono API、定时任务、队列消费、数据源、翻译、Excel、邮件
- `admin/`：React 19 + Vite + Astryx（StyleX）管理后台，构建结果由同一个 Worker 当作静态资源提供
- `migrations/`：D1 表结构和占位种子
- `.github/workflows/ci.yml`：PR 上做类型检查、测试和构建；推到 `main` 后应用 D1 迁移并 `wrangler deploy`。`wrangler.jsonc` 里 `preview_urls` 为 false，部署不会生成版本预览地址。

数据源实现 `search(targets, window) -> 统一记录`。现在有 X（twitterapi.io）、Google News RSS、GDELT。Reddit / Telegram 以后按同一接口加。

## 你必须手工完成的步骤

按顺序做。跳过任何一项，部署或第一次运行都会停在缺资源、缺密钥或打不开后台。

### 1. 准备账号和工具

- 一个 Cloudflare 账号，并开通 Workers、D1、R2、Queues、Workers AI。Queues、Cron 和较高的子请求额度通常需要 Workers 付费计划。
- 本机安装 Node.js 22。
- 克隆本仓库后执行 `npm ci`。

### 2. 登录 Wrangler

```bash
npx wrangler login
```

确认 `npx wrangler whoami` 里的账号就是要部署的那个。

### 3. 创建 D1，并把 database_id 写进配置

```bash
npx wrangler d1 create skyeyes-monitor
```

把命令输出的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases[0].database_id`。现在文件里是占位 UUID `00000000-0000-0000-0000-000000000000`，不替换的话远端迁移和部署都会失败。

数据库名必须保持 `skyeyes-monitor`，和配置、CI 命令一致。

然后应用迁移。先本地，再远端：

```bash
npx wrangler d1 migrations apply skyeyes-monitor --local
npx wrangler d1 migrations apply skyeyes-monitor --remote
```

迁移会建表，并写入两个占位分组、几条占位目标和一个停用的 `placeholder@example.com`。这些不是真实名单。

### 4. 创建 R2 存储桶

```bash
npx wrangler r2 bucket create skyeyes-monitor
```

Excel 固定写在这个桶的 `skyeyes.xlsx`（配置项 `excel_key` 可以改名，但每次运行都覆盖同一个对象，不会按日期另存新文件）。

### 5. 创建队列

```bash
npx wrangler queues create skyeyes-collect
npx wrangler queues create skyeyes-collect-dlq
```

一次运行按来源各发一条采集链（X、Google News、GDELT 最多三条），链里按分组和目标顺序处理全部检索词和翻页。队列消息只是唤醒：批次状态以 D1 为准。消费者拿到消息后用条件 `UPDATE` 领取批次；重复投递、过期消息都不会把同一批次做两遍。真正失败、重试耗尽的消息进死信队列，对应批次标为失败。只是在等时间槽或 429 的批次不会因为旧消息进死信而失败。如果某次 `wrangler deploy` 提示队列已自动创建，以命令输出为准，名字必须仍是这两个。

`wrangler dev` 的队列在进程内存里。重启后消息会丢，D1 里这些批次仍可能是 `queued` 且 `enqueued_at` 已填，或停在 `running`。状态页的「恢复卡住的批次」会把它们收回来。线上队列不会因为重启 Worker 而丢消息，但恢复同样能接手租约过期的批次。

Cloudflare Queues 的 `sendBatch` 一次最多 **100 条**，请求体最多 **256KB**。三条来源链一次就能发完。X、GDELT、Google News 各有自己的 D1 时间槽，三条链可以并行，但同一条链里的请求按 `x_qps`、GDELT 间隔或 Google News 间隔在这次调用里睡觉，不再为每个目标各发一条消息。槽位或墙钟预算装不下下一次等待时，当前消息被确认，再另发 **一条** 带 `delaySeconds` 的续跑，不调用 `message.retry()`，因此不占用队列的 5 次重试。墙钟预算是 8 分钟，低于队列消费者 15 分钟的上限。`wrangler.jsonc` 里消费者 `max_concurrency` 是 8。如果本地 `wrangler.local.jsonc` 仍把它留在 1，`wrangler dev` 会一次只跑一条链，改成 8 才和线上一致。配置项 `queue_concurrency` 默认 4，范围 1–8。超过上限的链等 30 秒再继续，不会每几秒重试一次。

每个批次有 `enqueued_at`：写入队列成功才填上。领取时写入 `lease_token` 和 `lease_expires_at`（10 分钟），并清掉 `next_wake_at`。开始采集时 `attempts` 加一；因为时间槽、并发上限或 429 而推迟时，这次不计入 `attempts`。推迟次数和累计等待记在 `defer_count`、`defer_wait_sec`，上限是 2000 次或 6 小时，超过才标为「等待过久」。缺密钥、解析失败，以及其他 4xx/5xx，才 `message.retry()`，重试耗尽后进死信。已经抓到的页会马上入库，进度（来源、检索词序号、页码、cursor）写在 `resume_json`，下次唤醒从这里继续，不从头再抓。免费版每次调用最多 50 次外部子请求。`subrequest_budget` 默认 40，Google News、GDELT、X 的每次抓取，以及 DeepSeek 和 Workers AI 的翻译、相关度评分都计入。快到子请求预算或 8 分钟墙钟时，进度仍写入 `resume_json`，再用 `delaySeconds` 为这条来源链重新入队，不调用 `message.retry()`。三条链都结束后只发一条收尾消息（`0016_finalize_once.sql` 的 `finalize_enqueued_at`）。D1、R2、Queue 绑定走另一档 1000 次 Cloudflare 服务子请求，不占这 50 次。某一链入队失败时，运行记成「部分失败」或「失败」，说明是「未入队：…」。迁移是 `0011_batch_enqueue.sql`、`0014_batch_lease.sql`、`0015_batch_defer.sql` 和 `0016_finalize_once.sql`。

整点 Cron、手动运行开始前，都会收回租约已过期的 `running` 批次，并重发超过 15 分钟仍没有进展的唤醒。已经排期、`next_wake_at` 还在未来的批次，定时收回不会提前重发。状态页的恢复会立刻重发，包括这些还没到点的唤醒，用来捡回 `wrangler dev` 重启后丢掉的延迟消息。同一运行上的重复唤醒由条件更新吃掉。`attempts` 达到 5 次就标为失败，原因是「超过重试次数」。这 5 次只计真正开始采集后的失败，不计让槽和 429。

已经有进行中的运行（`running`、`partial` 或正在收尾）时，新的手动运行和整点 Cron 都不会再开一轮。手动运行会先问要不要取消当前这一轮。确认后，当前运行和它全部未完成批次（含已入队和进行中）标成 `cancelled`，消费者在开始前和写入前都会再看一眼，取消了就直接确认消息、不再写入。入队状态同步不会把已取消的运行改回 `running`。

某一次运行可以单独「恢复」或「取消」。取消会计入状态页的「取消」数量，而不是失败。

### 6. 准备 X 和网页数据源

- 在 [twitterapi.io](https://twitterapi.io/) 申请 API key。采集用的是 `GET /twitter/tweet/advanced_search`，时间范围用 `since_time` / `until_time`（Unix 秒）。每个目标单独查询，目标里的每条检索词再各发一次请求（短语加引号，账号用 `from:`），并带上该目标的排除词。高流量的短词不会占掉其他词的页数。`x_max_pages` 是**每条检索词**最多翻多少页。
- twitterapi.io 按账号限制每秒请求数（[QPS 说明](https://twitterapi.io/qps-limits)）。从未付费的账号是 **0.2 次/秒**（每 5 秒 1 次），付费账号最高 **20 次/秒**。后台配置项 `x_qps` 默认 **0.2**。所有发往 twitterapi.io 的请求，包括同一查询的翻页，都按这个速率占用 D1 里的一个时间槽，并在这条 X 链的同一次调用里等待。新闻链不占这个槽。充值之后在后台「配置」里把「X 每秒请求数」调高即可，例如 `10`，不用重新部署。同时跑几条来源链用 `queue_concurrency`。
- 接口返回 429 时会读取 `Retry-After`。等待不超过 20 秒、且本批次还没为此睡过 3 次，就在当前批次里等待再请求。更长的等待，或没有 `Retry-After` 时的退避（5 秒、10 秒、20 秒，之后封顶 120 秒），会确认当前消息，并按这个延迟另发一条新唤醒。限流和让槽都不算失败，也不占用队列重试次数。状态页的「限流」分别显示 X 和 GDELT 近 24 小时、近 7 日的次数，以及最近几次的 `Retry-After`。
- Google News RSS 和 GDELT 不需要密钥。Google News 必须带版本参数，不写 `hl` / `gl` / `ceid` 并不是全部语言。默认查 `en-US`（`hl=en-US&gl=US&ceid=US:en`）和 `zh-CN`（`hl=zh-CN&gl=CN&ceid=CN:zh-Hans`）。后台「Google News 版本」可以再加 `en-PK`、`ar`（沙特阿拉伯语版 `SA:ar`）、`ar-EG` 等，最多 8 个。每个目标的每条检索词会对每个版本各请求一次，再按链接和标题合并。记录上会留下版本，例如 `en-US`。日期仍是 `after` / `before` 的按天过滤，入库时还要过统一的时间窗口。
- GDELT DOC API 大约每 5 秒只能请求一次。配置项 `gdelt_min_interval_sec` 默认 6 秒，占 D1 里名为 `gdelt` 的时间槽。同一个目标的多条检索词会合成一条 OR 查询（大约 450 字以内），再在本地按最长命中的词归因，排除词仍然生效。遇到 429 或 503 时读取 `Retry-After`，没有响应头就按 30 秒、60 秒、120 秒退避，记一条警告而不是错误。Google News 另有 `google_news_min_interval_sec`，默认 1 秒，设为 0 表示不再额外限速。
- 后台可以分别开关 X、Google News、GDELT。没配 `TWITTERAPI_IO_KEY` 时，X 会显示为未配置，对应批次会失败并出现在状态页，不会把密钥打进日志以外的页面。

### 7. 准备发信

两套实现可以在后台切换，收件人列表相同，所有分组合成一封邮件。

**Resend**

1. 在 Resend 验证发信域名，创建 API key。
2. 后台把邮件服务设为 `resend`，发件人设成该域名上的地址，并打开「发送每日邮件」。
3. 执行下面的 `wrangler secret put RESEND_API_KEY`。

**Cloudflare Email Service**

1. 把发信域名接入 Cloudflare，并执行：

   ```bash
   npx wrangler email sending enable yourdomain.com
   ```

2. 后台把邮件服务设为 `cloudflare`，发件人必须是这个域名上的地址，例如 `skyeyes@yourdomain.com`。
3. Worker 使用 `send_email` 绑定，不需要单独的邮件 API key。当前绑定没有收件人白名单，因此只有能进后台的人可以改收件人。请先接上 Access。

每日邮件正文只写窗口（按配置时区）、各分组的新增条数（来源不多时附上各来源条数）、失败批次数和是否部分完成，再加一行说明完整内容在附件 Excel 里。正文不列原文、摘要或译文。Excel 小于 4MB 时仍整份作为附件；更大时这一行改为下载链接，文件本身仍在 R2。下载链接要在配置里填写 `app_base_url`（站点的 https 根地址，不要以斜杠结尾）。

配置页的「发送测试邮件」调用 `POST /api/email/test`。它使用已经保存的发件人、邮件服务和站点地址，不看「发送每日邮件」开关，开关关闭时也能发。收件人留空则发给全部已启用的地址，也可以只填一个邮箱。正文同样不列条目，只说明完整内容在附件 Excel 里；超过 4MB 时改为下载链接。还没有这份文件时会先生成；生成失败就发一封不带附件的测试信，并在正文里写明原因。页面上显示成功，或邮件服务返回的原文，例如域名未验证、缺少 `RESEND_API_KEY`、发件人为空。Excel 附件本身不变。

没准备好发信之前保持「发送每日邮件」关闭。种子数据里的占位收件人也是停用的。测试邮件不受这个开关影响。

### 8. 写入 Worker 密钥

这些值不要写进 `wrangler.jsonc`、代码或 GitHub 仓库。每条命令都会提示你粘贴，粘贴内容不会出现在命令参数里。

```bash
npx wrangler secret put TWITTERAPI_IO_KEY
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TEAM_DOMAIN
npx wrangler secret put POLICY_AUD
```

| 密钥 | 内容 |
| --- | --- |
| `TWITTERAPI_IO_KEY` | twitterapi.io 的 key。不用 X 时可以先不设。 |
| `DEEPSEEK_API_KEY` | DeepSeek 的 API key。留空时解读会改用 Workers AI，记录不会丢掉。 |
| `RESEND_API_KEY` | Resend 的 key。只用 Cloudflare Email 时可以先不设。 |
| `TEAM_DOMAIN` | `https://<团队名>.cloudflareaccess.com`，不要末尾斜杠。 |
| `POLICY_AUD` | Access 应用的 AUD tag。 |

`wrangler secret put` 会立刻发布一个新版本。建议在第 9 步创建好 Access 应用后再写入 `TEAM_DOMAIN` 和 `POLICY_AUD`。

### 9. 给站点和接口套上 Cloudflare Access

静态页面不会进 Worker（只有 `/api/*` 会）。所以必须在主机名前面启用 Access，不能只靠接口里的 JWT 校验。接口会再验一次 `Cf-Access-Jwt-Assertion`，并可选地对照 D1 里的管理员邮箱。这是为了避免只信可以被伪造的邮件头。

1. 先完成一次 `npx wrangler deploy`（此时接口会因缺少 Access 配置而返回 403，这是预期的）。
2. 打开 Cloudflare 控制台 → Workers & Pages → `skyeyes-monitor` → Settings → Domains & Routes。
3. 对 `workers.dev`（以及你绑定的自定义域名）启用 Cloudflare Access。
4. 在 Access 策略里只允许你的邮箱。
5. 打开该 Access 应用，复制 AUD tag。
6. 把团队域名写入 `TEAM_DOMAIN`，把 AUD 写入 `POLICY_AUD`（见上一节）。
7. 部署完成后登录后台 → 配置，把 `allowed_admin_emails` 设成同样的邮箱，逗号分隔。留空表示「任何已经通过 Access 的用户」。建议上线后填上，多一道名单。

本地 `wrangler dev` 使用配置里的 `access.dev`，身份是 `dev@example.com`，只在本机生效。本地 `.dev.vars` 里要把 `ENVIRONMENT` 设为 `development`，否则接口会按生产规则拒绝没有 JWT 的请求。

### 10. 配置 GitHub Actions

仓库 → Settings → Secrets and variables → Actions，新增：

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 能部署 Worker 并执行远端 D1 迁移的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |

Token 至少需要这些权限：

- Account / Workers Scripts / Edit
- Account / D1 / Edit
- Account / Queues / Edit
- Account / Workers R2 Storage / Edit
- Account / Workers Tail / Read
- User / User Details / Read
- User / Memberships / Read

如果部署日志指出还缺某项权限，按日志补上，不要把 Token 写进仓库。Worker 运行时密钥（twitterapi.io、Resend、Access）不要放进 GitHub Secrets，它们只存在于 Worker 的 Wrangler secrets。

推到 `main` 时，CI 会执行：

```bash
npx wrangler d1 migrations apply skyeyes-monitor --remote
npx wrangler deploy
```

PR 上只跑 `npm run typecheck`、`npm test`、`npm run build`，不会部署。

### 11. 第一次登录后改成真实数据

1. 用 Access 允许的邮箱打开站点。
2. 在「监测目标」删除「示例国家甲 / 示例国家乙」和占位关键词。删除分组会一并删除它的目标，已经采集的历史记录会保留分组名称。
3. 添加真实分组，再添加人物、机构、关键词或 X 账号。一个目标有一个**显示名**和多条**检索词**（后台里一行一条）。账号类型的检索词不要带 `@`。
4. 或用 CSV / Excel 管理整份名单。在「监测目标」点「导出 CSV」或「导出 Excel」。CSV 是 UTF-8 带 BOM，Excel 能正确打开中文。导出默认包含全部分组；只有勾选「只导出当前分组」时，才只导出上面分组选择器里的那一组。导出文件和导入模板是同一套列。Excel 有两张表：「目标」冻结了表头、打开了自动筛选，并设了列宽；「填写说明」写明每一列和允许的值。

   改完后在「导入 CSV / Excel」里选这个文件。预览会把每一行标成新建、更新或无变化，并标出未知分组代码、类型不对、检索词为空、未知目标 ID，以及会合并的重复行。有错误时不能确认。从文件里删掉一行**不会**删除数据库里的目标，只有页面上的「删除」会删。这一步没有新的数据库迁移，目标 ID 就是表里原有的 `targets.id`。数据库里的表和接口路径仍叫 countries，不需要迁移数据。

   模板列、导出列和接口接受的列一致，中文表头和英文表头都可以：

   | 中文表头 | 英文表头 | 说明 |
   | --- | --- | --- |
   | 目标ID | `id` | 导出时带上。再导入时按这个 ID 覆盖原目标，检索词和排除词以文件为准，不会另建一条。留空则新建。文件里不出现的 ID 会保留 |
   | 分组代码 | `country_code` 或 `group_code` | 必须已经存在。任意短且唯一，例如 `demo`，不必是 ISO 国家代码。旧表头「国家代码」「国家」「country」仍可导入 |
   | 类型 | `kind` | `person`、`organization`、`keyword`、`handle`，也可写人物、机构、关键词、X 账号 |
   | 显示名 | `name` | 日报里的名称 |
   | 检索词 | `terms` 或 `query` | 必填。多条用 `\|` 或单元格内换行分开 |
   | 排除词 | `exclude` 或 `exclude_terms` | 可空，分隔方式和检索词相同 |
   | 背景说明 | `description` | 可空，最多 800 字 |
   | 启用 | `enabled` | `1` / 是 为启用，`0` / 否 为停用，留空视为启用 |
   | 英文短语区分大小写 | `case_sensitive` | 可空。`1` 或 是 时更长的英文短语也区分大小写 |

   模板里有两行示例（目标 ID 留空，分组代码是 `demo`）：机构「俾路支解放军」，检索词是 `Baloch Liberation Army|Balochistan Liberation Army|BLA`；以及一个 X 账号。没有目标 ID 时，同一分组、类型、显示名的多行会合并成一个目标（检索词和排除词取并集）。带目标 ID 的行按 ID 整行覆盖，文件里删掉的检索词也会从该目标去掉。不要把这份真实文件提交到 Git。

   短缩写不要拆成很多目标。例如把下面这些词放在**同一个**显示名下，每条单独占自己的翻页，命中都记成这个显示名：

   ```text
   分组代码,kind,name,query,exclude,case_sensitive,enabled
   demo,organization,俾路支解放军,BLA|Balochistan Liberation Army|俾路支解放军,Biologics License|bla bla,1,1
   demo,organization,俾路支解放军,俾路支解放阵地,,1,1
   demo,organization,俾路支解放阵地,BLF|Balochistan Liberation Front,,1,1
   ```

   导入后第一个目标有四条检索词：`BLA`、`Balochistan Liberation Army`、`俾路支解放军`、`俾路支解放阵地`，排除 `Biologics License` 和 `bla bla`。第二个目标是阵地的缩写和英文全称。

   怎么填才不会把无关内容算进来：

   - 2 到 5 个英文字母的缩写**始终**按大小写和整词匹配。请写成要命中的样子，例如 `BLA`，不要写成 `bla`。`BLA` 不会命中 `bla bla` 或 `blank`。
   - 更长的英文短语默认不区分大小写，但必须是整词。`Baloch` 不会命中 `Balochistan`。需要区分大小写时打开目标上的「英文短语区分大小写」，或在 CSV 里把 `case_sensitive` 设为 `1`。
   - 含汉字、假名或谚文的检索词按子串匹配。较短的中文词会命中包含它的更长句子。
   - 排除词用同一套规则，命中就丢掉整条。FDA 的 `Biologics License`、口头禅 `bla bla` 都适合放在排除词里。
   - 正文里没有任何一条检索词的结果不会入库（X 账号类除外：作者就是这个账号时保留）。丢掉的条数记在运行日志的 `filtered` 里。
   - 命中检索词来自返回这条结果的那次查询，不是事后按目标顺序做子串扫描。数据页和 Excel 的「命中检索词」列可以看到是哪一条。
5. 在「配置」里添加真实收件人并启用，填发件人，打开需要的数据源和「发送每日邮件」。
6. 在「数据」页点「手动运行」。手动运行的窗口是「现在往前 N 小时」，N 是配置里的窗口长度。定时运行则结束于最近一个计划时刻。
7. 状态页应出现这次运行、按分组的今日/昨日/累计数量，以及各数据源是否已配置。失败批次和近 7 日调用次数也在这一页。
8. 运行收尾后，R2 里的 `skyeyes.xlsx` 会被整份重写。分组表保留已通过时间校验的历史；「今日」「昨日」只按**发布时间**落入计划窗口（默认昨天 10:00 到今天 10:00）的条目。邮件正文只统计这些条目的条数，不写原文、摘要或译文。缺发布时间、窗口外、旧文重发、规则过滤和低相关度的内容不会进入这些计数，也不会出现在 Excel 里。

## 改运行时间、窗口和批次

打开「配置」。这些值存在 D1，保存后下一次 Cron 就生效，不用重新部署：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `schedule_hour` | 10 | 配置时区的整点，0–23。Cron 固定为每小时整点，所以只能精确到小时。 |
| `window_hours` | 24 | 定时运行的窗口长度。10:00 触发时，窗口是昨天 10:00 到今天 10:00。 |
| `batch_size` | 12 | 保留的配置。一次运行按来源各发一条采集链，不再用这个数字拆队列消息。 |
| `timezone` | Asia/Shanghai | 计划窗口、管理端、Excel、邮件里给人看的时间都读这一项。数据库仍存 UTC。改成另一个时区会立刻按新时区重写累计 Excel。表头写成「发布时间（Asia/Shanghai, UTC+8）」这种形式，时区名和偏移都来自当前配置，不写死某一个城市。 |
| `finalize_deadline_minutes` | 60 | 开始后超过这么久仍未收尾，下一次整点 Cron 会把已经入库的内容发出去，并把运行标为未完成。批次如果提前全部结束，会立刻收尾，不必等到截止。 |
| `x_qps` | 0.2 | twitterapi.io 每秒请求数。未付费账号保持 0.2；充值后可改为 10，上限 20。改完立即生效。每一次 X 请求（含翻页）都受它限制。 |
| `gdelt_min_interval_sec` | 6 | GDELT 两次请求之间的最短间隔，1–300 秒。默认大约每 6 秒 1 次。 |
| `google_news_min_interval_sec` | 1 | Google News 两次请求之间的最短间隔，0–60 秒。0 表示不再额外限速。 |
| `subrequest_budget` | 40 | 一次队列调用里，来源抓取和翻译/评分一共最多用多少次子请求。范围 6–45。免费版外部 `fetch` 上限是 50，重定向的每一跳也算，所以默认留出余量。到预算就写入进度并用延迟消息继续，不占用队列的 5 次重试。 |
| `x_max_pages` | 5 | 每条检索词在 X 上最多翻多少页。同一目标的每条词各自拥有这个额度。推迟后续跑时从上次的页码和 cursor 继续。 |
| `google_news_editions` | en-US,zh-CN | Google News 版本，逗号或换行分隔。每个版本单独查询。`ar` 表示沙特阿拉伯语版。 |
| `translation_fallback_model` | @cf/zai-org/glm-4.7-flash | Workers AI 对话模型。只有 DeepSeek 和 m2m100 都没有译成中文时才调用。可在配置页修改。`@cf/google/gemma-3-12b-it` 已于 2026-05-30 停用，保存时会拒绝。没有新迁移，没保存过这项的库用这个默认值。 |

改小时后，下一次到达该小时的整点 Cron 才会自动跑。赶不上就用「数据」页的手动运行。手动运行的采集窗口是「现在往前 N 小时」，但 Excel 的「今日」「昨日」始终按上面的计划窗口和发布时间计算。

## 时间和噪音过滤

日报只收录**发布时间落在当次运行窗口内**的内容。默认时区是 `Asia/Shanghai`、默认时刻是 10:00 时，窗口就是昨天 10:00 到今天 10:00。窗口和页面上的时间都读配置里的时区。这条规则在入库前统一执行，X、Google News、GDELT 都走同一套判断，不靠各个数据源自己过滤。

- 没有发布时间，或时间无法解析：记入数据库并标成「时间不明」，不进入 Excel、今日/昨日视图和邮件。
- 发布时间在窗口外：直接丢弃，不入库。
- 同一规范化链接，或标题规范化后几乎相同的旧文（忽略标点和空格，相似度很高），只要数据库里已经有过，就不再当作新内容。标题候选不再用 `LIKE` 前缀：D1 的 `LIKE` 模式最长 50 字节，24 个中文或印地语字符大约 72 字节，会报 `LIKE or GLOB pattern too complex` 并把这条丢掉。现在把规范化标题的前 12 个字符存在 `title_prefix` 上，用等值比对。这个前缀最多 48 字节。比对查询如果失败，会记一条警告，再只按链接查一次；链接查询也失败时仍然入库，不会因为去重查询失败而丢掉内容。迁移是 `0013_title_prefix.sql`，会给已有行回填前缀并建索引。
- 入库前的规则过滤可在「配置」里改：最短正文、排除词、屏蔽账号或域名、排除转推、排除广告。X 若返回了粉丝数或注册时间，还可以设最少粉丝数和最少账号天数；没有这些字段时不因此排除。
- 过了检索词、整词、排除词和屏蔽作者这些规则、并且发布时间在窗口内的记录，才会做 AI 解读。配置里的解读服务默认是 DeepSeek：一条记录调用一次 `https://api.deepseek.com/chat/completions`，模型默认 `deepseek-chat`，要求 JSON。返回相关与否、0–100 分、中文原因、源语言、全文简体中文、一句摘要、事件类型（statement / attack / meeting / other）以及提到的人和地点。目标上的「背景说明」会一起传给模型。相关度为假或低于阈值的记录留在数据库，不进 Excel 和邮件。DeepSeek 按 token 计费，每条过了规则的窗口内记录一次调用；正文截到 2500 字。同一批次里逐条调用，遇到 429 或 5xx 会按 Retry-After 或退避重试，最多 3 次。DeepSeek 解读成功且返回合格简体中文时，这条中文直接作为记录译文，不再调用 Workers AI。没有 `DEEPSEEK_API_KEY`、调用失败、或译文不合格时，才用 Workers AI：先按文字和 X 的 `lang` 识别阿拉伯文、乌尔都语、波斯语等，交给 `@cf/meta/m2m100-1.2b`；机器译文为空或不是中文时，再用 `translation_fallback_model`。默认是 `@cf/zai-org/glm-4.7-flash`。Cloudflare 在 2026-05-08 的停用说明里把 `@cf/google/gemma-3-12b-it` 列为 2026-05-30 停用，并把它列为速度快的多语言替代；模型页标明由 Cloudflare 托管，支持 100 多种语言的对话，没有标成停用。模型不可用（例如错误 5018、model deprecated）时，中文列写成「翻译失败：模型不可用：…」，并带上模型名。保存时检查模型名；改成另一个模型会试跑一次，停用或 5018 会拒绝保存。三步都没有合格中文就标成「翻译失败」并写上原因，中文列不会留空。评分失败时记录保留，相关度列显示原因，不再是「—」。把解读服务改成 Workers AI 时，评分仍用原来的 `@cf/meta/llama-3.2-3b-instruct`。数据页可以「为所选解读」，或「解读未完成记录」（还没有分数，或译文为空、翻译失败），每次 8 条。
- 相关度用 `@cf/meta/llama-3.2-3b-instruct` 打 0–100 分，只对发布时间落在窗口内、且打开了「相关度评分」的新记录调用。低于「相关度阈值」的条目留在数据库供核对，不进入 Excel 和邮件。阈值设为 0 表示不因分数排除。模型如果多写了几个字，只要回复里有一个 0–100 的整数，就取最后一个。完全解析不了或调用失败时，分数留空，相关度列显示原因，这次运行的「评分失败」加一，条目本身仍保留。打开开关不会回溯旧记录。数据页可以「为所选评分」，或「为未评分记录打分」（还没有分数、也没有失败原因的记录，每次 20 条）。
- 数据页可以把一条标为垃圾，或屏蔽作者。屏蔽会把账号（没有账号时用站点域名）写入屏蔽名单，之后的运行会在入库前丢掉该作者。
- 数据页按页显示。`GET /api/records` 接受 `page`（从 1 开始）和 `pageSize`（20、50 或 100），并返回 `records`、`total`、`page`、`pageSize`。没有 `page` / `pageSize` 时仍接受原来的 `limit`（1–100，默认 40）和 `offset`。页面上可以选择每页条数、看到总条数，并跳到指定页。筛选有：分组、目标、来源（X / Google News / GDELT）、发布日期（按配置时区的日历日，含首尾两天）、相关度（已评分、未评分、不低于或低于阈值）、翻译状态（已翻译、翻译失败、空白）、垃圾（只看或隐藏），以及在原文或中文译文里搜索关键词。排序可以按发布时间或相关度，升序或降序。表头复选框只选中当前这一页，批量删除这一页仍然一次最多 100 条。另有「删除全部符合筛选的记录」：确认框写明将删除的总条数，`POST /api/records/delete-matching` 必须带 `confirm: true`，并用同一套筛选条件软删除，不限于这一页。
- 数据页可以删除一条，或勾选当前这一页后批量删除（一次最多 100 条）。删除前会要求确认。删除不是把行从数据库抹掉：`deleted_at` 记下删除时间，`dedupe_key`、规范化链接和标题都留着。因此同一条帖子或新闻不会因为删过一次就在下次运行里变成新内容；标题几乎相同的旧文也不会再入库。这个限制不限于当天窗口。页面上没有撤销。删完会立刻重写 R2 里的 Excel，下载文件里不再有这些行。

Excel 的「发布时间」和「采集时间」是真正的日期单元格，格式 `yyyy-mm-dd hh:mm`，数值是配置时区的墙钟，所以排序和筛选按显示出来的时间走。表头带上当前时区和偏移，例如 `发布时间（Asia/Shanghai, UTC+8）`。D1 里仍是 UTC。目标导入导出的 CSV 和 Excel 没有时钟列。分组表是通过上述校验的历史；今日/昨日两张表只看发布时间是否落在对应的计划窗口里，不看采集时间。因此一篇昨天的旧闻即使今天才被抓到，也不会出现在今日表或当天邮件里。保存配置时如果时区变了，会马上重写这份累计 Excel，旧行也换成新时区。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply skyeyes-monitor --local
npm run dev
```

`npm run dev` 会先构建管理后台到 `admin/dist`，再启动 Wrangler。这个目录被 git 忽略，全新克隆里本来没有它；Wrangler 要求 `assets.directory` 指向的目录已经存在，所以不能跳过这一步直接执行 `wrangler dev`。构建完成后，后台和接口都在 `http://127.0.0.1:8787`。

如果本地库是更早版本建的，把上面的迁移命令再执行一次。`0004_x_rate.sql` 加上 X 的共享时间槽；`0005_target_terms.sql` 给目标加上多条检索词、排除词和大小写开关；`0006_record_deletion.sql` 给采集记录加上 `deleted_at`，用来隐藏已删除的行并保留去重身份。`0007_relevance_errors.sql` 给记录加上评分失败原因，并给运行加上评分失败次数。`0008_translation_status.sql` 给记录加上翻译状态、失败原因和识别出的源语言。`0009_ai_interpretation.sql` 给目标加上背景说明，给记录加上摘要、原因、事件类型和提及的人或地点，并写入 DeepSeek 的默认配置。`0010_google_news_editions.sql` 给记录加上 Google News 版本，并写入默认的 `en-US,zh-CN`。`0011_batch_enqueue.sql` 给批次加上 `enqueued_at`，用来区分「已入队」和「只写进数据库、队列里没有消息」。没有这列时，大批次的手动运行会在 `sendBatch` 处失败并把全部批次留在 `queued`。`0012_record_list_indexes.sql` 给采集记录加上按未删除行筛选和排序用的索引（发布时间、分组、来源、目标、相关度、翻译状态、垃圾标记）。`0013_title_prefix.sql` 给采集记录加上 `title_prefix`，用标题前 12 个字符做等值去重，并回填已有行。没有这列时，中文或印地语标题的前缀会超过 D1 的 50 字节上限，记录会被跳过。`0014_batch_lease.sql` 给批次加上租约、领取令牌，以及抓取、去重、过滤、新增的计数。没有这些列时，领取批次和状态页的批次明细会失败。`0015_batch_defer.sql` 给批次加上推迟次数、累计等待、下次唤醒时间和断点续跑的进度。没有这些列时，让槽、429 和翻页续跑会失败。`0016_finalize_once.sql` 给运行加上 `finalize_enqueued_at`，保证三条来源链结束时只入队一条收尾消息。没有这列时，收尾入队会失败。线上推到 `main` 时 CI 会对远程库执行同一条迁移。已有的单检索词目标不用手工改库，但建议按上一节把缩写、全称和中文名收成同一个目标，并补上排除词。

改界面时可以另开一个终端，用 Vite 热更新，不必每次改完都重新构建：

```bash
npm run dev:admin
```

这个地址是 `http://127.0.0.1:5173`，并把 `/api` 代理到本机的 Wrangler。`.dev.vars` 已被 git 忽略。

Workers AI 没有本地模拟器。配置里保留了 `ai` 绑定之后，`wrangler dev` 会要求先执行 `npx wrangler login`，否则启动会停在 OAuth，接口也不会响应。登录只影响本机调用真实翻译模型。发信绑定在本地是模拟的，不会真的把邮件发出去。

## 测试

```bash
npm test
npm run typecheck
npm run build
```

测试覆盖：上海时区及非东八区的窗口计算、10:00 边界两侧的显示换算（含另一个时区）、Excel 日期单元格和动态表头、邮件按配置时区取日历日、修改时区后重写 Excel、每个来源一条采集链、每条检索词各自翻页、缩写整词匹配和排除词、多检索词导入、分组代码模板以及旧表头「国家代码」「国家」「country」仍可导入、按帖子 id / 链接去重、中文印地语阿拉伯语表情和长标题的标题前缀、去重查询失败时仍入库、Google News 同一文章不同参数合并、按版本分别查询再按标题合并、多表 Excel 以及重新生成时保留历史行、X 的 QPS 间隔、`Retry-After` 和批次内重试、GDELT 的 OR 打包和 30/60/120 秒退避、0.2 QPS 下两条检索词各 5 页在一次调用里按间隔睡完并逐页入库、连续 429 不耗尽队列重试、采集记录的分页与筛选、按筛选软删除、0 / 100 / 101 / 182 / 1000 个批次的队列拆分、取消已入队批次、丢失消息和过期租约的恢复、未到唤醒时间不会被提前重发、重复投递不会再次领取、每日邮件关闭时仍能发测试信、指定一个地址或全部启用收件人、附上不超过 4MB 的 Excel 或改为下载链接、生成失败时仍发出、把服务商的错误原文返回给页面，以及日报和测试邮件正文只保留窗口、分组计数和附件说明、不列条目、翻译顺序为 DeepSeek 中文、m2m100、配置的备用对话模型、再标成翻译失败、保存时拒绝已停用的 Gemma 和返回 5018 的模型。

## 添加一个新数据源

Reddit、Telegram 或其他来源不要写死在调度里。新增时改这些地方：

1. 在 `src/domain/types.ts` 的 `SOURCE_IDS` 里加上新 id。
2. 新建 `src/sources/<name>.ts`，实现 `SourceProvider`：`search({ targets, window, fetchImpl, apiKey })` 返回统一的 `CollectedRecord`（原文、链接、作者、发布时间、命中的目标和检索词）。用 `searchPlan` 按目标的每条检索词各查一次，用 `verifyHit` 确认正文真的命中，再用 `makeDedupeKey`。不要在数据源里自行决定能不能进日报；窗口、缺时间、旧文重发和规则过滤都在 `src/domain/gate.ts`，采集结果返回后统一执行。能解析出的发布时间放进 `publishedAt`，解析不了就留 `null`。对不上任何检索词的条目不要返回。
3. 在 `src/sources/registry.ts` 注册。
4. 在 `src/config/settings.ts` 增加一个 `*_enabled` 开关，并在 `migrations/` 里加一条默认设置。不要把密钥写进迁移。
5. 在 `src/http/app.ts` 的状态接口里加上该来源的 `configured` 判断（只返回布尔值）。
6. 在 `admin/src/pages/SettingsPage.tsx` 加一个开关。
7. 如果这个来源需要密钥，把名字加进 `wrangler.jsonc` 的 `secrets.required`，用 `wrangler secret put` 注入，并在 README 的密钥表里补一行。

队列、去重、翻译、Excel 和邮件会自动带上新来源，不需要再写一套调度。限流请抛出 `RateLimitError`。消费者会确认这条消息，并按 `delaySeconds` 另发一条新唤醒，不调用 `message.retry()`。缺密钥、解析失败和其他 4xx/5xx 才重试，耗尽后进入死信队列，这时才把批次标为失败。仅仅推迟中的批次（`next_wake_at` 已写上）即使旧消息进了死信，也不会被标失败。

## 隐私

- 不要提交真实分组、人物、机构、关键词、账号或收件人。
- 不要提交 `.dev.vars`、API key、Access AUD 或邮件密钥。
- 后台和接口响应里没有密钥字段。状态页只有「已配置」和开关。
