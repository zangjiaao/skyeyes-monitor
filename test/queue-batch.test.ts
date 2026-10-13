import { describe, expect, it } from "vitest";
import {
  QUEUE_SEND_BYTES,
  QUEUE_SEND_LIMIT,
  chunkQueueMessages,
  enqueueErrorMessage,
  enqueueInChunks,
  enqueueRunStatus,
  firstQueuePage,
  queueMessageBytes,
  type QueueBatchSender,
} from "../src/pipeline/queue-batch";

function batchMessages(count: number, bodySize = 0): MessageSendRequest<{ type: "batch"; runId: string; batchId: string; pad?: string }>[] {
  return Array.from({ length: count }, (_, index) => ({
    body: {
      type: "batch" as const,
      runId: "run-1",
      batchId: `batch-${index}`,
      pad: bodySize > 0 ? "x".repeat(bodySize) : undefined,
    },
    delaySeconds: Math.min(index * 3, 900),
  }));
}

function strictQueue(options: { failTimes?: number } = {}): QueueBatchSender<unknown> & {
  calls: number[][];
  sleeps: number[];
} {
  const calls: number[][] = [];
  let remainingFailures = options.failTimes ?? 0;
  return {
    calls,
    sleeps: [],
    async sendBatch(messages) {
      const list = [...messages];
      const bytes = list.reduce((sum, message) => sum + queueMessageBytes(message), 0);
      if (list.length === 0 || list.length > QUEUE_SEND_LIMIT || bytes > QUEUE_SEND_BYTES) {
        throw new Error("Unknown Internal Error (15000)");
      }
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Unknown Internal Error (15000)");
      }
      calls.push(list.map(() => list.length));
    },
  };
}

describe("采集队列按 100 条和 256KB 拆分", () => {
  it.each([0, 100, 101, 182, 1000])("%i 个批次不会一次发出超过上限", async (count) => {
    const queue = strictQueue();
    const result = await enqueueInChunks(queue, batchMessages(count), { sleep: async () => {} });
    expect(result.error).toBeNull();
    expect(result.sent).toHaveLength(count);
    expect(result.failed).toHaveLength(0);
    const sizes = queue.calls.map((call) => call.length);
    expect(sizes.every((size) => size > 0 && size <= 100)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(count);
    if (count === 0) expect(queue.calls).toHaveLength(0);
    if (count === 100) expect(sizes).toEqual([100]);
    if (count === 101) expect(sizes).toEqual([100, 1]);
    if (count === 182) expect(sizes).toEqual([100, 82]);
    if (count === 1000) expect(sizes).toEqual(Array.from({ length: 10 }, () => 100));
  });

  it("单次调用只取第一页，1000 个批次剩下 900 个交给后续消息", () => {
    expect(firstQueuePage(batchMessages(0))).toEqual({ page: [], remaining: 0 });
    expect(firstQueuePage(batchMessages(100)).remaining).toBe(0);
    expect(firstQueuePage(batchMessages(100)).page).toHaveLength(100);
    expect(firstQueuePage(batchMessages(101))).toMatchObject({ remaining: 1 });
    expect(firstQueuePage(batchMessages(101)).page).toHaveLength(100);
    expect(firstQueuePage(batchMessages(182)).page).toHaveLength(100);
    expect(firstQueuePage(batchMessages(182)).remaining).toBe(82);
    expect(firstQueuePage(batchMessages(1000)).page).toHaveLength(100);
    expect(firstQueuePage(batchMessages(1000)).remaining).toBe(900);
  });

  it("超过 256KB 时在 100 条之前就拆开", () => {
    const chunks = chunkQueueMessages(batchMessages(5, 100_000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = chunk.reduce((sum, message) => sum + queueMessageBytes(message), 0);
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(bytes).toBeLessThanOrEqual(QUEUE_SEND_BYTES);
    }
    expect(chunks.flat()).toHaveLength(5);
  });

  it("失败的分片按退避重试，耗尽后只标出未发出的批次", async () => {
    const queue = strictQueue({ failTimes: 2 });
    const sleeps: number[] = [];
    const retried = await enqueueInChunks(queue, batchMessages(100), {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([200, 500]);
    expect(retried.sent).toHaveLength(100);
    expect(retried.error).toBeNull();

    let attempts = 0;
    const partial = await enqueueInChunks({
      async sendBatch(messages) {
        const list = [...messages];
        attempts += 1;
        if (list.length !== 100) throw new Error("Unknown Internal Error (15000)");
      },
    }, batchMessages(182), { attempts: 3, sleep: async () => {} });
    expect(attempts).toBe(1 + 3);
    expect(partial.sent).toHaveLength(100);
    expect(partial.failed).toHaveLength(82);
    expect(partial.error).toContain("100 条");
    expect(partial.error).not.toContain("15000");
    expect(partial.error).not.toContain("Unknown Internal Error");
  });

  it("运行状态按已入队、失败和仍待发送计算", () => {
    expect(enqueueRunStatus({ sent: 0, failed: 0, pending: 0 })).toBe("running");
    expect(enqueueRunStatus({ sent: 182, failed: 0, pending: 0 })).toBe("running");
    expect(enqueueRunStatus({ sent: 100, failed: 0, pending: 82 })).toBe("running");
    expect(enqueueRunStatus({ sent: 100, failed: 82, pending: 0 })).toBe("partial");
    expect(enqueueRunStatus({ sent: 0, failed: 100, pending: 82 })).toBe("partial");
    expect(enqueueRunStatus({ sent: 0, failed: 182, pending: 0 })).toBe("failed");
    expect(enqueueErrorMessage(new Error("Unknown Internal Error (15000)"))).not.toContain("15000");
  });
});
