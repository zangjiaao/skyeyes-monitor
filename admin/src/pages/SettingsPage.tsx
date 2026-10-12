import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
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
  ["schedule_hour", "每天运行小时（上海时间，整点）"],
  ["window_hours", "采集窗口小时数"],
  ["batch_size", "每批目标数"],
  ["timezone", "时区"],
  ["email_from", "发件人邮箱"],
  ["email_from_name", "发件人名称"],
  ["app_base_url", "站点地址（邮件里的下载链接）"],
  ["allowed_admin_emails", "管理员邮箱，逗号分隔；留空则接受任何通过 Access 的用户"],
  ["translation_source_lang", "翻译源语言代码"],
  ["translation_target_lang", "翻译目标语言代码"],
  ["finalize_deadline_minutes", "收尾截止分钟"],
  ["x_max_pages", "X 每个查询最多翻页"],
  ["excel_key", "R2 中的 Excel 文件名"],
] as const;

export function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      <HStack gap={3}>
        <CheckboxInput label="启用 X" value={flag("x_enabled")} onChange={(checked) => setValues({ ...values, x_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="启用 Google News" value={flag("google_news_enabled")} onChange={(checked) => setValues({ ...values, google_news_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="启用 GDELT" value={flag("gdelt_enabled")} onChange={(checked) => setValues({ ...values, gdelt_enabled: checked ? "1" : "0" })} />
      </HStack>
      <HStack gap={3}>
        <CheckboxInput label="翻译成中文" value={flag("translation_enabled")} onChange={(checked) => setValues({ ...values, translation_enabled: checked ? "1" : "0" })} />
        <CheckboxInput label="发送每日邮件" value={flag("email_enabled")} onChange={(checked) => setValues({ ...values, email_enabled: checked ? "1" : "0" })} />
      </HStack>
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
          api("/api/settings", { method: "PUT", body: JSON.stringify(values) })
            .then(() => setNotice("已保存"))
            .catch((reason: Error) => setError(reason.message));
        }}
      />
      <Heading level={2}>收件人</Heading>
      <Text type="supporting" color="secondary">所有国家合成一封邮件，发给下面启用的地址。</Text>
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
    </VStack>
  );
}
