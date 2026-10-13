import { titlePrefix, type ExistingIdentity } from "../domain/gate";
import { logError } from "../log";

const SIMILAR_SQL = `SELECT url_key, title_key, published_at FROM records
     WHERE url_key = ?
        OR title_key = ?
        OR (? <> '' AND title_prefix = ?)
     LIMIT 40`;

interface SimilarRow {
  url_key: string;
  title_key: string;
  published_at: string | null;
}

function identities(rows: SimilarRow[]): ExistingIdentity[] {
  return rows.map((row) => ({
    urlKey: row.url_key,
    titleKey: row.title_key,
    publishedAt: row.published_at,
  }));
}

/** 用等值比对标题前缀。不要把标题放进 LIKE：D1 的 LIKE 模式最长 50 字节，中文或印地语前缀会超过。 */
export function similarLookup(urlKey: string, titleKey: string): { sql: string; binds: string[] } {
  const prefix = titlePrefix(titleKey);
  return {
    sql: SIMILAR_SQL,
    binds: [urlKey, titleKey, prefix, prefix],
  };
}

async function selectSimilar(db: D1Database, urlKey: string, titleKey: string): Promise<ExistingIdentity[]> {
  const query = similarLookup(urlKey, titleKey);
  const rows = await db.prepare(query.sql).bind(...query.binds).all<SimilarRow>();
  return identities(rows.results);
}

async function selectByUrl(db: D1Database, urlKey: string): Promise<ExistingIdentity[]> {
  if (!urlKey) return [];
  const rows = await db.prepare(
    "SELECT url_key, title_key, published_at FROM records WHERE url_key = ? LIMIT 40",
  ).bind(urlKey).all<SimilarRow>();
  return identities(rows.results);
}

/**
 * 查找同一链接或标题几乎相同的旧记录。查询失败时记一条警告并退回只按链接比对；
 * 链接查询也失败则返回空列表，调用方仍然入库。
 */
export async function findSimilarRecords(
  db: D1Database,
  urlKey: string,
  titleKey: string,
): Promise<ExistingIdentity[]> {
  try {
    return await selectSimilar(db, urlKey, titleKey);
  } catch (error) {
    logError("dedupe lookup failed", error, { url: urlKey.slice(0, 180) });
    try {
      return await selectByUrl(db, urlKey);
    } catch (urlError) {
      logError("url dedupe lookup failed", urlError, { url: urlKey.slice(0, 180) });
      return [];
    }
  }
}
