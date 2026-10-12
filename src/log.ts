export function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
