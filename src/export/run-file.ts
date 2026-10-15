import { calendarKey } from "../domain/time";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/** 一次运行一份对象，同一天的手动运行和定时运行不会互相覆盖。 */
export function runWindowObjectKey(runId: string): string {
  return `runs/${runId}.xlsx`;
}

/** 附件和下载时给人看的文件名，按窗口结束时刻在配置时区的日历日。 */
export function runWindowFilename(excelKey: string, windowEndIso: string, timeZone: string): string {
  const baseName = (excelKey.split("/").pop() || "skyeyes.xlsx").replace(/["\r\n]/g, "");
  const stem = baseName.replace(/\.xlsx$/i, "") || "skyeyes";
  const end = new Date(windowEndIso);
  const day = Number.isNaN(end.getTime()) ? "undated" : calendarKey(end, timeZone);
  return `${stem}-${day}.xlsx`;
}

export function runWindowDownloadPath(runId: string): string {
  return `/api/export/excel?run=${encodeURIComponent(runId)}`;
}
