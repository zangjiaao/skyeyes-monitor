/** Asia/Shanghai is UTC+8 and does not observe daylight saving time. */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TimeWindow {
  /** Inclusive start, yesterday 10:00 Asia/Shanghai by default. */
  start: Date;
  /** Exclusive end, the latest 10:00 Asia/Shanghai at or before `now`. */
  end: Date;
  /** Beijing calendar date of `end`. This is the collected-date label. */
  collectedDate: string;
  /** Beijing calendar date of `start`. */
  yesterdayDate: string;
}

/**
 * Daily collection window: [previous cutoff, latest cutoff) in Asia/Shanghai.
 * A run at 10:00 Beijing time covers yesterday 10:00 through today 10:00.
 * A manual run later the same day keeps that same window; it does not extend to "now".
 */
export function collectionWindow(now: Date, hour = 10): TimeWindow {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("hour must be an integer from 0 through 23");
  }
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const endOfBeijingDay = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour,
    0,
    0,
    0,
  );
  let endMs = endOfBeijingDay - SHANGHAI_OFFSET_MS;
  if (now.getTime() < endMs) {
    endMs -= DAY_MS;
  }
  const startMs = endMs - DAY_MS;
  return {
    start: new Date(startMs),
    end: new Date(endMs),
    collectedDate: formatShanghaiDate(new Date(endMs)),
    yesterdayDate: formatShanghaiDate(new Date(startMs)),
  };
}

export function formatShanghaiDate(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD HH:mm` in Asia/Shanghai. */
export function formatInShanghai(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${formatShanghaiDate(date)} ${hours}:${minutes}`;
}

export function shanghaiDateOffset(date: Date, days: number): string {
  return formatShanghaiDate(new Date(date.getTime() + days * DAY_MS));
}
