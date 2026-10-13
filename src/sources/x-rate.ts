export const X_QPS_MIN = 0.1;
export const X_QPS_MAX = 20;
export const X_QPS_DEFAULT = 0.2;
export const X_RATE_SLOT = "twitterapi.io";
export const IN_BATCH_RETRY_MAX_SECONDS = 20;
export const IN_BATCH_MAX_WAITS = 3;
const QUEUE_DELAY_CAP_SECONDS = 900;

export function normalizeXQps(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return X_QPS_DEFAULT;
  const clamped = Math.min(X_QPS_MAX, Math.max(X_QPS_MIN, parsed));
  return Math.round(clamped * 100) / 100;
}

export function intervalMsForQps(qps: number): number {
  const safe = Number.isFinite(qps) && qps > 0 ? qps : X_QPS_DEFAULT;
  return Math.max(1, Math.round(1000 / safe));
}

export function assignSlot(previousNextMs: number, nowMs: number, intervalMs: number): {
  slotAtMs: number;
  nextAtMs: number;
} {
  const slotAtMs = Math.max(previousNextMs, nowMs);
  return { slotAtMs, nextAtMs: slotAtMs + intervalMs };
}

export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - nowMs) / 1000);
}

export function retryDelaySeconds(input: {
  attempt: number;
  retryAfterSeconds: number | null;
}): number {
  const header = input.retryAfterSeconds;
  if (header != null && header > 0) {
    return clampQueueDelay(Math.ceil(header));
  }
  const attempt = Math.max(0, input.attempt);
  const backoff = Math.min(120, 5 * 2 ** attempt);
  return clampQueueDelay(backoff);
}

export function shouldWaitInBatch(delaySeconds: number, waitsAlready: number): boolean {
  return delaySeconds <= IN_BATCH_RETRY_MAX_SECONDS && waitsAlready < IN_BATCH_MAX_WAITS;
}

function clampQueueDelay(seconds: number): number {
  if (!Number.isFinite(seconds)) return 5;
  return Math.min(QUEUE_DELAY_CAP_SECONDS, Math.max(1, Math.floor(seconds)));
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reserveXSlot(db: D1Database, qps: number, nowMs = Date.now()): Promise<number> {
  const intervalMs = intervalMsForQps(qps);
  await db.prepare(
    "INSERT OR IGNORE INTO rate_slots (name, next_at_ms) VALUES (?, 0)",
  ).bind(X_RATE_SLOT).run();
  const row = await db.prepare(
    `UPDATE rate_slots
     SET next_at_ms = MAX(next_at_ms, ?1) + ?2
     WHERE name = ?3
     RETURNING next_at_ms`,
  ).bind(nowMs, intervalMs, X_RATE_SLOT).first<{ next_at_ms: number }>();
  if (!row) {
    throw new Error("twitterapi.io 限速表不存在，请先执行数据库迁移");
  }
  return row.next_at_ms - intervalMs;
}

export async function recordRateEvent(db: D1Database, event: {
  source: string;
  status: number;
  retryAfterSeconds: number | null;
  delaySeconds: number;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO rate_events (id, source, status, retry_after_seconds, delay_seconds, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    event.source,
    event.status,
    event.retryAfterSeconds,
    event.delaySeconds,
    new Date().toISOString(),
  ).run();
}
