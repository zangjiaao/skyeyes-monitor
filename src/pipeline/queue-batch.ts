export const QUEUE_SEND_LIMIT = 100;
export const QUEUE_SEND_BYTES = 256 * 1024;
export const ENQUEUE_ATTEMPTS = 3;
export const ENQUEUE_BACKOFF_MS = [200, 500, 1000] as const;
export const STUCK_BATCH_GRACE_MS = 2 * 60 * 1000;

export const NOT_ENQUEUED_ERROR = "未入队：写入采集队列失败。未能写入的批次已标出，可在状态页重新入队。已经入队的批次会继续采集。";

export interface QueueBatchSender<Body> {
  sendBatch(messages: Iterable<MessageSendRequest<Body>>): Promise<unknown>;
}

export interface EnqueueOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnqueueChunkResult<Body> {
  sent: MessageSendRequest<Body>[];
  failed: MessageSendRequest<Body>[];
  error: string | null;
}

export function queueMessageBytes(message: { body: unknown; delaySeconds?: number }): number {
  const payload = JSON.stringify({
    body: message.body,
    contentType: "json",
    delaySeconds: message.delaySeconds ?? 0,
  });
  return new TextEncoder().encode(payload).length;
}

export function chunkQueueMessages<Body>(messages: MessageSendRequest<Body>[]): MessageSendRequest<Body>[][] {
  const chunks: MessageSendRequest<Body>[][] = [];
  let current: MessageSendRequest<Body>[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = queueMessageBytes(message);
    const overflows = current.length >= QUEUE_SEND_LIMIT || (current.length > 0 && bytes + size > QUEUE_SEND_BYTES);
    if (overflows) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(message);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** One Worker 调用只发送第一页，其余交给下一条 fan-out 消息。 */
export function firstQueuePage<Body>(messages: MessageSendRequest<Body>[]): {
  page: MessageSendRequest<Body>[];
  remaining: number;
} {
  const chunks = chunkQueueMessages(messages);
  const page = chunks[0] ?? [];
  const remaining = chunks.slice(1).reduce((sum, chunk) => sum + chunk.length, 0);
  return { page, remaining };
}

export function enqueueErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/15000|256|sendBatch|too many messages|message limit/i.test(raw)) {
    return "未入队：采集队列一次最多 100 条或 256KB。未能写入的批次已标出，可在状态页重新入队。已经入队的批次会继续采集。";
  }
  return NOT_ENQUEUED_ERROR;
}

export function enqueueRunStatus(counts: { sent: number; failed: number; pending: number }): "running" | "partial" | "failed" {
  if (counts.failed === 0) return "running";
  if (counts.sent === 0 && counts.pending === 0) return "failed";
  return "partial";
}

function backoffMs(attempt: number): number {
  return ENQUEUE_BACKOFF_MS[Math.min(attempt, ENQUEUE_BACKOFF_MS.length - 1)];
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enqueueInChunks<Body>(
  queue: QueueBatchSender<Body>,
  messages: MessageSendRequest<Body>[],
  options: EnqueueOptions = {},
): Promise<EnqueueChunkResult<Body>> {
  const attempts = options.attempts ?? ENQUEUE_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const sent: MessageSendRequest<Body>[] = [];
  const failed: MessageSendRequest<Body>[] = [];
  let error: string | null = null;
  for (const chunk of chunkQueueMessages(messages)) {
    if (error) {
      failed.push(...chunk);
      continue;
    }
    let thrown: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await queue.sendBatch(chunk);
        thrown = undefined;
        break;
      } catch (cause) {
        thrown = cause;
        if (attempt + 1 < attempts) await sleep(backoffMs(attempt));
      }
    }
    if (thrown) {
      failed.push(...chunk);
      error = enqueueErrorMessage(thrown);
    } else {
      sent.push(...chunk);
    }
  }
  return { sent, failed, error };
}
