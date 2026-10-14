export const MAX_BULK_DELETE = 100;

export function parseDeleteIds(value: unknown, action = "删除"): string[] {
  if (!Array.isArray(value)) throw new Error("ids 必须是数组");
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) throw new Error("ids 里的每一项都必须是记录 id");
    const id = item.trim();
    if (id.length > 80) throw new Error("记录 id 无效");
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length === 0) throw new Error(`请选择要${action}的记录`);
  if (unique.length > MAX_BULK_DELETE) throw new Error(`一次最多删除 ${MAX_BULK_DELETE} 条`);
  return unique;
}

/** 把记录标成已删除，保留 dedupe_key。返回实际隐藏的行数。 */
export async function hideRecords(db: D1Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const marks = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `UPDATE records SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (${marks})`,
  ).bind(new Date().toISOString(), ...ids).run();
  return result.meta.changes ?? 0;
}

/** 按列表同一套 WHERE 软删除。调用方必须已经包含 deleted_at IS NULL。 */
export async function hideRecordsMatching(
  db: D1Database,
  where: string,
  binds: Array<string | number>,
): Promise<number> {
  if (!where.includes("deleted_at IS NULL")) throw new Error("筛选条件无效");
  const result = await db.prepare(
    `UPDATE records SET deleted_at = ? WHERE ${where}`,
  ).bind(new Date().toISOString(), ...binds).run();
  return result.meta.changes ?? 0;
}
