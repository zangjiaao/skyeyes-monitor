import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Table } from "@astryxdesign/core/Table";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Banner } from "@astryxdesign/core/Banner";
import { api, formatTime, timeHeader } from "../api";

const RUN_STATUS: Record<string, string> = {
  running: "进行中",
  partial: "部分失败",
  failed: "失败",
  cancelled: "已取消",
  completed: "完成",
  incomplete: "未完成",
  finalizing: "收尾中",
};

interface CountryCount extends Record<string, unknown> {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
  total: number;
  today: number;
  yesterday: number;
}

interface RunProgress {
  pending: number;
  enqueued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  fetched: number;
  deduped: number;
  filtered: number;
  added: number;
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
  notes: string | null;
  progress?: RunProgress;
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
  utcOffset: string;
  countries: CountryCount[];
  runs: RunRow[];
  stuckBatches: number;
  failedBatches: Array<Record<string, unknown> & { id: string; country_name: string; source: string; error: string | null }>;
  apiUsage: Array<Record<string, unknown> & { source: string; calls: number; items: number }>;
  sources: Record<string, SourceState>;
  rateLimit: {
    xQps: number;
    gdeltMinIntervalSec?: number;
    hits24h: number;
    hits7d: number;
    gdeltHits24h?: number;
    gdeltHits7d?: number;
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
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  function reload() {
    api<StatusPayload>("/api/status").then(setData).catch((reason: Error) => setError(reason.message));
  }

  useEffect(() => {
    reload();
  }, []);

  function requeue(runId?: string) {
    setActionError("");
    const path = runId ? `/api/runs/${runId}/requeue` : "/api/runs/requeue";
    api<{ batches: number; warning: string | null }>(path, { method: "POST" })
      .then((result) => {
        setNotice(result.warning ?? `已恢复 ${result.batches} 个批次`);
        if (result.warning) setActionError(result.warning);
        reload();
      })
      .catch((reason: Error) => setActionError(reason.message));
  }

  function cancel(runId: string) {
    setActionError("");
    api<{ cancelledBatches: number }>(`/api/runs/${runId}/cancel`, { method: "POST" })
      .then((result) => {
        setNotice(result.cancelledBatches > 0
          ? `已取消 ${result.cancelledBatches} 个未完成批次`
          : "运行已取消");
        reload();
      })
      .catch((reason: Error) => setActionError(reason.message));
  }

  if (error) return <Banner status="error" title="无法读取状态" description={error} />;
  if (!data) return <Text type="body">正在读取状态…</Text>;

  return (
    <VStack gap={4}>
      <VStack gap={1}>
        <Heading level={1}>系统状态</Heading>
        <Text type="body" color="secondary">
          {`每天 ${data.scheduleHour}:00（${data.timezone}, ${data.utcOffset}）采集前 ${data.windowHours} 小时。下次运行 ${formatTime(data.nextRun, data.timezone)}。每个来源一条采集链，按顺序处理全部目标。`}
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
      <Heading level={2}>分组计数</Heading>
      <Table
        density="compact"
        idKey="id"
        data={data.countries}
        columns={[
          { key: "name", header: "分组" },
          { key: "today", header: "今日" },
          { key: "yesterday", header: "昨日" },
          { key: "total", header: "累计" },
          { key: "enabled", header: "启用", renderCell: (row) => (row.enabled ? "是" : "否") },
        ]}
      />
      {actionError ? <Banner status="error" title="队列操作失败" description={actionError} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      {(data.stuckBatches ?? 0) > 0 ? (
        <Banner
          status="warning"
          title={`${data.stuckBatches} 个批次卡住了`}
          description="包括还没入队、入队超过 15 分钟仍无进展，以及租约已过期仍停在进行中的批次。恢复会立刻收回进行中的批次，以及已入队但队列消息已经丢失的批次。本地 wrangler dev 的队列在内存里，重启后消息会丢，D1 仍显示已入队，用恢复即可。"
        />
      ) : null}
      <HStack gap={2}>
        <Button label="恢复卡住的批次" variant="secondary" onClick={() => requeue()} />
      </HStack>
      <Heading level={2}>最近运行</Heading>
      <Table
        density="compact"
        idKey="id"
        textOverflow="truncate"
        data={data.runs}
        columns={[
          { key: "started_at", header: timeHeader("开始", data.timezone, data.utcOffset), renderCell: (row) => formatTime(row.started_at, data.timezone) },
          { key: "trigger", header: "触发" },
          { key: "status", header: "状态", renderCell: (row) => RUN_STATUS[row.status] ?? row.status },
          {
            key: "progress",
            header: "批次",
            renderCell: (row) => {
              const progress = row.progress;
              if (!progress) return `失败 ${row.batches_failed}`;
              return `待入队 ${progress.pending} · 已入队 ${progress.enqueued} · 进行 ${progress.running} · 完成 ${progress.done} · 失败 ${progress.failed} · 取消 ${progress.cancelled}`;
            },
          },
          {
            key: "items",
            header: "条目",
            renderCell: (row) => {
              const progress = row.progress;
              if (!progress) return `新增 ${row.records_added}`;
              return `抓取 ${progress.fetched} · 去重 ${progress.deduped} · 过滤 ${progress.filtered} · 新增 ${progress.added}`;
            },
          },
          { key: "notes", header: "说明", renderCell: (row) => row.notes || "—" },
          { key: "relevance_failed", header: "评分失败", renderCell: (row) => row.relevance_failed ?? 0 },
          { key: "email_status", header: "邮件", renderCell: (row) => row.email_status || "—" },
          {
            key: "actions",
            header: "操作",
            renderCell: (row) => {
              const open = row.status === "running" || row.status === "partial" || row.status === "failed" || row.status === "incomplete";
              if (!open) return "—";
              return (
                <HStack gap={1}>
                  <Button label="恢复" variant="secondary" size="sm" onClick={() => requeue(row.id)} />
                  <Button label="取消" variant="ghost" size="sm" onClick={() => cancel(row.id)} />
                </HStack>
              );
            },
          },
        ]}
      />
      <Heading level={2}>失败批次</Heading>
      <Table
        density="compact"
        idKey="id"
        data={data.failedBatches}
        columns={[
          { key: "country_name", header: "范围" },
          { key: "source", header: "来源" },
          { key: "error", header: "错误", renderCell: (row) => row.error || "—" },
        ]}
      />
      <Heading level={2}>限流</Heading>
      <Text type="body" color="secondary">
        {`X 当前每秒 ${data.rateLimit.xQps} 次。近 24 小时 ${data.rateLimit.hits24h} 次，近 7 日 ${data.rateLimit.hits7d} 次。最近一次 ${formatTime(data.rateLimit.lastHitAt, data.timezone)}，Retry-After ${data.rateLimit.lastRetryAfterSeconds ?? "—"} 秒。`}
      </Text>
      <Text type="body" color="secondary">
        {`GDELT 最小间隔 ${data.rateLimit.gdeltMinIntervalSec ?? 6} 秒。近 24 小时 ${data.rateLimit.gdeltHits24h ?? 0} 次，近 7 日 ${data.rateLimit.gdeltHits7d ?? 0} 次。`}
      </Text>
      <Table
        density="compact"
        idKey="id"
        data={data.rateLimit.recent}
        columns={[
          { key: "recordedAt", header: timeHeader("时间", data.timezone, data.utcOffset), renderCell: (row) => formatTime(row.recordedAt, data.timezone) },
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
