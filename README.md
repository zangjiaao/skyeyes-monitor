# SkyEyes Monitor

每天从 X 和网页新闻里收集监测对象的新内容，存进 D1，翻译成中文，覆盖更新同一份 Excel，并给一组收件人发一封汇总邮件。管理后台和接口在同一个 Cloudflare Worker 里。

默认时区是 `Asia/Shanghai`。Cron 每小时触发一次，Worker 再对照数据库里的时刻决定要不要开跑。默认是每天 10:00，采集窗口是前一天 10:00 到当天 10:00。

国家、监测对象、关键词和收件人只放在 D1。这个仓库是公开的，迁移里只有占位示例。API 密钥只通过 Wrangler secrets 和 GitHub Secrets 注入，后台只显示「已配置 / 缺失」和开关，不会回显密钥。

## 仓库里有什么

- `src/`：Hono API、定时任务、队列消费、数据源、翻译、Excel、邮件
- `admin/`：React 19 + Vite + Astryx（StyleX）管理后台，构建结果由同一个 Worker 当作静态资源提供
- `migrations/`：D1 表结构和占位种子
- `.github/workflows/ci.yml`：PR 上做类型检查、测试和构建；推到 `main` 后应用 D1 迁移并 `wrangler deploy`

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

迁移会建表，并写入两个占位国家、几条占位目标和一个停用的 `placeholder@example.com`。这些不是真实名单。

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

主队列按国家和数据源拆批，带延迟和重试。超过重试次数的消息进死信队列，对应批次标为失败。如果某次 `wrangler deploy` 提示队列已自动创建，以命令输出为准，名字必须仍是这两个。

### 6. 准备 X 和网页数据源

