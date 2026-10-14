import { describe, expect, it } from "vitest";
import { parseSettings, validateSettingsPatch } from "../src/config/settings";
import type { QueryTarget } from "../src/domain/types";
import { RateLimitError, xProvider } from "../src/sources/x";
import {
  assignSlot,
  intervalMsForQps,
  parseRetryAfter,
  retryDelaySeconds,
  shouldWaitInBatch,
} from "../src/sources/x-rate";

const target: QueryTarget = { id: "t1", kind: "keyword", name: "示例", query: "示例" };
const window = {
  start: new Date("2026-10-11T02:00:00.000Z"),
  end: new Date("2026-10-12T02:00:00.000Z"),
};

function page(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("X 请求速率", () => {
  it("把每秒请求数换成调用间隔", () => {
    expect(intervalMsForQps(0.2)).toBe(5000);
    expect(intervalMsForQps(10)).toBe(100);
    expect(intervalMsForQps(20)).toBe(50);
    expect(intervalMsForQps(Number.NaN)).toBe(5000);
  });

  it("后一次调用排在前一次的间隔之后", () => {
    const first = assignSlot(0, 1_000, 5_000);
    expect(first).toEqual({ slotAtMs: 1_000, nextAtMs: 6_000 });
    const second = assignSlot(first.nextAtMs, 1_000, 5_000);
    expect(second.slotAtMs - first.slotAtMs).toBe(5_000);
  });

  it("读取 Retry-After 的秒数和 HTTP 日期", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfter("1.2", now)).toBe(1.2);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:30 GMT", now)).toBe(30);
  });

  it("没有 Retry-After 时按次数退避，短等待留在批次内", () => {
    expect(retryDelaySeconds({ attempt: 0, retryAfterSeconds: null })).toBe(5);
    expect(retryDelaySeconds({ attempt: 1, retryAfterSeconds: null })).toBe(10);
    expect(retryDelaySeconds({ attempt: 2, retryAfterSeconds: null })).toBe(20);
    expect(retryDelaySeconds({ attempt: 3, retryAfterSeconds: null })).toBe(40);
    expect(retryDelaySeconds({ attempt: 0, retryAfterSeconds: 45 })).toBe(45);
    expect(retryDelaySeconds({ attempt: 0, retryAfterSeconds: 5000 })).toBe(900);
    expect(shouldWaitInBatch(20, 0)).toBe(true);
    expect(shouldWaitInBatch(20, 2)).toBe(true);
    expect(shouldWaitInBatch(20, 3)).toBe(false);
    expect(shouldWaitInBatch(21, 0)).toBe(false);
  });

  it("默认 0.2，并拒绝超出 0.1 到 20 的配置", () => {
    expect(parseSettings({}).xQps).toBe(0.2);
    expect(parseSettings({ x_qps: "10" }).xQps).toBe(10);
    expect(validateSettingsPatch({ x_qps: "10" }).x_qps).toBe("10");
    expect(validateSettingsPatch({ x_qps: "0.25" }).x_qps).toBe("0.25");
    expect(() => validateSettingsPatch({ x_qps: "21" })).toThrow(/0\.1 到 20/);
    expect(() => validateSettingsPatch({ x_qps: "0" })).toThrow(/0\.1 到 20/);
  });

  it("每一页请求前都让出时间槽，短 429 在批次内重试", async () => {
    const paces: number[] = [];
    const waits: number[] = [];
    const notices: number[] = [];
    let hits = 0;
    const result = await xProvider.search({
      targets: [target],
      window,
      countryName: "示例",
      apiKey: "test-key",
      maxPages: 2,
      fetchImpl: async (input) => {
        const url = String(input);
        hits += 1;
        if (hits === 1) return page({ tweets: [] }, 429, { "retry-after": "1" });
        if (!url.includes("cursor=")) {
          return page({
            tweets: [{ id: "1", text: "示例正文足够长", url: "https://x.com/a/status/1", createdAt: "Tue Oct 13 00:00:00 +0000 2026" }],
            has_next_page: true,
            next_cursor: "page-2",
          });
        }
        return page({ tweets: [], has_next_page: false });
      },
      beforeRequest: async () => {
        paces.push(paces.length + 1);
      },
      onRateLimit: async (info) => {
        notices.push(info.delaySeconds);
      },
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    expect(paces).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000]);
    expect(notices).toEqual([1]);
    expect(result.calls).toBe(3);
    expect(result.records).toHaveLength(1);
  });

  it("较长的 Retry-After 交给队列，而不是在批次里睡", async () => {
    const waits: number[] = [];
    await expect(xProvider.search({
      targets: [target],
      window,
      countryName: "示例",
      apiKey: "test-key",
      fetchImpl: async () => page({ tweets: [] }, 429, { "retry-after": "45" }),
      beforeRequest: async () => {},
      onRateLimit: async () => {},
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    })).rejects.toMatchObject({
      name: "RateLimitError",
      delaySeconds: 45,
      retryAfterSeconds: 45,
      recorded: true,
    });
    expect(waits).toEqual([]);
  });

  it("连续短限流三次后改为队列退避，且未记录回调时不算已记账", async () => {
    const waits: number[] = [];
    let hits = 0;
    const error = await xProvider.search({
      targets: [target],
      window,
      countryName: "示例",
      apiKey: "test-key",
      queueAttempt: 1,
      fetchImpl: async () => {
        hits += 1;
        return page({ tweets: [] }, 429);
      },
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ delaySeconds: 40, recorded: false, retryAfterSeconds: null });
    expect(waits).toEqual([5000, 10000, 20000]);
    expect(hits).toBe(4);
    expect(new RateLimitError("Google News RSS 限流 429").delaySeconds).toBe(45);
  });
});
