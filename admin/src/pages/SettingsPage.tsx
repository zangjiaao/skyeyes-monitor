import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Table } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { api } from "../api";

interface Recipient extends Record<string, unknown> {
  id: string;
  email: string;
  enabled: number;
}

const FIELDS = [
  ["schedule_hour", "每天运行小时（配置时区的整点）"],
  ["window_hours", "采集窗口小时数"],
  ["batch_size", "保留项。每个目标已经单独查询，不再把多个目标合成一条搜索"],
  ["timezone", "时区"],
  ["email_from", "发件人邮箱"],
  ["email_from_name", "发件人名称"],
  ["app_base_url", "站点地址（邮件里的下载链接）"],
  ["allowed_admin_emails", "管理员邮箱，逗号分隔；留空则接受任何通过 Access 的用户"],
  ["ai_model", "DeepSeek 模型名"],
  ["translation_source_lang", "拉丁文字未标明语种时的源语言代码"],
  ["translation_target_lang", "翻译目标语言代码"],
  ["finalize_deadline_minutes", "收尾截止分钟"],
  ["x_max_pages", "X 每条检索词最多翻页。同一目标的每条词各自占用这些页"],
  ["x_qps", "X 每秒请求数。未付费账号保持 0.2（每 5 秒 1 次）；充值后可提高到 10，上限 20"],
  ["queue_concurrency", "同时采集的批次数，1 到 8。X、GDELT、Google News 各有自己的时间槽，可以并行"],
  ["gdelt_min_interval_sec", "GDELT 最小间隔秒数，默认 6。文档接口大约每 5 秒 1 次，多个批次共用这个时间槽"],
  ["google_news_min_interval_sec", "Google News 最小间隔秒数，默认 1。0 表示不额外限速"],
  ["excel_key", "R2 中的 Excel 文件名"],
  ["min_text_length", "最短正文长度，0 表示不限制"],
  ["min_followers", "X 最少粉丝数，0 表示不限制；没有粉丝数时不因此排除"],
  ["min_account_age_days", "X 最少账号天数，0 表示不限制；没有注册时间时不因此排除"],
  ["relevance_threshold", "相关度阈值 0–100，低于此分数不进 Excel/邮件，0 表示不因分数排除"],
  ["exclude_words", "排除词，逗号或换行分隔"],
  ["blocked_accounts", "屏蔽账号或站点域名，逗号分隔"],
] as const;

