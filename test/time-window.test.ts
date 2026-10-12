import { describe, expect, it } from "vitest";
import { collectionWindow, formatInShanghai } from "../src/time-window";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("collectionWindow", () => {
  it("uses yesterday 10:00 through today 10:00 Beijing time when the clock is exactly 10:00", () => {
    const now = new Date("2026-10-12T02:00:00.000Z");
    const window = collectionWindow(now);

    expect(window.end.toISOString()).toBe("2026-10-12T02:00:00.000Z");
    expect(window.start.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(window.end.getTime() - window.start.getTime()).toBe(DAY_MS);
    expect(window.collectedDate).toBe("2026-10-12");
    expect(window.yesterdayDate).toBe("2026-10-11");
    expect(formatInShanghai(window.end)).toBe("2026-10-12 10:00");
    expect(formatInShanghai(window.start)).toBe("2026-10-11 10:00");
  });

  it("steps back one cutoff when Beijing time is still before 10:00", () => {
    const window = collectionWindow(new Date("2026-10-12T01:59:00.000Z"));

    expect(window.end.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(window.start.toISOString()).toBe("2026-10-10T02:00:00.000Z");
    expect(window.collectedDate).toBe("2026-10-11");
    expect(window.yesterdayDate).toBe("2026-10-10");
  });

  it("keeps the morning window when triggered in the Beijing afternoon", () => {
    const window = collectionWindow(new Date("2026-10-12T07:30:00.000Z"));

    expect(window.end.toISOString()).toBe("2026-10-12T02:00:00.000Z");
    expect(window.start.toISOString()).toBe("2026-10-11T02:00:00.000Z");
    expect(window.collectedDate).toBe("2026-10-12");
  });

  it("crosses a month boundary using the Beijing calendar", () => {
    const window = collectionWindow(new Date("2026-03-01T01:30:00.000Z"));

    expect(window.end.toISOString()).toBe("2026-02-28T02:00:00.000Z");
    expect(window.start.toISOString()).toBe("2026-02-27T02:00:00.000Z");
    expect(window.collectedDate).toBe("2026-02-28");
    expect(window.yesterdayDate).toBe("2026-02-27");
    expect(formatInShanghai(window.end)).toBe("2026-02-28 10:00");
  });
});
