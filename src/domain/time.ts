export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ScheduleConfig {
  timeZone: string;
  scheduleHour: number;
  windowHours: number;
}

export interface WindowDecision {
  due: boolean;
  slotKey: string;
  start: Date;
  end: Date;
  nextRun: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const desiredUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let utc = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const zoned = getZonedParts(new Date(utc), timeZone);
    const asUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
    );
    const diff = desiredUtc - asUtc;
    if (diff === 0) break;
    utc += diff;
  }
  return new Date(utc);
}

export function calendarKey(date: Date, timeZone: string): string {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function shiftCalendarKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function atScheduleHour(key: string, config: ScheduleConfig): Date {
  const [year, month, day] = key.split("-").map(Number);
  return zonedTimeToUtc(
    { year, month, day, hour: config.scheduleHour, minute: 0, second: 0 },
    config.timeZone,
  );
}

export function latestScheduleInstant(now: Date, config: ScheduleConfig): Date {
  const zoned = getZonedParts(now, config.timeZone);
  const todayKey = `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`;
  let end = atScheduleHour(todayKey, config);
  if (end.getTime() > now.getTime()) {
    end = atScheduleHour(shiftCalendarKey(todayKey, -1), config);
  }
  return end;
}

export function nextScheduleInstant(now: Date, config: ScheduleConfig): Date {
  const zoned = getZonedParts(now, config.timeZone);
  const todayKey = `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`;
  let next = atScheduleHour(todayKey, config);
  if (next.getTime() <= now.getTime()) {
    next = atScheduleHour(shiftCalendarKey(todayKey, 1), config);
  }
  return next;
}

export function decideSchedule(now: Date, config: ScheduleConfig): WindowDecision {
  const zoned = getZonedParts(now, config.timeZone);
  const end = latestScheduleInstant(now, config);
  const start = new Date(end.getTime() - config.windowHours * 60 * 60 * 1000);
  const endParts = getZonedParts(end, config.timeZone);
  return {
    due: zoned.hour === config.scheduleHour,
    slotKey: `${endParts.year}-${pad(endParts.month)}-${pad(endParts.day)}T${pad(endParts.hour)}`,
    start,
    end,
    nextRun: nextScheduleInstant(now, config),
  };
}

export function rollingWindow(now: Date, windowHours: number): TimeRange {
  return {
    start: new Date(now.getTime() - windowHours * 60 * 60 * 1000),
    end: now,
  };
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export function dayBounds(reference: Date, timeZone: string, dayOffset: number): TimeRange {
  const key = shiftCalendarKey(calendarKey(reference, timeZone), dayOffset);
  const [year, month, day] = key.split("-").map(Number);
  const start = zonedTimeToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  const nextKey = shiftCalendarKey(key, 1);
  const [ny, nm, nd] = nextKey.split("-").map(Number);
  const end = zonedTimeToUtc(
    { year: ny, month: nm, day: nd, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return { start, end };
}

export function closedWindow(reference: Date, config: ScheduleConfig, shiftsBack: number): TimeRange {
  const latest = latestScheduleInstant(reference, config);
  const length = config.windowHours * 60 * 60 * 1000;
  const end = new Date(latest.getTime() - shiftsBack * length);
  return { start: new Date(end.getTime() - length), end };
}

export type PeriodLabel = "今日" | "昨日" | "更早";

export function publishPeriod(iso: string, reference: Date, config: ScheduleConfig): PeriodLabel {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "更早";
  const today = closedWindow(reference, config, 0);
  if (parsed >= today.start && parsed < today.end) return "今日";
  const yesterday = closedWindow(reference, config, 1);
  if (parsed >= yesterday.start && parsed < yesterday.end) return "昨日";
  return "更早";
}

export function periodLabel(iso: string, reference: Date, timeZone: string): PeriodLabel {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "更早";
  const day = calendarKey(parsed, timeZone);
  const today = calendarKey(reference, timeZone);
  if (day === today) return "今日";
  if (day === shiftCalendarKey(today, -1)) return "昨日";
  return "更早";
}

export function formatInZone(date: Date, timeZone: string): string {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function utcOffsetLabel(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const normalized = name.replace("\u2212", "-").replace(/\u00a0/g, "").trim();
  const match = normalized.match(/^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/);
  if (!match) return normalized.replace(/^GMT/, "UTC");
  if (!match[1]) return "UTC";
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  if (hours === 0 && minutes === 0) return "UTC";
  const minuteText = minutes === 0 ? "" : `:${pad(minutes)}`;
  return `UTC${match[1]}${hours}${minuteText}`;
}

export function timeColumnLabel(title: string, timeZone: string, date: Date): string {
  return `${title}（${timeZone}, ${utcOffsetLabel(date, timeZone)}）`;
}

export function zonedWallClock(iso: string, timeZone: string): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = getZonedParts(parsed, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

export function formatDayUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatGdelt(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}
