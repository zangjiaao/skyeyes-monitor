import { describe, expect, it } from "vitest";
import { buildMonitorWorkbook, readWorkbookSheets, type ExcelRecord } from "../src/export/excel";

function record(partial: Partial<ExcelRecord> & Pick<ExcelRecord, "countryName" | "collectedAt" | "originalText">): ExcelRecord {
  return {
    publishedAt: partial.collectedAt,
    authorHandle: "someone",
    authorName: "某人",
    authorUrl: "https://x.com/someone",
    source: "x",
    url: `https://x.com/someone/status/${partial.originalText}`,
    matchedTarget: "示例目标",
    translationZh: "译文",
    ...partial,
  };
}

describe("Excel", () => {
  it("每个国家一张全量历史表，并提供今日和昨日视图", () => {
    const reference = new Date("2026-10-12T04:00:00.000Z");
    const bytes = buildMonitorWorkbook({
      countries: [{ name: "示例国家甲" }, { name: "示例国家乙" }],
      reference,
      timeZone: "Asia/Shanghai",
      records: [
        record({
          countryName: "示例国家甲",
          collectedAt: "2026-10-02T02:00:00.000Z",
          originalText: "十天前",
        }),
        record({
          countryName: "示例国家甲",
          collectedAt: "2026-10-12T01:00:00.000Z",
          originalText: "今天",
        }),
        record({
          countryName: "示例国家乙",
          collectedAt: "2026-10-11T03:00:00.000Z",
          originalText: "昨天",
        }),
      ],
    });
    const sheets = readWorkbookSheets(bytes);
    expect(Object.keys(sheets)).toEqual(["示例国家甲", "示例国家乙", "今日", "昨日"]);
    expect(sheets["示例国家甲"].map((row) => row[0])).toEqual(["原文", "十天前", "今天"]);
    expect(sheets["示例国家甲"].map((row) => row[11])).toEqual(["时段", "更早", "今日"]);
    expect(sheets["示例国家乙"]).toHaveLength(2);
    expect(sheets["今日"].map((row) => row[0])).toEqual(["原文", "今天"]);
    expect(sheets["昨日"].map((row) => row[0])).toEqual(["原文", "昨天"]);
  });

  it("重新生成时保留更早的历史行", () => {
    const reference = new Date("2026-10-12T04:00:00.000Z");
    const older = record({
      countryName: "示例国家甲",
      collectedAt: "2026-09-01T02:00:00.000Z",
      originalText: "历史",
    });
    const today = record({
      countryName: "示例国家甲",
      collectedAt: "2026-10-12T01:00:00.000Z",
      originalText: "新增",
    });
    const first = readWorkbookSheets(buildMonitorWorkbook({
      countries: [{ name: "示例国家甲" }],
      records: [older],
      reference,
      timeZone: "Asia/Shanghai",
    }));
    const second = readWorkbookSheets(buildMonitorWorkbook({
      countries: [{ name: "示例国家甲" }],
      records: [older, today],
      reference,
      timeZone: "Asia/Shanghai",
    }));
    expect(first["示例国家甲"].map((row) => row[0])).toEqual(["原文", "历史"]);
    expect(second["示例国家甲"].map((row) => row[0])).toEqual(["原文", "历史", "新增"]);
    expect(second["今日"].map((row) => row[0])).toEqual(["原文", "新增"]);
  });
});