export function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");

  function load() {
    return Promise.all([
      api<{ settings: Record<string, string> }>("/api/settings"),
      api<{ recipients: Recipient[] }>("/api/recipients"),
    ]).then(([settings, people]) => {
      setValues(settings.settings);
      setRecipients(people.recipients);
    });
  }

  useEffect(() => {
    load().catch((reason: Error) => setError(reason.message));
  }, []);

  function flag(key: string): boolean {
    return values[key] === "1" || values[key] === "true";
  }

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>配置</Heading>
        <Text type="body" color="secondary">
          修改后立即生效，不需要重新部署。Cron 每小时触发一次，只有到达设定小时才会开跑。密钥不会在这里显示。
        </Text>
      </VStack>
      {error ? <Banner status="error" title="保存失败" description={error} /> : null}
      {testError ? <Banner status="error" title="测试邮件失败" description={testError} isDismissable onDismiss={() => setTestError("")} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      <HStack gap={3}>
        <CheckboxInput label="启用 X" value={flag("x_enabled")} onChange={(checked) => setValues({ ...values, x_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="启用 Google News" value={flag("google_news_enabled")} onChange={(checked) => setValues({ ...values, google_news_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="启用 GDELT" value={flag("gdelt_enabled")} onChange={(checked) => setValues({ ...values, gdelt_enabled: checked ? "1" : "0" })} />
      </HStack>
      <TextInput
        label="Google News 版本"
        value={values.google_news_editions ?? ""}
        onChange={(value) => setValues({ ...values, google_news_editions: value })}
        description="逗号或换行分隔。默认 en-US,zh-CN。可加 en-PK、ar、ar-EG。每个版本单独查询，不写参数并不是全部语言。"
      />
      <HStack gap={3}>
        <CheckboxInput label="翻译成中文" value={flag("translation_enabled")} onChange={(checked) => setValues({ ...values, translation_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="相关度评分" value={flag("relevance_enabled")} onChange={(checked) => setValues({ ...values, relevance_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="启用 AI 解读" value={flag("ai_enabled")} onChange={(checked) => setValues({ ...values, ai_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="发送每日邮件" value={flag("email_enabled")} onChange={(checked) => setValues({ ...values, email_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="排除转推" value={flag("exclude_retweets")} onChange={(checked) => setValues({ ...values, exclude_retweets: checked ? "1" : "0" })} />
        <CheckboxInput label="排除广告" value={flag("exclude_ads")} onChange={(checked) => setValues({ ...values, exclude_ads: checked ? "1" : "0" })} />
      </HStack>
      <Selector
        label="解读服务"
        value={values.ai_provider || "deepseek"}
        onChange={(value) => setValues({ ...values, ai_provider: value })}
        options={[
          { value: "deepseek", label: "DeepSeek" },
          { value: "workers", label: "Workers AI" },
        ]}
      />
      <Selector
        label="邮件服务"
        value={values.email_provider || "resend"}
        onChange={(value) => setValues({ ...values, email_provider: value })}
        options={[
          { value: "resend", label: "Resend" },
          { value: "cloudflare", label: "Cloudflare Email Service" },
        ]}
      />
      {FIELDS.map(([key, label]) => (
        <TextInput
          key={key}
          label={label}
          value={values[key] ?? ""}
          onChange={(value) => setValues({ ...values, [key]: value })}
        />
      ))}
      <Button
        label="保存配置"
        variant="primary"
        onClick={() => {
          setError("");
          api<{ excel?: boolean; excelError?: string | null }>("/api/settings", { method: "PUT", body: JSON.stringify(values) })
            .then((result) => {
              if (result.excelError) {
                setError(`已保存，但 Excel 未重写：${result.excelError}`);
                return;
              }
              setNotice(result.excel ? "已保存，并按新时区重新生成 Excel" : "已保存");
            })
            .catch((reason: Error) => setError(reason.message));
        }}
      />
      <Heading level={2}>收件人</Heading>
      <Text type="supporting" color="secondary">所有分组合成一封邮件，发给下面启用的地址。测试邮件使用已保存的发件人和邮件服务，每日邮件可以保持关闭。</Text>
      <Button label="发送测试邮件" variant="secondary" onClick={() => { setTestError(""); setTestTo(""); setTestOpen(true); }} />
      <HStack gap={2}>
        <TextInput label="邮箱" type="email" value={email} onChange={setEmail} />
        <Button
          label="添加"
          variant="secondary"
          onClick={() => {
            api("/api/recipients", { method: "POST", body: JSON.stringify({ email }) })
              .then(async () => {
                setEmail("");
                await load();
              })
              .catch((reason: Error) => setError(reason.message));
          }}
        />
      </HStack>
      <Table
        density="compact"
        idKey="id"
        data={recipients}
        columns={[
          { key: "email", header: "邮箱" },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
          {
            key: "actions",
            header: "操作",
            renderCell: (row) => (
              <HStack gap={1}>
                <Button
                  label={row.enabled ? "停用" : "启用"}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    api(`/api/recipients/${row.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ enabled: !row.enabled }),
                    }).then(load).catch((reason: Error) => setError(reason.message));
                  }}
                />
                <Button
                  label="删除"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    api(`/api/recipients/${row.id}`, { method: "DELETE" })
                      .then(load)
                      .catch((reason: Error) => setError(reason.message));
                  }}
                />
              </HStack>
            ),
          },
        ]}
      />
      <Dialog
        isOpen={testOpen}
        purpose="form"
        width={440}
        onOpenChange={(open) => {
          if (!open && !testing) setTestOpen(false);
        }}
      >
        <VStack gap={3}>
          <DialogHeader
            title="发送测试邮件"
            onOpenChange={(open) => {
              if (!open && !testing) setTestOpen(false);
            }}
          />
          <Text type="body">
            使用已保存的发件人、邮件服务和站点地址。每日邮件开关不影响这封信。收件人留空则发给全部已启用的地址；也可以只填一个地址。
          </Text>
          {testError ? <Banner status="error" title="测试邮件失败" description={testError} /> : null}
          <TextInput
            label="单个收件人（可选）"
            type="email"
            value={testTo}
            onChange={setTestTo}
          />
          <HStack gap={2}>
            <Button
              label="发送"
              variant="primary"
              isLoading={testing}
              onClick={() => {
                setTesting(true);
                setTestError("");
                const body = testTo.trim() ? { to: testTo.trim() } : {};
                api<{ to: string[]; attached: boolean; excelError: string | null }>("/api/email/test", {
                  method: "POST",
                  body: JSON.stringify(body),
                }).then((result) => {
                  const who = result.to.join("、");
                  const attachment = result.attached
                    ? "已附上累计 Excel。"
                    : result.excelError
                      ? `没有附上 Excel：${result.excelError}`
                      : "Excel 超过 4MB 或尚未生成，正文里会说明。";
                  setNotice(`测试邮件已发给 ${who}。${attachment}`);
                  setTestOpen(false);
                  setTestTo("");
                }).catch((reason: Error) => {
                  setTestError(reason.message);
                }).finally(() => setTesting(false));
              }}
            />
            <Button
              label="取消"
              variant="secondary"
              isDisabled={testing}
              onClick={() => setTestOpen(false)}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
