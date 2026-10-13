import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { normalizeTitle, titlePrefix, TITLE_PREFIX_MAX_BYTES } from "../src/domain/gate";
import { findSimilarRecords, similarLookup } from "../src/records/similar";

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

const titles = {
  chinese: "国务院发布新的经济数据解读全文并且补充了更多背景说明内容给监测使用",
  hindi: "भारत सरकार ने नई आर्थिक नीति की घोषणा की है आज दिल्ली में और यह खबर काफी लंबी है",
  arabic: "أعلنت الحكومة عن سياسة اقتصادية جديدة اليوم في العاصمة مع تفاصيل إضافية للنشر",
  emoji: `${"🚨".repeat(20)}标题继续写长一些以便超过前缀`,
  long: "the government published a much longer economic briefing for observers today",
};

describe("标题前缀", () => {
  it("中文和印地语的旧 LIKE 前缀超过 50 字节，新前缀用等值并且不超过 48 字节", () => {
    for (const text of [titles.chinese, titles.hindi]) {
      const key = normalizeTitle(text);
      expect(utf8Size(`${key.slice(0, 24)}%`)).toBeGreaterThan(50);
    }
  });

  it("中文、印地语、阿拉伯语、表情和长标题的前缀都不超过 48 字节，也不再用 LIKE", () => {
    for (const text of Object.values(titles)) {
      const key = normalizeTitle(text);
      const prefix = titlePrefix(key);
      expect(Array.from(prefix).length).toBe(12);
      expect(utf8Size(prefix)).toBeLessThanOrEqual(TITLE_PREFIX_MAX_BYTES);
      const query = similarLookup("https://x.com/example/status/1", key);
      expect(query.sql.toLowerCase()).not.toContain("like");
      expect(query.sql.toLowerCase()).not.toContain("glob");
      expect(query.sql).toContain("title_prefix = ?");
      expect(query.binds[2]).toBe(prefix);
      expect(query.binds[3]).toBe(prefix);
      for (const bind of [query.binds[2], query.binds[3]]) {
        expect(utf8Size(bind)).toBeLessThanOrEqual(TITLE_PREFIX_MAX_BYTES);
      }
    }
  });

  it("不足 12 个字时不做前缀比对", () => {
    expect(titlePrefix(normalizeTitle("短标题"))).toBe("");
    const query = similarLookup("https://example.com/a", "短标题");
    expect(query.binds[2]).toBe("");
    expect(query.binds[3]).toBe("");
  });

  it("迁移按同样的 12 个字符回填并建索引", () => {
    const sql = readFileSync(new URL("../migrations/0013_title_prefix.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD COLUMN title_prefix");
    expect(sql).toContain("substr(title_key, 1, 12)");
    expect(sql).toContain("idx_records_title_prefix");
    expect(sql.toLowerCase()).not.toContain("like");
  });
});

interface Stored {
  url_key: string;
  title_key: string;
  title_prefix: string;
  published_at: string | null;
}

function createDb(rows: Stored[], mode: "ok" | "similar-fails" | "all-fail") {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              if (mode === "all-fail" || (mode === "similar-fails" && sql.includes("title_prefix"))) {
                throw new Error("D1_ERROR: LIKE or GLOB pattern too complex");
              }
              const urlKey = String(binds[0] ?? "");
              const titleKey = binds.length > 1 ? String(binds[1] ?? "") : "";
              const prefix = binds.length > 3 ? String(binds[3] ?? "") : "";
              const matched = rows.filter((row) => {
                if (row.url_key === urlKey) return true;
                if (!sql.includes("title_prefix")) return false;
                if (titleKey && row.title_key === titleKey) return true;
                return prefix !== "" && row.title_prefix === prefix;
              });
              return { results: matched.slice(0, 40) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("标题去重查询失败时仍可入库", () => {
  const hindi = normalizeTitle(titles.hindi);
  const rows: Stored[] = [
    {
      url_key: "https://x.com/RakeshK12420689/status/2109969954846146833",
      title_key: hindi,
      title_prefix: titlePrefix(hindi),
      published_at: "2026-10-12T06:00:00.000Z",
    },
  ];

  it("前缀相等的旧标题会被查出来", async () => {
    const found = await findSimilarRecords(createDb(rows, "ok"), "https://x.com/other/status/2", hindi);
    expect(found.map((row) => row.titleKey)).toEqual([hindi]);
  });

  it("主查询失败时改按链接比对，两次都失败则返回空列表而不抛出", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = "https://x.com/RakeshK12420689/status/2109969954846146833";
    const byUrl = await findSimilarRecords(createDb(rows, "similar-fails"), url, hindi);
    expect(byUrl.map((row) => row.urlKey)).toEqual([url]);
    const none = await findSimilarRecords(createDb(rows, "all-fail"), url, hindi);
    expect(none).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
