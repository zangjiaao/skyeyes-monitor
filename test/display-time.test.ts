import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { formatInZone, timeColumnLabel, utcOffsetLabel, zonedWallClock } from "../src/domain/time";
import { buildDigest } from "../src/email/compose";
import { buildMonitorWorkbook, readWorkbookSheets, type ExcelRecord } from "../src/export/excel";

const SHANGHAI = "Asia/Shanghai";
const NEW_YORK = "America/New_York";

function record(partial: Partial<ExcelRecord> & Pick<ExcelRecord, "publishedAt" | "collectedAt" | "originalText">): ExcelRecord {
  return {
    countryName: "甲",
    authorHandle: "someone",
    authorName: "某人",
    authorUrl: "https://x.com/someone",
    source: "x",
    url: "https://x.com/someone/status/1",
    matchedTarget: "示例目标",
    translationZh: "译文",
    ...partial,
  };
}

describe("按时区显示", () => {
  it("上海时间在 10:00 窗口边界两侧各差一分钟", () => {
    expect(formatInZone(new Date("2026-10-13T01:59:00.000Z"), SHANGHAI)).toBe("2026-10-13 09:59");
    expect(formatInZone(new Date("2026-10-13T02:00:00.000Z"), SHANGHAI)).toBe("2026-10-13 10:00");
    expect(formatInZone(new Date("2026-10-13T02:01:00.000Z"), SHANGHAI)).toBe("2026-10-13 10:01");
    expect(formatInZone(new Date("2026-10-12T16:00:00.000Z"), SHANGHAI)).toBe("2026-10-13 00:00");
    expect(utcOffsetLabel(new Date("2026-10-13T02:00:00.000Z"), SHANGHAI)).toBe("UTC+8");
    expect(timeColumnLabel("发布时间", SHANGHAI, new Date("2026-10-13T02:00:00.000Z"))).toBe("发布时间（Asia/Shanghai, UTC+8）");
  });

  it("同一 UTC 时刻在纽约显示当地墙钟，而不是东八区", () => {
    const instant = new Date("2026-06-15T14:00:00.000Z");
    expect(formatInZone(new Date("2026-06-15T13:59:00.000Z"), NEW_YORK)).toBe("2026-06-15 09:59");
    expect(formatInZone(instant, NEW_YORK)).toBe("2026-06-15 10:00");
    expect(formatInZone(instant, SHANGHAI)).toBe("2026-06-15 22:00");
    expect(utcOffsetLabel(instant, NEW_YORK)).toBe("UTC-4");
    expect(utcOffsetLabel(new Date("2026-01-15T15:00:00.000Z"), NEW_YORK)).toBe("UTC-5");
    expect(timeColumnLabel("发布时间", NEW_YORK, instant)).toBe("发布时间（America/New_York, UTC-4）");
    expect(formatInZone(new Date("2026-10-13T02:00:00.000Z"), "Asia/Kolkata")).toBe("2026-10-13 07:30");
    expect(utcOffsetLabel(new Date("2026-10-13T02:00:00.000Z"), "Asia/Kolkata")).toBe("UTC+5:30");
  });

  it("Excel 用日期单元格写出墙钟，缺时间留空", () => {
    const reference = new Date("2026-10-13T02:30:00.000Z");
    const bytes = buildMonitorWorkbook({
      countries: [{ name: "甲" }],
      records: [
        record({
          publishedAt: "2026-10-13T01:59:00.000Z",
          collectedAt: "2026-10-13T02:00:00.000Z",
          originalText: "边界前",
        }),
        record({
          publishedAt: "",
          collectedAt: "2026-10-13T02:01:00.000Z",
          originalText: "缺发布时间",
        }),
      ],
      reference,
      timeZone: SHANGHAI,
      scheduleHour: 10,
      windowHours: 24,
    });
    const sheets = readWorkbookSheets(bytes);
    expect(sheets["甲"][0][1]).toBe("发布时间（Asia/Shanghai, UTC+8）");
    expect(sheets["甲"][0][9]).toBe("采集时间（Asia/Shanghai, UTC+8）");
    expect(sheets["甲"][1][1]).toBe("2026-10-13 09:59");
    expect(sheets["甲"][1][9]).toBe("2026-10-13 10:00");
    expect(sheets["甲"][2][1]).toBe("");
    expect(sheets["甲"][2][9]).toBe("2026-10-13 10:01");
    const workbook = XLSX.read(bytes, { type: "array", cellNF: true });
    const sheet = workbook.Sheets["甲"];
    expect(sheet?.B2?.t).toBe("n");
    expect(sheet?.B2?.z).toBe("yyyy-mm-dd hh:mm");
    expect(sheet?.J2?.t).toBe("n");
    expect(sheet?.J2?.z).toBe("yyyy-mm-dd hh:mm");
    expect(sheet?.B3?.t).not.toBe("n");
    expect(Buffer.from(bytes).includes("2026-10-13T01:59:00.000Z")).toBe(false);
    expect(zonedWallClock("", SHANGHAI)).toBeNull();
    expect(zonedWallClock("not-a-date", SHANGHAI)).toBeNull();
  });

  it("换一个时区后，同一条记录不会仍按东八区写入", () => {
    const bytes = buildMonitorWorkbook({
      countries: [{ name: "甲" }],
      records: [record({
        publishedAt: "2026-10-13T02:00:00.000Z",
        collectedAt: "2026-10-13T02:00:00.000Z",
        originalText: "纽约",
      })],
      reference: new Date("2026-10-13T02:00:00.000Z"),
      timeZone: NEW_YORK,
      scheduleHour: 10,
      windowHours: 24,
    });
    const sheets = readWorkbookSheets(bytes);
    expect(sheets["甲"][0][1]).toBe("发布时间（America/New_York, UTC-4）");
    expect(sheets["甲"][1][1]).toBe("2026-10-12 22:00");
    expect(sheets["甲"][1][1]).not.toBe("2026-10-13 10:00");
  });

  it("邮件主题用窗口结束时刻在配置时区的日历日", () => {
    const shanghai = buildDigest({
      incomplete: false,
      windowStart: "2026-10-12T16:00:00.000Z",
      windowEnd: "2026-10-13T02:00:00.000Z",
      timeZone: SHANGHAI,
      countries: [],
      failedBatches: 0,
      downloadUrl: null,
      attached: false,
      notes: "",
    });
    expect(shanghai.subject).toBe("SkyEyes 每日监测 2026-10-13");
    expect(shanghai.text).toContain("窗口: 2026-10-13 00:00 至 2026-10-13 10:00（Asia/Shanghai, UTC+8）");
    expect(shanghai.text).not.toContain("2026-10-12T16:00:00.000Z");
    expect(shanghai.text).not.toContain("2026-10-13T02:00:00.000Z");

    const newYork = buildDigest({
      incomplete: false,
      windowStart: "2026-10-12T02:00:00.000Z",
      windowEnd: "2026-10-13T02:00:00.000Z",
      timeZone: NEW_YORK,
      countries: [],
      failedBatches: 0,
      downloadUrl: null,
      attached: false,
      notes: "",
    });
    expect(newYork.subject).toBe("SkyEyes 每日监测 2026-10-12");
    expect(newYork.text).toContain("窗口: 2026-10-11 22:00 至 2026-10-12 22:00（America/New_York, UTC-4）");
    expect(newYork.text).not.toContain("2026-10-13 10:00");
    expect(newYork.text).not.toContain("2026-10-13T02:00:00.000Z");
  });
});
