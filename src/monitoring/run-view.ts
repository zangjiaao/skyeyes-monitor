import { STALE_ENQUEUE_MS, FINALIZING_GRACE_MS } from "../pipeline/lease";

export function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export interface BatchActivityInput {
  status: string;
  phase?: string | null;
  error?: string | null;
  enqueued_at?: string | null;
  lease_expires_at?: string | null;
  next_wake_at?: string | null;
  last_activity_at?: string | null;
  created_at: string;
}

const PHASE_LABELS: Record<string, string> = {
  starting: "准备查询", fetching: "查询上游接口", parsing: "读取响应并校验命中",
  processing: "处理翻译、评分和入库", pacing: "等待请求间隔或限流重试", retrying: "等待错误重试", waiting: "等待续跑",
};

export function batchActivity(batch: BatchActivityInput, runStatus: string, now = new Date()) {
  let label = batch.status;
  let stuckReason: string | null = null;
  const timestamp = (value?: string | null) => value ? Date.parse(value) : NaN;
  if (batch.status === "done") label = "已完成";
  else if (batch.status === "failed") label = "执行失败";
  else if (batch.status === "cancelled") label = "已取消";
  else if (["completed", "incomplete", "cancelled", "finalizing"].includes(runStatus)) {
    label = runStatus === "finalizing" ? "等待任务收尾" : "任务已结束";
  } else if (batch.status === "queued") {
    if (timestamp(batch.next_wake_at) > now.getTime()) label = "按计划等待续跑";
    else if (!batch.enqueued_at || batch.enqueued_at.startsWith("claim:")) label = "等待入队";
    else label = batch.phase === "retrying" ? "等待错误重试" : "已入队，等待执行";
    const reference = batch.enqueued_at?.startsWith("claim:") ? batch.created_at : batch.enqueued_at ?? batch.created_at;
    if (timestamp(batch.next_wake_at) <= now.getTime() || !batch.next_wake_at) {
      if (now.getTime() - Math.max(timestamp(reference), timestamp(batch.next_wake_at) || 0) > STALE_ENQUEUE_MS) {
        stuckReason = batch.next_wake_at ? "续跑时间已过，队列长时间没有执行；本地重启可能丢失了队列消息" : "等待入队或执行超过 15 分钟，队列消息可能未送达";
      }
    }
  } else if (batch.status === "running") {
    label = PHASE_LABELS[batch.phase ?? ""] ?? "采集中";
    if (!batch.lease_expires_at || timestamp(batch.lease_expires_at) <= now.getTime()) {
      stuckReason = "执行租约已过期，可能被中断或开发服务已重启";
    }
  }
  return { label, stuckReason, lastActivityAt: batch.last_activity_at ?? null };
}

export function runStallReason(run: { status: string; started_at: string; deadline_at: string; finalize_enqueued_at?: string | null }, now = new Date()): string | null {
  if (run.status === "finalizing" && now.getTime() - Math.min(Date.parse(run.deadline_at), run.finalize_enqueued_at ? Date.parse(run.finalize_enqueued_at) : Infinity) > FINALIZING_GRACE_MS) {
    return "收尾仍未结束；定时维护会检查并关闭超时任务";
  }
  if (["running", "partial"].includes(run.status) && Date.parse(run.deadline_at) <= now.getTime()) {
    return "已超过采集截止时间，等待收尾；定时维护每小时执行一次";
  }
  return null;
}
