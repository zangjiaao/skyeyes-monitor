import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app";
import { ATTACHMENT_LIMIT_BYTES } from "../src/email/types";

interface SentMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: string }>;
}

function createHarness(options: {
  settings?: Record<string, string>;
  recipients?: string[];
  file?: Uint8Array | null;
  putError?: string;
  resendKey?: string | null;
  resendStatus?: number;
  resendMessage?: string;
  cloudflareError?: string;
} = {}) {
  const settings = new Map<string, string>([
    ["email_enabled", "0"],
    ["email_provider", "resend"],
    ["email_from", "news@example.com"],
    ["email_from_name", "SkyEyes"],
    ["app_base_url", "https://sky.example.com"],
    ["excel_key", "skyeyes.xlsx"],
  ]);
  for (const [key, value] of Object.entries(options.settings ?? {})) settings.set(key, value);
  const recipients = options.recipients ?? ["a@example.com", "b@example.com"];
  const files = new Map<string, Uint8Array>();
  if (options.file) files.set(settings.get("excel_key") || "skyeyes.xlsx", options.file);
  const sent: SentMail[] = [];
  const cloudflareSent: Array<{ to: string[]; subject: string; text: string; attachments?: unknown[] }> = [];
  const record = {
    country_name: "示例国家甲",
    original_text: "一条记录",
    published_at: "2026-10-13T02:00:00.000Z",
    author_handle: "someone",
    author_name: "某人",
    author_url: "https://x.com/someone",
    source: "x",
    url: "https://x.com/someone/status/1",
    matched_target: "示例目标",
    matched_term: "示例",
    collected_at: "2026-10-13T02:01:00.000Z",
    translation_zh: "译文",
    translation_status: "ok",
    translation_error: null,
    relevance_score: 80,
    ai_summary: "摘要",
  };
  const execute = (sql: string, binds: unknown[]) => {
    if (sql.includes("FROM settings")) {
      const results = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return { results, first: results[0] ?? null };
    }
    if (sql.includes("FROM recipients")) {
      const results = recipients.map((email) => ({ email }));
      return { results, first: results[0] ?? null };
    }
    if (sql.includes("FROM countries")) {
      return { results: [{ name: "示例国家甲" }], first: { name: "示例国家甲" } };
    }
    if (sql.includes("FROM records")) {
      let matched = [record];
      if (sql.includes("LIMIT") && binds.length >= 2) {
        const limit = Number(binds[binds.length - 2]);
        const offset = Number(binds[binds.length - 1]);
        matched = matched.slice(offset, offset + limit);
      }
      return { results: matched, first: matched[0] ?? null };
    }
    return { results: [] as unknown[], first: null };
  };
  const statement = (sql: string, binds: unknown[]) => ({
    all: async () => ({ results: execute(sql, binds).results }),
    first: async () => execute(sql, binds).first,
    run: async () => ({ meta: { changes: 0 } }),
  });
  const env = {
    ENVIRONMENT: "development",
    EXCEL_FILENAME: "skyeyes.xlsx",
    RESEND_API_KEY: options.resendKey === null ? undefined : (options.resendKey ?? "re_test"),
    DB: {
      prepare(sql: string) {
        return {
          bind: (...binds: unknown[]) => statement(sql, binds),
          ...statement(sql, []),
        };
      },
    },
    EXPORTS: {
      async get(key: string) {
        const bytes = files.get(key);
        if (!bytes) return null;
        const copy = new Uint8Array(bytes);
        return { arrayBuffer: async () => copy.buffer };
      },
      async put(key: string, value: Uint8Array) {
        if (options.putError) throw new Error(options.putError);
        files.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      },
    },
    EMAIL: {
      async send(message: { to: string[]; subject: string; text: string; attachments?: unknown[] }) {
        if (options.cloudflareError) throw new Error(options.cloudflareError);
        cloudflareSent.push(message);
        return { messageId: "cf-1" };
      },
    },
  } as unknown as Env;
  const ctx = {
    access: { async getIdentity() { return { email: "dev@example.com" }; } },
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch ${url}`);
    sent.push(JSON.parse(String(init?.body ?? "{}")) as SentMail);
    if ((options.resendStatus ?? 200) >= 400) {
      return new Response(JSON.stringify({ message: options.resendMessage ?? `Resend ${options.resendStatus}` }), {
        status: options.resendStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "email_1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { app: createApp(), env, ctx, files, sent, cloudflareSent, fetchImpl };
}

async function postTest(
  harness: ReturnType<typeof createHarness>,
  body?: unknown,
  contentType = "application/json",
) {
  vi.stubGlobal("fetch", harness.fetchImpl);
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": contentType };
    init.body = JSON.stringify(body);
  }
  const response = await harness.app.request("/api/email/test", init, harness.env, harness.ctx);
  const payload = await response.json() as {
    ok?: boolean;
    error?: string;
    to?: string[];
    attached?: boolean;
    generated?: boolean;
    excelError?: string | null;
    provider?: string;
  };
  return { status: response.status, payload };
}

describe("测试邮件", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("每日邮件关闭时仍发给全部启用收件人，并附上已有 Excel", async () => {
    const harness = createHarness({ file: new Uint8Array([1, 2, 3, 4]) });
    const result = await postTest(harness, {});
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      ok: true,
      to: ["a@example.com", "b@example.com"],
      attached: true,
      generated: false,
      excelError: null,
      provider: "resend",
    });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      from: "SkyEyes <news@example.com>",
      to: ["a@example.com", "b@example.com"],
      subject: "SkyEyes 测试邮件",
    });
    expect(harness.sent[0]?.text).toContain("每日邮件可以保持关闭");
    expect(harness.sent[0]?.attachments?.[0]?.filename).toBe("skyeyes.xlsx");
    expect(harness.sent[0]?.attachments?.[0]?.content).toBeTruthy();
  });

  it("可以只发给对话框里的一个地址，不必已在收件人列表", async () => {
    const harness = createHarness({ file: new Uint8Array([9]), recipients: [] });
    const result = await postTest(harness, { to: "Other@Example.com" });
    expect(result.status).toBe(200);
    expect(result.payload.to).toEqual(["other@example.com"]);
    expect(harness.sent[0]?.to).toEqual(["other@example.com"]);
  });

  it("没有 Excel 时先生成再附上", async () => {
    const harness = createHarness({ file: null });
    const result = await postTest(harness);
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ ok: true, attached: true, generated: true, excelError: null });
    expect(harness.files.get("skyeyes.xlsx")?.byteLength).toBeGreaterThan(0);
    expect(harness.sent[0]?.attachments?.[0]?.filename).toBe("skyeyes.xlsx");
  });

  it("生成失败时仍发出不带附件的测试信，并带回原因", async () => {
    const harness = createHarness({ file: null, putError: "R2 写入失败" });
    const result = await postTest(harness, {});
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ ok: true, attached: false, generated: false, excelError: "R2 写入失败" });
    expect(harness.sent[0]?.attachments).toBeUndefined();
    expect(harness.sent[0]?.text).toContain("没有附上 Excel：R2 写入失败");
  });

  it("超过 4MB 时不附件，正文给出下载链接", async () => {
    const harness = createHarness({ file: new Uint8Array(ATTACHMENT_LIMIT_BYTES + 1) });
    const result = await postTest(harness, {});
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ ok: true, attached: false, generated: false, excelError: null });
    expect(harness.sent[0]?.attachments).toBeUndefined();
    expect(harness.sent[0]?.text).toContain("https://sky.example.com/api/export/excel");
  });

  it("没有站点地址时说明文件仍在 R2", async () => {
    const harness = createHarness({
      file: new Uint8Array(ATTACHMENT_LIMIT_BYTES + 1),
      settings: { app_base_url: "" },
    });
    const result = await postTest(harness, {});
    expect(result.payload.attached).toBe(false);
    expect(harness.sent[0]?.text).toContain("未配置站点地址");
    expect(harness.sent[0]?.text).not.toContain("/api/export/excel");
  });

  it("邮箱格式不对、没有收件人、发件人为空、缺少密钥都会返回原文", async () => {
    const bad = await postTest(createHarness({ file: new Uint8Array([1]) }), { to: "not-an-email" });
    expect(bad).toMatchObject({ status: 400, payload: { error: "邮箱格式不正确" } });

    const typed = await postTest(createHarness({ file: new Uint8Array([1]) }), { to: 1 });
    expect(typed).toMatchObject({ status: 400, payload: { error: "收件人必须是邮箱" } });

    const empty = await postTest(createHarness({ file: new Uint8Array([1]), recipients: [] }), {});
    expect(empty).toMatchObject({ status: 400, payload: { error: "没有启用的收件人" } });

    const from = await postTest(createHarness({ settings: { email_from: "  " } }), {});
    expect(from).toMatchObject({ status: 400, payload: { error: "未配置发件人" } });

    const key = await postTest(createHarness({ file: new Uint8Array([1]), resendKey: null }), {});
    expect(key).toMatchObject({ status: 400, payload: { error: "未配置 RESEND_API_KEY" } });
    expect(key.payload.ok).toBeUndefined();
  });

  it("Resend 拒绝时把服务商的错误原文返回给页面", async () => {
    const harness = createHarness({
      file: new Uint8Array([1]),
      resendStatus: 403,
      resendMessage: "The domain is not verified",
    });
    const result = await postTest(harness, {});
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe("The domain is not verified");
    expect(harness.sent).toHaveLength(1);
  });

  it("Cloudflare 发信失败时同样返回绑定抛出的原文", async () => {
    const harness = createHarness({
      file: new Uint8Array([1]),
      settings: { email_provider: "cloudflare" },
      cloudflareError: "The domain is not verified",
    });
    const result = await postTest(harness, {});
    expect(result).toMatchObject({ status: 400, payload: { error: "The domain is not verified" } });
    expect(harness.sent).toHaveLength(0);
    expect(harness.cloudflareSent).toHaveLength(0);
  });
});
