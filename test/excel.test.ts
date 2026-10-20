import { describe, expect, it } from "vitest";
import { buildMonitorWorkbook, readWorkbookSheets, type ExcelRecord } from "../src/export/excel";

function record(partial: Partial<ExcelRecord> & Pick<ExcelRecord, "countryName" | "publishedAt" | "collectedAt" | "originalText">): ExcelRecord {
  return {
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

function sheetsFor(records: ExcelRecord[]) {
  return readWorkbookSheets(buildMonitorWorkbook({
    countries: [{ name: "示例国家甲" }, { name: "示例国家乙" }],
    records,
    reference: new Date("2026-10-12T04:00:00.000Z"),
    timeZone: "Asia/Shanghai",
    scheduleHour: 10,
    windowHours: 24,
  }));
}

describe("Excel", () => {
  it("今日和昨日按发布时间的 10:00 窗口划分，同时保留采集时间", () => {
    const sheets = sheetsFor([
      record({
        countryName: "示例国家甲",
        publishedAt: "2026-10-02T02:00:00.000Z",
        collectedAt: "2026-10-12T03:00:00.000Z",
        originalText: "十天前",
      }),
      record({
        countryName: "示例国家甲",
        publishedAt: "2026-10-11T06:00:00.000Z",
        collectedAt: "2026-10-12T02:00:00.000Z",
        originalText: "今天",
      }),
      record({
        countryName: "示例国家乙",
        publishedAt: "2026-10-10T06:00:00.000Z",
        collectedAt: "2026-10-12T02:00:00.000Z",
        originalText: "昨天",
      }),
    ]);
    expect(Object.keys(sheets)).toEqual(["示例国家甲", "示例国家乙", "今日", "昨日"]);
    expect(sheets["示例国家甲"][0]).toEqual([
      "原文", "发布时间（Asia/Shanghai, UTC+8）", "作者账号", "作者显示名", "主页", "来源", "链接", "分组", "命中目标", "采集时间（Asia/Shanghai, UTC+8）", "中文译文", "时段", "命中检索词", "相关度", "中文摘要",
    ]);
    expect(sheets["示例国家甲"].map((row) => row[0])).toEqual(["原文", "十天前", "今天"]);
    expect(sheets["示例国家甲"].map((row) => row[1])).toEqual(["发布时间（Asia/Shanghai, UTC+8）", "2026-10-02 10:00", "2026-10-11 14:00"]);
    expect(sheets["示例国家甲"].map((row) => row[9])).toEqual(["采集时间（Asia/Shanghai, UTC+8）", "2026-10-12 11:00", "2026-10-12 10:00"]);
    expect(sheets["示例国家甲"].map((row) => row[11])).toEqual(["时段", "更早", "今日"]);
    expect(sheets["今日"].map((row) => row[0])).toEqual(["原文", "今天"]);
    expect(sheets["昨日"].map((row) => row[0])).toEqual(["原文", "昨天"]);
  });

  it("重新生成时保留更早的历史行", () => {
    const older = record({
      countryName: "示例国家甲",
      publishedAt: "2026-09-01T02:00:00.000Z",
      collectedAt: "2026-09-01T03:00:00.000Z",
      originalText: "历史",
    });
    const today = record({
      countryName: "示例国家甲",
      publishedAt: "2026-10-11T08:00:00.000Z",
      collectedAt: "2026-10-12T02:00:00.000Z",
      originalText: "新增",
    });
    const first = sheetsFor([older]);
    const second = sheetsFor([older, today]);
    expect(first["示例国家甲"].map((row) => row[0])).toEqual(["原文", "历史"]);
    expect(second["示例国家甲"].map((row) => row[0])).toEqual(["原文", "历史", "新增"]);
    expect(second["今日"].map((row) => row[0])).toEqual(["原文", "新增"]);
  });

  it("本轮窗口工作簿去掉今日和昨日表，避免昨日在窗口结束时刻恒为空", () => {
    const windowEnd = new Date("2026-10-13T02:00:00.000Z");
    const records = [
      record({
        countryName: "示例国家甲",
        publishedAt: "2026-10-12T06:00:00.000Z",
        collectedAt: "2026-10-13T01:00:00.000Z",
        originalText: "窗口内",
      }),
      record({
        countryName: "示例国家甲",
        publishedAt: "2026-10-12T18:00:00.000Z",
        collectedAt: "2026-10-13T01:00:00.000Z",
        originalText: "仍在窗口",
      }),
      record({
        countryName: "示例国家甲",
        publishedAt: "2026-10-11T06:00:00.000Z",
        collectedAt: "2026-10-11T07:00:00.000Z",
        originalText: "上一窗口",
      }),
    ];
    const input = {
      countries: [{ name: "示例国家甲" }, { name: "示例国家乙" }],
      records,
      reference: windowEnd,
      timeZone: "Asia/Shanghai",
      scheduleHour: 10,
      windowHours: 24,
    };

    const cumulative = readWorkbookSheets(buildMonitorWorkbook(input));
    expect(cumulative["今日"].map((row) => row[0])).toEqual(["原文", "窗口内", "仍在窗口"]);
    expect(cumulative["昨日"].map((row) => row[0])).toEqual(["原文", "上一窗口"]);
    expect(cumulative["示例国家甲"].map((row) => row[11])).toEqual(["时段", "今日", "今日", "昨日"]);

    const attachment = readWorkbookSheets(buildMonitorWorkbook({
      ...input,
      records: records.filter((item) => item.originalText !== "上一窗口"),
      periodSheets: false,
    }));
    expect(Object.keys(attachment)).toEqual(["示例国家甲", "示例国家乙"]);
    expect(attachment["示例国家甲"].map((row) => row[0])).toEqual(["原文", "窗口内", "仍在窗口"]);
    expect(attachment["示例国家甲"].map((row) => row[11])).toEqual(["时段", "今日", "今日"]);
    expect(JSON.stringify(attachment)).not.toContain("上一窗口");

    const newYork = readWorkbookSheets(buildMonitorWorkbook({
      ...input,
      records: records.filter((item) => item.originalText !== "上一窗口"),
      timeZone: "America/New_York",
      periodSheets: false,
    }));
    expect(Object.keys(newYork)).toEqual(["示例国家甲", "示例国家乙"]);
    expect(newYork["示例国家甲"][0][1]).toBe("发布时间（America/New_York, UTC-4）");
    expect(newYork["示例国家甲"].map((row) => row[11])).toEqual(["时段", "今日", "更早"]);
  });
});
