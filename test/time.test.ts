import { describe, expect, it } from "vitest";
import { decideSchedule, periodLabel } from "../src/domain/time";

describe("采集时间窗口", () => {
  it("上海时间 10:00 对应当天窗口，起点是前一天同一时刻", () => {
    const now = new Date("2026-10-12T02:00:00.000Z");
    const decision = decideSchedule(now, {
      timeZone: "Asia/Shanghai",
      scheduleHour: 10,
      windowHours: 24,
    });
    expect(decision.due).toBe(true);
    expect(decision.end.toISOString()).toBe("2026-10-12T02:00:00.000Z");
    expect(decision.start.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(decision.slotKey).toBe("2026-10-12T10");
    expect(decision.nextRun.toISOString()).toBe("2026-10-13T02:00:00.000Z");
  });

  it("还没到设定小时时不触发，窗口停在上一个计划时刻", () => {
    const now = new Date("2026-10-12T01:00:00.000Z");
    const decision = decideSchedule(now, {
      timeZone: "Asia/Shanghai",
      scheduleHour: 10,
      windowHours: 24,
    });
    expect(decision.due).toBe(false);
    expect(decision.end.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(decision.start.toISOString()).toBe("2026-10-10T02:00:00.000Z");
    expect(decision.nextRun.toISOString()).toBe("2026-10-12T02:00:00.000Z");
  });

  it("用目标时区而不是固定东八区", () => {
    const now = new Date("2026-06-15T14:00:00.000Z");
    const decision = decideSchedule(now, {
      timeZone: "America/New_York",
      scheduleHour: 10,
      windowHours: 24,
    });
    expect(decision.due).toBe(true);
    expect(decision.end.toISOString()).toBe("2026-06-15T14:00:00.000Z");
    expect(decision.slotKey).toBe("2026-06-15T10");
    expect(decision.start.toISOString()).toBe("2026-06-14T14:00:00.000Z");
  });

  it("按时区日历日标记今日和昨日", () => {
    const reference = new Date("2026-10-12T02:30:00.000Z");
    expect(periodLabel("2026-10-12T01:00:00.000Z", reference, "Asia/Shanghai")).toBe("今日");
    expect(periodLabel("2026-10-11T03:00:00.000Z", reference, "Asia/Shanghai")).toBe("昨日");
    expect(periodLabel("2026-10-09T03:00:00.000Z", reference, "Asia/Shanghai")).toBe("更早");
  });
});
