import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, proportional } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { api, formatTime } from "../api";

const STATUS: Record<string, string> = {
  running: "执行中", partial: "部分失败", failed: "失败", cancelled: "已取消",
  completed: "已完成", incomplete: "未完成", finalizing: "收尾中",
};
const SOURCE: Record<string, string> = { x: "X", google_news: "Google News", gdelt: "GDELT" };
const EMAIL: Record<string, string> = { sent: "已发送", failed: "发送失败", skipped: "未发送", sending: "发送中" };
const EVENTS: Record<string, string> = {
  "run started": "任务开始", "batch started": "开始或恢复来源", "source query request": "请求上游",
  "source query response": "收到响应", "source query wait": "接口等待", "source query result": "命中校验", "source page stored": "保存本页",
  "source query error": "请求失败", "batch deferred": "延后续跑", "batch retry": "错误重试",
  "batch failed": "来源失败", "batch done": "来源完成", "run cancelled": "取消任务", "run finalized": "任务结束",
};
const REASONS: Record<string, string> = {
  global_duplicate: "与已有内容重复", page_duplicate_or_invalid: "页内重复或格式无效", insert_conflict: "已存在相同记录",
  "time:out_of_window": "超出采集窗口", "time:unknown": "发布时间不明", relevance: "相关度不足",
  "rule:short": "正文过短", "rule:word": "命中排除词", "rule:blocked": "账号被屏蔽",
  "rule:retweet": "转发", "rule:ad": "广告", "rule:followers": "粉丝数不足", "rule:account_age": "账号年龄不足",
  missing_attribution: "缺少命中目标", record_error: "条目处理异常",
};
const isActive = (status: string) => ["running", "partial", "finalizing"].includes(status);

interface Progress {
  pending: number; enqueued: number; running: number; done: number; failed: number; cancelled: number;
  received: number; fetched: number; deduped: number; filtered: number; added: number;
  queriesDone: number; queriesTotal: number; calls: number;
}
interface Run extends Record<string, unknown> {
  id: string; trigger: string; status: string; started_at: string; finished_at: string | null;
  deadline_at: string; window_start: string; window_end: string; batches_total: number;
  records_added: number; translation_failed: number; relevance_failed: number; email_status: string | null; email_error: string | null; notes: string | null;
  scope: { mode: string; countries: Array<{ id: string; name: string }>; targetCount: number } | null;
  progress: Progress;
}
interface Query {
  countryName?: string; targetName?: string; terms?: string[]; query?: string; step?: number; page?: number;
  edition?: string; rawItems?: number; matchedItems?: number; inserted?: number; added?: number; storeOnly?: number;
  deduped?: number; filtered?: number; providerFiltered?: number; status?: number; error?: string;
  reason?: string; reasons?: Record<string, number>; deferred?: boolean; deferReason?: string;
  nextStep?: number; nextPage?: number; delaySeconds?: number; unprocessed?: number;
}
interface Batch extends Record<string, unknown> {
  id: string; source: string; status: string; queries_done: number; queries_total: number;
  items_received: number; items_fetched: number; items_deduped: number; items_filtered: number; items_added: number;
  calls: number; attempts: number; defer_count: number; next_wake_at: string | null; error: string | null;
  activity: { label: string; stuckReason: string | null; lastActivityAt: string | null };
  query: Query | null;
  waitReason?: string | null;
}
interface Event extends Record<string, unknown> { id: number; created_at: string; source: string | null; batch_id: string | null; type: string; details: Query }
interface Detail {
  run: Run; stallReason: string | null; batches: Batch[];
  records: { stored: number; deliverable: number; translationFailed: number; relevanceFailed: number };
  issues: Array<Record<string, unknown> & { id: string; source: string; matched_target: string; translation_error: string | null; relevance_error: string | null }>;
}
interface Overview {
  timezone: string; utcOffset: string; nextRun: string; scheduleHour: number; windowHours: number;
  stuckBatches: number; runs: Run[];
  countries: Array<Record<string, unknown> & { id: string; name: string; today: number; yesterday: number; total: number }>;
  sources: Record<string, Record<string, unknown> & { label: string; enabled: boolean; configured: boolean; lastStatus: string | null; lastError: string | null }>;
  delivery: { accessConfigured: boolean; translationEnabled: boolean; deepseekConfigured: boolean; emailEnabled: boolean; fromConfigured: boolean };
  rateLimit: { xQps: number; hits24h: number; gdeltHits24h?: number; gdeltMinIntervalSec?: number };
}
interface History { runs: Run[]; total: number; pageSize: number }
interface EventPage { events: Event[]; nextBefore: number | null }

