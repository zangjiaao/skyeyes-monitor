export function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ message, ...fields }));
}

export function logError(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    message,
    error: error instanceof Error ? error.message : String(error),
    ...fields,
  }));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