- 在 [twitterapi.io](https://twitterapi.io/) 申请 API key。采集用的是 `GET /twitter/tweet/advanced_search`，时间范围用 `since_time` / `until_time`（Unix 秒）。多个目标会合成一条 `from:账号 OR "机构名" OR "关键词"`，再按批次大小和查询长度拆开，减少调用次数。
- Google News RSS 和 GDELT 不需要密钥。新闻的日期过滤是按天的，X 的时间边界是精确到秒的。
- 后台可以分别开关 X、Google News、GDELT。没配 `TWITTERAPI_IO_KEY` 时，X 会显示为未配置，对应批次会失败并出现在状态页，不会把密钥打进日志以外的页面。

### 7. 准备发信

两套实现可以在后台切换，收件人列表相同，所有国家合成一封邮件。

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

邮件正文是当天汇总。Excel 小于 4MB 时作为附件；更大时只在正文里放下载链接，文件本身仍在 R2。下载链接要在配置里填写 `app_base_url`（站点的 https 根地址，不要以斜杠结尾）。

没准备好发信之前保持「发送每日邮件」关闭。种子数据里的占位收件人也是停用的。

### 8. 写入 Worker 密钥

这些值不要写进 `wrangler.jsonc`、代码或 GitHub 仓库。每条命令都会提示你粘贴，粘贴内容不会出现在命令参数里。

```bash
npx wrangler secret put TWITTERAPI_IO_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TEAM_DOMAIN
npx wrangler secret put POLICY_AUD
```

| 密钥 | 内容 |
| --- | --- |
| `TWITTERAPI_IO_KEY` | twitterapi.io 的 key。不用 X 时可以先不设。 |
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
2. 在「监测目标」删除「示例国家甲 / 示例国家乙」和占位关键词。删除国家会一并删除它的目标，已经采集的历史记录会保留国家名称。
3. 添加真实国家，再添加人物、机构、关键词或 X 账号。账号类型的检索词不要带 `@`。
4. 或用 CSV / Excel 批量导入。第一行表头必须是：

   ```text
   country_code,kind,name,query,enabled
   ```

   `kind` 只能是 `person`、`organization`、`keyword`、`handle`。`country_code` 必须已经存在。不要把这份真实文件提交到 Git。
5. 在「配置」里添加真实收件人并启用，填发件人，打开需要的数据源和「发送每日邮件」。
6. 在「数据」页点「手动运行」。手动运行的窗口是「现在往前 N 小时」，N 是配置里的窗口长度。定时运行则结束于最近一个计划时刻。
7. 状态页应出现这次运行、分国家的今日/昨日/累计数量，以及各数据源是否已配置。失败批次和近 7 日调用次数也在这一页。
8. 运行收尾后，R2 里的 `skyeyes.xlsx` 会被整份重写：每个国家一个全量历史表，另有「今日」「昨日」两张视图。历史行会留下来，因为表格是从 D1 全量生成的，不是只写当天。

## 改运行时间、窗口和批次

打开「配置」。这些值存在 D1，保存后下一次 Cron 就生效，不用重新部署：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `schedule_hour` | 10 | 上海时间的小时，0–23。Cron 固定为每小时整点，所以只能精确到小时。 |
| `window_hours` | 24 | 定时运行的窗口长度。10:00 触发时，窗口是昨天 10:00 到今天 10:00。 |
| `batch_size` | 12 | 每条搜索最多放多少个目标。查询太长时还会再拆开。 |
| `timezone` | Asia/Shanghai | 计划时刻、今日/昨日和邮件时间都用此时区。 |
| `finalize_deadline_minutes` | 60 | 开始后超过这么久仍未收尾，下一次整点 Cron 会把已经入库的内容发出去，并把运行标为未完成。批次如果提前全部结束，会立刻收尾，不必等到截止。 |

改小时后，下一次到达该小时的整点 Cron 才会自动跑。赶不上就用「数据」页的手动运行。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply skyeyes-monitor --local
npm run dev
```

另一个终端：

```bash
npm run dev:admin
```

后台开发服务器在 `http://127.0.0.1:5173`，并把 `/api` 代理到 `wrangler dev`（默认 `http://127.0.0.1:8787`）。`.dev.vars` 已被 git 忽略。

Workers AI 没有本地模拟器。配置里保留了 `ai` 绑定之后，`wrangler dev` 会要求先执行 `npx wrangler login`，否则启动会停在 OAuth，接口也不会响应。登录只影响本机调用真实翻译模型。发信绑定在本地是模拟的，不会真的把邮件发出去。

## 测试

```bash
npm test
npm run typecheck
npm run build
```

测试覆盖：上海时区及非东八区的窗口计算、OR 查询分批、按帖子 id / 链接去重、多表 Excel 以及重新生成时保留历史行。

## 添加一个新数据源

Reddit、Telegram 或其他来源不要写死在调度里。新增时改这些地方：

1. 在 `src/domain/types.ts` 的 `SOURCE_IDS` 里加上新 id。
2. 新建 `src/sources/<name>.ts`，实现 `SourceProvider`：`search({ targets, window, fetchImpl, apiKey })` 返回统一的 `CollectedRecord`（原文、链接、作者、发布时间、命中的目标）。用 `makeDedupeKey` 和 `matchTarget`。
3. 在 `src/sources/registry.ts` 注册。
4. 在 `src/config/settings.ts` 增加一个 `*_enabled` 开关，并在 `migrations/` 里加一条默认设置。不要把密钥写进迁移。
5. 在 `src/http/app.ts` 的状态接口里加上该来源的 `configured` 判断（只返回布尔值）。
6. 在 `admin/src/pages/SettingsPage.tsx` 加一个开关。
7. 如果这个来源需要密钥，把名字加进 `wrangler.jsonc` 的 `secrets.required`，用 `wrangler secret put` 注入，并在 README 的密钥表里补一行。

队列、去重、翻译、Excel 和邮件会自动带上新来源，不需要再写一套调度。限流请抛出 `RateLimitError`，队列会按约 45 秒重试，最多 5 次，然后进入死信队列。

## 隐私

- 不要提交真实国家、人物、机构、关键词、账号或收件人。
- 不要提交 `.dev.vars`、API key、Access AUD 或邮件密钥。
- 后台和接口响应里没有密钥字段。状态页只有「已配置」和开关。
