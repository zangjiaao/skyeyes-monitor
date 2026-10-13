export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // 非 JSON 错误页保持状态码说明。
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export function formatTime(value: string | null | undefined, timeZone: string): string {
  if (!value || !timeZone) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    const map: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date)) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    const hour = map.hour === "24" ? "00" : map.hour;
    return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}`;
  } catch {
    return "—";
  }
}

export function timeHeader(title: string, timeZone: string, utcOffset: string): string {
  if (!timeZone) return title;
  return utcOffset ? `${title}（${timeZone}, ${utcOffset}）` : `${title}（${timeZone}）`;
}