function scope(run: Run): string {
  if (!run.scope) return "历史任务";
  const names = run.scope.countries.map((country) => country.name).join("、");
  return run.scope.mode === "all" ? `全部分组 · ${run.scope.countries.length}` : names || "指定分组";
}
function queryProgress(done: number, total: number): string { return total > 0 ? `${done} / ${total}` : "—"; }
function duration(start: string, end?: string | null): string {
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
function preciseTime(value: string | null | undefined, zone: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
}
function eventSummary(event: Event): string {
  const d = event.details;
  if (event.type === "run finalized") {
    if (d.reason === "preempt") return "已到下一次定时运行，按已有结果结束";
    if (d.reason === "deadline") return "采集长时间没有进展，按已有结果结束";
    return "采集完成，汇总结束";
  }
  if (event.type === "source query response") return `HTTP ${d.status ?? "—"}`;
  if (event.type === "source query result") return `上游返回 ${d.rawItems ?? 0} → 命中 ${d.matchedItems ?? 0}`;
  if (event.type === "source page stored") {
    const reasons = Object.entries(d.reasons ?? {}).map(([reason, count]) => `${REASONS[reason] ?? reason} ${count}`).join("；");
    return `入库 ${d.inserted ?? 0} · 可投递 ${d.added ?? 0} · 仅留档 ${d.storeOnly ?? 0}${reasons ? `；${reasons}` : ""}${d.deferred ? `；剩余 ${d.unprocessed ?? 0} 条待续跑` : ""}`;
  }
  if (event.type === "batch deferred" || event.type === "source query wait") return `${d.reason ?? "等待续跑"}；${d.delaySeconds ?? 0} 秒后唤醒`;
  return d.error ?? d.query ?? d.reason ?? "—";
}

function runState(run: Run) {
  const label = STATUS[run.status] ?? run.status;
  const warning = run.relevance_failed > 0 || run.translation_failed > 0;
  const variant = run.status === "failed" ? "error" : ["partial", "incomplete"].includes(run.status)
    ? "warning" : run.status === "completed" ? "success" : isActive(run.status) ? "accent" : "neutral";
  return <HStack gap={2} align="center"><StatusDot variant={variant} label={label} /><Text type="body">{label}</Text>{warning ? <Icon icon="warning" color="warning" size="sm" label="AI 处理异常" /> : null}</HStack>;
}
function batchLabel(batch: Batch): string {
  if (batch.activity.stuckReason) return "无进展";
  return ({
    "处理翻译、评分和入库": "处理内容", "按计划等待续跑": "等待续跑",
    "等待请求间隔或限流重试": "接口等待", "读取响应并校验命中": "校验结果",
    "查询上游接口": "查询中", "已入队，等待执行": "排队中",
  })[batch.activity.label] ?? batch.activity.label;
}

export function StatusPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("run") ?? "";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [eventPage, setEventPage] = useState<EventPage | null>(null);
  const [eventCursor, setEventCursor] = useState<number | null>(null);
  const [eventTrail, setEventTrail] = useState<Array<number | null>>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [filter, setFilter] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState("events");

  function selectRun(id: string) {
    if (id === selectedId) return;
    setDetail(null); setEventPage(null); setDetailError("");
    setEventCursor(null); setEventTrail([]); setParams({ run: id });
  }

  useEffect(() => {
    let alive = true;
    let inflight = false;
    async function reload() {
      if (inflight) return;
      inflight = true;
      try {
        const [status, runs] = await Promise.all([
          api<Overview>("/api/status"), api<History>(`/api/runs?page=${historyPage}&status=${filter}`),
        ]);
        if (alive) { setOverview(status); setHistory(runs); setError(""); setUpdatedAt(new Date().toISOString()); }
      } catch (reason) { if (alive) setError(reason instanceof Error ? reason.message : "刷新失败"); }
      finally { inflight = false; }
    }
    void reload();
    const timer = autoRefresh ? window.setInterval(() => { if (!document.hidden) void reload(); }, 10000) : null;
    return () => { alive = false; if (timer !== null) window.clearInterval(timer); };
  }, [historyPage, filter, autoRefresh, refreshKey]);

  useEffect(() => {
    if (!selectedId && overview?.runs.length) {
      const first = overview.runs.find((run) => isActive(run.status)) ?? overview.runs[0];
      setParams({ run: first.id }, { replace: true });
    }
  }, [selectedId, overview, setParams]);

  useEffect(() => {
    setEventCursor(null); setEventTrail([]); setDetail(null); setEventPage(null);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    let inflight = false;
    async function reload() {
      if (inflight) return;
      inflight = true;
      try {
        const [result, events] = await Promise.all([
          api<Detail>(`/api/runs/${encodeURIComponent(selectedId)}`),
          inspectorOpen && inspectorTab === "events" ? api<EventPage>(`/api/runs/${encodeURIComponent(selectedId)}/events${eventCursor === null ? "" : `?before=${eventCursor}`}`) : Promise.resolve(null),
        ]);
        if (alive) { setDetail(result); if (events) setEventPage(events); setDetailError(""); }
      } catch (reason) { if (alive) setDetailError(reason instanceof Error ? reason.message : "详情读取失败"); }
      finally { inflight = false; }
    }
    void reload();
    const timer = autoRefresh ? window.setInterval(() => { if (!document.hidden) void reload(); }, 10000) : null;
    return () => { alive = false; if (timer !== null) window.clearInterval(timer); };
  }, [selectedId, eventCursor, autoRefresh, refreshKey, inspectorOpen, inspectorTab]);

  async function action(type: "requeue" | "cancel", runId?: string) {
    if (actionBusy) return;
    setActionBusy(true); setActionError("");
    try {
      const path = type === "cancel" ? `/api/runs/${runId}/cancel` : runId ? `/api/runs/${runId}/requeue` : "/api/runs/requeue";
      const result = await api<{ batches?: number; cancelledBatches?: number; warning?: string | null }>(path, { method: "POST" });
      setCancelId(null);
      setNotice(result.warning ?? (type === "cancel" ? `已取消 ${result.cancelledBatches ?? 0} 个未完成来源` : `已重新入队 ${result.batches ?? 0} 个采集来源`));
      if (result.warning) setActionError(result.warning);
      setRefreshKey((key) => key + 1);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "操作失败"); }
    finally { setActionBusy(false); }
  }

  const zone = overview?.timezone ?? "Asia/Shanghai";
  const time = (value?: string | null) => formatTime(value, zone);
  const activityTime = (value?: string | null) => preciseTime(value, zone);
  const activeRuns = overview?.runs.filter((run) => isActive(run.status)) ?? [];
  const historyPages = Math.max(1, Math.ceil((history?.total ?? 0) / 20));
  const run = detail?.run;
  const stuck = detail?.batches.filter((batch) => batch.activity.stuckReason) ?? [];
  const canRecover = Boolean(run && ["running", "partial", "failed"].includes(run.status) && detail?.batches.some((batch) =>
    batch.activity.stuckReason || (batch.status === "queued" && !batch.next_wake_at) || (batch.status === "failed" && batch.error?.startsWith("未入队"))));

  const clock = (value?: string | null) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "—";
  function inspect(id: string, tab = "events") { selectRun(id); setInspectorTab(tab); setInspectorOpen(true); }
  function closeInspector(open: boolean) {
    setInspectorOpen(open);
    if (!open && activeRuns[0] && selectedId !== activeRuns[0].id) selectRun(activeRuns[0].id);
  }
  const aiIssues = (detail?.records.translationFailed ?? 0) + (detail?.records.relevanceFailed ?? 0);

  return (
    <VStack gap={6}>
      <HStack justify="between" align="center" wrap="wrap" gap={3}>
        <Heading level={1}>系统状态</Heading>
        <HStack gap={3} align="center" wrap="wrap">
          <Text type="supporting" color="secondary">{clock(updatedAt)}</Text>
          <CheckboxInput label="自动刷新" value={autoRefresh} onChange={setAutoRefresh} />
          <Button label="刷新" variant="secondary" size="sm" onClick={() => setRefreshKey((key) => key + 1)} />
          <Button label="环境" variant="ghost" size="sm" onClick={() => setEnvironmentOpen(true)} />
        </HStack>
      </HStack>
      {error ? <Banner status="error" title="刷新失败" description={error} /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice("")} /> : null}
      {actionError ? <Banner status="error" title="操作失败" description={actionError} /> : null}
      {detailError ? <Banner status="error" title="任务读取失败" description={detailError} /> : null}

      <VStack gap={4}>
        <HStack justify="between" align="center" gap={3} wrap="wrap">
          <Heading level={2}>{activeRuns.length ? "当前任务" : "最近任务"}</Heading>
          {activeRuns.length > 1 ? <Selector label="执行中的任务" isLabelHidden value={selectedId} onChange={selectRun} options={activeRuns.map((item) => ({ value: item.id, label: scope(item) }))} /> : null}
        </HStack>
        {!detail ? <Text type="body" color="secondary">{selectedId ? "加载中…" : overview ? "暂无任务" : "加载中…"}</Text> : (
          <>
            <HStack justify="between" align="center" wrap="wrap" gap={3}>
              <VStack gap={2}>
                <Text type="large" weight="semibold">{scope(run!)}</Text>
                <HStack gap={3} align="center">{runState(run!)}<Text type="supporting" color="secondary">{duration(run!.started_at, run!.finished_at)}</Text></HStack>
              </VStack>
              <HStack gap={2}>
                <Button label="执行记录" variant="secondary" size="sm" onClick={() => inspect(run!.id)} />
                {canRecover ? <Button label="恢复" variant="primary" size="sm" isDisabled={actionBusy} onClick={() => { void action("requeue", run!.id); }} /> : null}
                {isActive(run!.status) || run!.status === "failed" ? <Button label="取消" variant="ghost" size="sm" isDisabled={actionBusy} onClick={() => setCancelId(run!.id)} /> : null}
              </HStack>
            </HStack>
            <ProgressBar label="检索进度" value={run!.progress.queriesDone} max={Math.max(1, run!.progress.queriesTotal)} hasValueLabel
              isIndeterminate={isActive(run!.status) && run!.progress.queriesTotal === 0}
              formatValueLabel={() => queryProgress(run!.progress.queriesDone, run!.progress.queriesTotal)}
              variant={run!.status === "completed" ? "success" : stuck.length ? "warning" : "accent"} />
            <Grid columns={4} gap={4}>
              {[
                { label: "接口返回", value: run!.progress.received },
                { label: "命中", value: run!.progress.fetched },
                { label: "入库", value: detail.records.stored ?? 0 },
                { label: "可投递", value: detail.records.deliverable ?? 0 },
              ].map((metric) => <VStack key={metric.label} gap={1}><Text type="display-3">{metric.value.toLocaleString()}</Text><Text type="supporting" color="secondary">{metric.label}</Text></VStack>)}
            </Grid>
            {detail.stallReason ? <Banner status="warning" title="任务超时，等待收尾" /> : null}
            {stuck.map((batch) => <HStack key={batch.id} gap={2} align="center" wrap="wrap"><Icon icon="warning" color="warning" /><Text type="body">{`${SOURCE[batch.source]}：${batch.activity.stuckReason}`}</Text></HStack>)}
            {aiIssues > 0 || run!.email_error ? (
              <HStack gap={2} align="center" wrap="wrap">
                <Icon icon="warning" color="warning" />
                <Text type="body">{[detail.records.translationFailed ? `翻译失败 ${detail.records.translationFailed}` : "", detail.records.relevanceFailed ? `评分失败 ${detail.records.relevanceFailed}` : "", run!.email_error ? "邮件失败" : ""].filter(Boolean).join(" · ")}</Text>
                <Button label="查看异常" variant="ghost" size="sm" onClick={() => inspect(run!.id, "issues")} />
              </HStack>
            ) : null}
            <Table density="balanced" idKey="id" data={detail.batches} columns={[
              { width: proportional(1), key: "source", header: "来源", renderCell: (row) => SOURCE[row.source] ?? row.source },
              { width: proportional(1), key: "state", header: "状态", renderCell: (row) => {
                const label = batchLabel(row);
                return <VStack gap={1}><HStack gap={2} align="center"><StatusDot
                  variant={row.activity.stuckReason || row.status === "failed" ? "error" : row.status === "done" ? "success" : row.status === "queued" || row.phase === "pacing" ? "warning" : "accent"}
                  label={label} tooltip={row.error || row.activity.stuckReason || row.waitReason || row.activity.label} /><Text type="body">{label}</Text></HStack>
                  {row.next_wake_at && row.status === "queued" ? <Text type="supporting" color="secondary">{clock(row.next_wake_at)}</Text> : null}</VStack>;
              } },
              { width: proportional(2), key: "progress", header: "进度", renderCell: (row) => <ProgressBar label={`${SOURCE[row.source]} 检索进度`} isLabelHidden value={row.queries_done} max={Math.max(1, row.queries_total)} hasValueLabel
                variant={row.status === "done" ? "success" : row.activity.stuckReason ? "warning" : "accent"}
                formatValueLabel={() => queryProgress(row.queries_done, row.queries_total)} /> },
              { width: proportional(1), key: "items_received", header: "返回" },
              { width: proportional(1), key: "items_added", header: "新增" },
            ]} />
          </>
        )}
      </VStack>

      <VStack gap={3}>
        <HStack justify="between" align="center" gap={3} wrap="wrap">
          <Heading level={2}>任务历史</Heading>
          <Selector label="任务状态" isLabelHidden value={filter} onChange={(value) => { setFilter(value); setHistoryPage(1); }} options={[
            { value: "all", label: "全部状态" }, { value: "active", label: "执行中" }, { value: "attention", label: "需要关注" },
            { value: "completed", label: "已完成" }, { value: "cancelled", label: "已取消" },
          ]} />
        </HStack>
        <Table density="compact" idKey="id" data={history?.runs ?? []} columns={[
          { width: proportional(1), key: "started_at", header: "开始", renderCell: (row) => time(row.started_at) },
          { width: proportional(2), key: "scope", header: "范围", renderCell: scope },
          { width: proportional(1), key: "status", header: "状态", renderCell: runState },
          { width: proportional(1), key: "records_added", header: "新增" },
          { width: proportional(1), key: "duration", header: "用时", renderCell: (row) => duration(row.started_at, row.finished_at) },
          { width: proportional(1), key: "actions", header: "", renderCell: (row) => <Button label="详情" variant="ghost" size="sm" onClick={() => inspect(row.id)} /> },
        ]} />
        <HStack justify="between" align="center" gap={2}>
          <Text type="supporting" color="secondary">{history?.total ?? 0} 个任务</Text>
          <HStack gap={2} align="center"><Button label="上一页" variant="ghost" size="sm" isDisabled={historyPage <= 1} onClick={() => setHistoryPage((page) => page - 1)} /><Text type="supporting">{historyPage} / {historyPages}</Text><Button label="下一页" variant="ghost" size="sm" isDisabled={historyPage >= historyPages} onClick={() => setHistoryPage((page) => page + 1)} /></HStack>
        </HStack>
      </VStack>

      <Dialog isOpen={inspectorOpen} variant="fullscreen" purpose="info" onOpenChange={closeInspector}>
        <VStack gap={4}>
          <DialogHeader title={detail ? scope(detail.run) : "任务详情"} onOpenChange={closeInspector} />
          <TabList value={inspectorTab} onChange={setInspectorTab} role="tablist" hasDivider>
            <Tab value="events" label="执行记录" panelId="run-events-panel" />
            <Tab value="issues" label="异常与等待" panelId="run-issues-panel" />
            <Tab value="meta" label="任务信息" panelId="run-meta-panel" />
          </TabList>
          {detailError ? <Banner status="error" title="读取失败" description={detailError} /> : null}
          {inspectorTab === "events" ? <VStack gap={3} id="run-events-panel" role="tabpanel" aria-label="执行记录">
            {eventPage === null ? <Text type="body" color="secondary">加载中…</Text> : eventPage.events.length === 0 ? <Text type="body" color="secondary">暂无执行记录</Text> : <Table density="compact" idKey="id" data={eventPage?.events ?? []} columns={[
              { width: proportional(1), key: "created_at", header: "时间", renderCell: (row) => clock(row.created_at) },
              { width: proportional(1), key: "source", header: "来源", renderCell: (row) => SOURCE[row.source ?? ""] ?? "任务" },
              { width: proportional(1), key: "type", header: "步骤", renderCell: (row) => EVENTS[row.type] ?? row.type },
              { width: proportional(2), key: "terms", header: "查询", renderCell: (row) => row.details.terms?.join(" / ") || "—" },
              { width: proportional(3), key: "result", header: "结果", renderCell: eventSummary },
            ]} />}
            <HStack gap={2}><Button label="较新" variant="secondary" size="sm" isDisabled={eventTrail.length === 0} onClick={() => { const trail = [...eventTrail]; setEventCursor(trail.pop() ?? null); setEventTrail(trail); }} /><Button label="更早" variant="secondary" size="sm" isDisabled={!eventPage?.nextBefore} onClick={() => { setEventTrail([...eventTrail, eventCursor]); setEventCursor(eventPage!.nextBefore); }} />{eventCursor !== null ? <Button label="最新" variant="ghost" size="sm" onClick={() => { setEventCursor(null); setEventTrail([]); }} /> : null}</HStack>
          </VStack> : null}
          {inspectorTab === "issues" ? <VStack gap={3} id="run-issues-panel" role="tabpanel" aria-label="异常">
            {detail?.stallReason ? <Banner status="warning" title="任务超时" description={detail.stallReason} /> : null}
            {detail?.run.email_error ? <Banner status="error" title="邮件发送失败" description={detail.run.email_error} /> : null}
            <Table density="compact" idKey="id" data={detail?.batches.filter((batch) => batch.error || batch.activity.stuckReason || batch.waitReason) ?? []} columns={[
              { width: proportional(1), key: "source", header: "来源", renderCell: (row) => SOURCE[row.source] ?? row.source },
              { width: proportional(3), key: "error", header: "原因", renderCell: (row) => row.error || row.activity.stuckReason || row.waitReason || "—" },
              { width: proportional(1), key: "last", header: "最近活动", renderCell: (row) => activityTime(row.activity.lastActivityAt) },
            ]} />
            {detail?.issues.length ? <Table density="compact" idKey="id" data={detail.issues} columns={[
              { width: proportional(1), key: "source", header: "来源", renderCell: (row) => SOURCE[row.source] ?? row.source },
              { width: proportional(1), key: "matched_target", header: "目标" },
              { width: proportional(2), key: "translation_error", header: "翻译", renderCell: (row) => row.translation_error || "—" },
              { width: proportional(2), key: "relevance_error", header: "评分", renderCell: (row) => row.relevance_error || "—" },
            ]} /> : null}
          </VStack> : null}
          {inspectorTab === "meta" && detail ? <VStack gap={3} id="run-meta-panel" role="tabpanel" aria-label="任务信息">
            <Table density="compact" idKey="key" data={[
              { key: "任务 ID", value: detail.run.id }, { key: "触发", value: detail.run.trigger === "manual" ? "手动" : "定时" },
              { key: "范围", value: scope(detail.run) }, { key: "开始", value: activityTime(detail.run.started_at) },
              { key: "采集窗口", value: `${time(detail.run.window_start)} — ${time(detail.run.window_end)}` },
              { key: "保险检查", value: activityTime(detail.run.deadline_at) }, { key: "结束", value: activityTime(detail.run.finished_at) },
              { key: "邮件", value: EMAIL[detail.run.email_status ?? ""] ?? "尚未发送" },
              { key: "去重 / 过滤", value: `${detail.run.progress.deduped} / ${detail.run.progress.filtered}` },
              { key: "说明", value: detail.run.notes || "—" },
            ]} columns={[{ width: proportional(1), key: "key", header: "项目" }, { width: proportional(3), key: "value", header: "值" }]} />
            <Table density="compact" idKey="id" data={detail.batches} columns={[
              { width: proportional(1), key: "source", header: "来源", renderCell: (row) => SOURCE[row.source] ?? row.source },
              { width: proportional(2), key: "query", header: "最近目标", renderCell: (row) => [row.query?.countryName, row.query?.targetName].filter(Boolean).join(" / ") || "—" },
              { width: proportional(2), key: "terms", header: "检索条件", renderCell: (row) => row.query?.query || row.query?.terms?.join(" / ") || "—" },
              { width: proportional(1), key: "last", header: "最近活动", renderCell: (row) => activityTime(row.activity.lastActivityAt) },
            ]} />
          </VStack> : null}
        </VStack>
      </Dialog>

      <Dialog isOpen={environmentOpen} purpose="info" onOpenChange={setEnvironmentOpen} width="90%">
        <VStack gap={4}>
          <DialogHeader title="运行环境" onOpenChange={setEnvironmentOpen} />
          {overview ? <>
            <Text type="body">{`下次运行 ${time(overview.nextRun)} · ${zone}`}</Text>
            <Table density="compact" idKey="label" data={Object.values(overview.sources)} columns={[
              { width: proportional(1), key: "label", header: "来源" },
              { width: proportional(1), key: "enabled", header: "启用", renderCell: (row) => row.enabled ? "是" : "否" },
              { width: proportional(1), key: "configured", header: "配置", renderCell: (row) => row.configured ? "就绪" : "缺少密钥" },
              { width: proportional(2), key: "lastError", header: "错误", renderCell: (row) => row.lastError || "—" },
            ]} />
            <Table density="compact" idKey="id" data={overview.countries} columns={[
              { width: proportional(1), key: "name", header: "分组" }, { width: proportional(1), key: "today", header: "今日" },
              { width: proportional(1), key: "yesterday", header: "昨日" }, { width: proportional(1), key: "total", header: "累计" },
            ]} />
          </> : null}
        </VStack>
      </Dialog>
      <Dialog isOpen={cancelId !== null} purpose="form" onOpenChange={(open) => { if (!open && !actionBusy) setCancelId(null); }}>
        <VStack gap={3}>
          <DialogHeader title="取消任务？" onOpenChange={(open) => { if (!open && !actionBusy) setCancelId(null); }} />
          <Text type="body">已入库的数据会保留。</Text>
          {actionError ? <Banner status="error" title="取消失败" description={actionError} /> : null}
          <HStack gap={2}><Button label="确认取消" variant="destructive" isDisabled={actionBusy} onClick={() => { void action("cancel", cancelId!); }} /><Button label="继续执行" variant="secondary" isDisabled={actionBusy} onClick={() => setCancelId(null)} /></HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
