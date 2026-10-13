import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Table } from "@astryxdesign/core/Table";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Banner } from "@astryxdesign/core/Banner";
import { api, formatTime } from "../api";

interface CountryCount extends Record<string, unknown> {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
  total: number;
  today: number;
  yesterday: number;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  records_added: number;
  batches_failed: number;
  relevance_failed: number;
  email_status: string | null;
}

interface SourceState extends Record<string, unknown> {
  label: string;
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  lastError: string | null;
}

interface StatusPayload {
  nextRun: string;
  scheduleHour: number;
  windowHours: number;
  batchSize: number;
  timezone: string;
  countries: CountryCount[];
  runs: RunRow[];
  failedBatches: Array<Record<string, unknown> & { id: string; country_name: string; source: string; error: string | null }>;
  apiUsage: Array<Record<string, unknown> & { source: string; calls: number; items: number }>;
  sources: Record<string, SourceState>;
  rateLimit: {
    xQps: number;
    hits24h: number;
    hits7d: number;
    lastHitAt: string | null;
    lastRetryAfterSeconds: number | null;
    recent: Array<Record<string, unknown> & {
      id: string;
      source: string;
      status: number;
      retryAfterSeconds: number | null;
      delaySeconds: number;
      recordedAt: string;
    }>;
  };
  delivery: {
    emailEnabled: boolean;
    provider: string;
    resendConfigured: boolean;
    fromConfigured: boolean;
    translationEnabled: boolean;
    accessConfigured: boolean;
    deepseekConfigured?: boolean;
    aiProvider?: string;
  };
}

function flag(ok: boolean, yes: string, no: string) {
  return <Badge label={ok ? yes : no} variant={ok ? "success" : "warning"} />;
}

export function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<StatusPayload>("/api/status").then(setData).catch((reason: Error) => setError(reason.message));
  }, []);

  if (error) return <Banner status="error" title="无法读取状态" description={error} />;
  if (!data) return <Text type="body">正在读取状态…</Text>;

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>系统状态</Heading>
        <Text type="body" color="secondary">
          {`每天 ${data.scheduleHour}:00（${data.timezone}）采集前 ${data.windowHours} 小时。下次运行 ${formatTime(data.nextRun)}。批次大小 ${data.batchSize}。`}
        </Text>
      </VStack>
      <HStack gap={2}>
        {flag(data.delivery.accessConfigured, "Access 已配置", "Access 未配置")}
        {flag(data.delivery.translationEnabled, "翻译开启", "翻译关闭")}
        {flag(Boolean(data.delivery.deepseekConfigured), "DeepSeek 已配置", "DeepSeek 未配置")}
        {flag(data.delivery.emailEnabled && data.delivery.fromConfigured, "邮件可发送", "邮件未就绪")}
      </HStack>
      <Heading level={2}>数据源</Heading>
      <Table
        density="compact"
        idKey="label"
        data={Object.values(data.sources)}
        columns={[
          { key: "label", header: "来源" },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
          { key: "configured", header: "密钥", renderCell: (row) => (row.configured ? "已配置" : "缺失") },
          { key: "healthy", header: "最近批次", renderCell: (row) => (row.healthy ? "正常" : "失败") },
          { key: "lastError", header: "最近错误", renderCell: (row) => row.lastError || "—" },
        ]}
      />
      <Heading level={2}>国家计数</Heading>
      <Table
        density="compact"
        idKey="id"
        data={data.countries}
        columns={[
          { key: "name", header: "国家" },
          { key: "today", header: "今日" },
          { key: "yesterday", header: "昨日" },
          { key: "total", header: "累计" },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
        ]}
      />
      <Heading level={2}>最近运行</Heading>
      <Table
        density="compact"
        idKey="id"
        data={data.runs}
        columns={[
          { key: "started_at", header: "开始", renderCell: (row) => formatTime(row.started_at) },
          { key: "trigger", header: "触发" },
          { key: "status", header: "状态" },
          { key: "records_added", header: "新增" },
          { key: "batches_failed", header: "失败批次" },
          { key: "relevance_failed", header: "评分失败", renderCell: (row) => row.relevance_failed ?? 0 },
          { key: "email_status", header: "邮件", renderCell: (row) => row.email_status || "—" },
        ]}
      />
      <Heading level={2}>失败批次</Heading>
      <Table
        density="compact"
        idKey="id"
        data={data.failedBatches}
        columns={[
          { key: "country_name", header: "国家" },
          { key: "source", header: "来源" },
          { key: "error", header: "错误", renderCell: (row) => row.error || "—" },
        ]}
      />
      <Heading level={2}>X 限流</Heading>
      <Text type="body" color="secondary">
        {`当前每秒 ${data.rateLimit.xQps} 次。近 24 小时 ${data.rateLimit.hits24h} 次，近 7 日 ${data.rateLimit.hits7d} 次。最近一次 ${formatTime(data.rateLimit.lastHitAt)}，Retry-After ${data.rateLimit.lastRetryAfterSeconds ?? "—"} 秒。`}
      </Text>
      <Table
        density="compact"
        idKey="id"
        data={data.rateLimit.recent}
        columns={[
          { key: "recordedAt", header: "时间", renderCell: (row) => formatTime(row.recordedAt) },
          { key: "source", header: "来源" },
          { key: "status", header: "状态码" },
          { key: "retryAfterSeconds", header: "Retry-After", renderCell: (row) => row.retryAfterSeconds ?? "—" },
          { key: "delaySeconds", header: "等待秒数" },
        ]}
      />
      <Heading level={2}>近 7 日接口用量</Heading>
      <Table
        density="compact"
        idKey="source"
        data={data.apiUsage}
        columns={[
          { key: "source", header: "来源" },
          { key: "calls", header: "调用次数" },
          { key: "items", header: "返回条数" },
        ]}
      />
    </VStack>
  );
}
