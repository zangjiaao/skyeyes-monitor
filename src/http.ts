import { isAuthorized } from "./auth";
import { readConfig } from "./config";
import {
  countTargetsForCountry,
  deleteCountry,
  deleteRecipient,
  deleteTarget,
  findRecipient,
  findTargetByQuery,
  getCountryByCode,
  getLatestRun,
  getRun,
  insertCountry,
  insertRecipient,
  insertTarget,
  listBatches,
  listCountries,
  listRecipients,
  listTargets,
  reopenRun,
  type BatchRow,
  type RunRow,
} from "./db";
import { verifyDownloadSignature } from "./download";
import { HttpError } from "./errors";
import { finalizeRun, requeueRun, startRun } from "./pipeline";

const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const KINDS = new Set(["person", "organization", "keyword"]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 65_536) throw new HttpError(413, "请求体过大");
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "无效 JSON");
  }
}

function requiredString(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError(400, `${key} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) throw new HttpError(400, `${key} 长度无效`);
  return trimmed;
}

function positiveId(pathname: string, prefix: string): number {
  const rest = pathname.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(rest)) throw new HttpError(400, "无效的 id");
  const id = Number(rest);
  if (!Number.isSafeInteger(id)) throw new HttpError(400, "无效的 id");
  return id;
}

function runJson(run: RunRow, batches?: BatchRow[]) {
  return {
    id: run.id,
    collectedDate: run.collected_date,
    windowStart: run.window_start,
    windowEnd: run.window_end,
    status: run.status,
    expectedBatches: run.expected_batches,
    completedBatches: run.completed_batches,
    failedBatches: run.failed_batches,
    note: run.note,
    createdAt: run.created_at,
    finalizedAt: run.finalized_at,
    batches: batches?.map((batch) => ({
      id: batch.id,
      source: batch.source,
      providerId: batch.provider_id,
      status: batch.status,
      attempts: batch.attempts,
      error: batch.error,
      targetCount: (() => {
        try {
          const parsed = JSON.parse(batch.target_ids) as unknown;
          return Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          return 0;
        }
      })(),
    })),
  };
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await isAuthorized(request, env.ADMIN_TOKEN))) {
    return json({ error: "未授权" }, 401);
  }
  const path = normalizePath(url.pathname);
  const method = request.method.toUpperCase();

  if (path === "/admin/countries" && method === "GET") {
    const countries = await listCountries(env);
    return json({ countries });
  }
  if (path === "/admin/countries" && method === "POST") {
    const body = await readJson(request);
    const code = requiredString(body, "code", 32).toLowerCase();
    const name = requiredString(body, "name", 120);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(code)) throw new HttpError(400, "国家代码只能包含小写字母、数字和连字符");
    if (await getCountryByCode(env, code)) throw new HttpError(409, "国家代码已存在");
    const country = await insertCountry(env, code, name, new Date().toISOString());
    return json({ country }, 201);
  }
  if (path.startsWith("/admin/countries/") && method === "DELETE") {
    const id = positiveId(path, "/admin/countries/");
    const targets = await countTargetsForCountry(env, id);
    if (targets > 0) throw new HttpError(409, "请先删除该国家下的监测对象");
    const removed = await deleteCountry(env, id);
    if (!removed) throw new HttpError(404, "国家不存在");
    return json({ ok: true });
  }

  if (path === "/admin/targets" && method === "GET") {
    const country = url.searchParams.get("country") ?? undefined;
    const targets = await listTargets(env, country || undefined);
    return json({ targets });
  }
  if (path === "/admin/targets" && method === "POST") {
    const body = await readJson(request);
    const countryCode = requiredString(body, "countryCode", 32).toLowerCase();
    const kind = requiredString(body, "kind", 32);
    const name = requiredString(body, "name", 120);
    const query = requiredString(body, "query", 200);
    if (!KINDS.has(kind)) throw new HttpError(400, "kind 必须是 person、organization 或 keyword");
    const country = await getCountryByCode(env, countryCode);
    if (!country) throw new HttpError(404, "国家不存在");
    if (await findTargetByQuery(env, country.id, query)) throw new HttpError(409, "该国家下已有相同检索词");
    const target = await insertTarget(env, { countryId: country.id, kind, name, query }, new Date().toISOString());
    return json({ target }, 201);
  }
  if (path.startsWith("/admin/targets/") && method === "DELETE") {
    const id = positiveId(path, "/admin/targets/");
    const removed = await deleteTarget(env, id);
    if (!removed) throw new HttpError(404, "监测对象不存在");
    return json({ ok: true });
  }

  if (path === "/admin/recipients" && method === "GET") {
    return json({ recipients: await listRecipients(env) });
  }
  if (path === "/admin/recipients" && method === "POST") {
    const body = await readJson(request);
    const email = requiredString(body, "email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "邮箱格式无效");
    if (await findRecipient(env, email)) throw new HttpError(409, "收件人已存在");
    const recipient = await insertRecipient(env, email, new Date().toISOString());
    return json({ recipient }, 201);
  }
  if (path.startsWith("/admin/recipients/") && method === "DELETE") {
    const id = positiveId(path, "/admin/recipients/");
    const removed = await deleteRecipient(env, id);
    if (!removed) throw new HttpError(404, "收件人不存在");
    return json({ ok: true });
  }

  if (path === "/admin/trigger" && method === "POST") {
    const result = await startRun(env, { force: url.searchParams.get("force") === "1" });
    return json(result, result.skipped ? 200 : 202);
  }

  if (path === "/admin/runs/latest" && method === "GET") {
    const run = await getLatestRun(env);
    if (!run) throw new HttpError(404, "还没有运行记录");
    const batches = await listBatches(env, run.id);
    return json({ run: runJson(run, batches) });
  }

  if (path.startsWith("/admin/runs/") && path.endsWith("/finalize") && method === "POST") {
    const id = path.slice("/admin/runs/".length, -"/finalize".length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "无效的运行 id");
    if (url.searchParams.get("force") === "1") await reopenRun(env, id);
    const outcome = await finalizeRun(env, id);
    if (outcome === "missing") throw new HttpError(404, "运行记录不存在");
    if (outcome === "busy") throw new HttpError(409, "汇总正在进行");
    const run = await getRun(env, id);
    return json({ ok: true, run: run ? runJson(run) : null });
  }

  if (path.startsWith("/admin/runs/") && path.endsWith("/requeue") && method === "POST") {
    const id = path.slice("/admin/runs/".length, -"/requeue".length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "无效的运行 id");
    const run = await getRun(env, id);
    if (!run) throw new HttpError(404, "运行记录不存在");
    const requeued = await requeueRun(env, id);
    return json({ requeued });
  }

  if (path.startsWith("/admin/runs/") && method === "GET") {
    const id = path.slice("/admin/runs/".length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "无效的运行 id");
    const run = await getRun(env, id);
    if (!run) throw new HttpError(404, "运行记录不存在");
    return json({ run: runJson(run, await listBatches(env, id)) });
  }

  throw new HttpError(404, "未找到该管理接口");
}

async function handleDownload(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") throw new HttpError(405, "只允许 GET");
  const config = readConfig(env);
  const name = decodeURIComponent(url.pathname.slice("/download/".length));
  if (name !== config.excelObjectKey) throw new HttpError(404, "文件不存在");
  const exp = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") ?? "";
  const valid = await verifyDownloadSignature(env.ADMIN_TOKEN, config.excelObjectKey, exp, signature);
  if (!valid) return json({ error: "下载链接无效或已过期" }, 403);
  const object = await env.EXPORTS.get(config.excelObjectKey);
  if (!object) return json({ error: "文件尚未生成" }, 404);
  const headers = new Headers();
  headers.set("content-type", object.httpMetadata?.contentType || EXCEL_MIME);
  headers.set("content-disposition", `attachment; filename="${config.excelObjectKey}"`);
  headers.set("cache-control", "private, max-age=60");
  if (object.size) headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  try {
    if (path === "/health" && request.method.toUpperCase() === "GET") {
      return json({ ok: true, service: "skyeyes-monitor" });
    }
    if (path.startsWith("/admin")) return handleAdmin(request, env, url);
    if (path.startsWith("/download/")) return handleDownload(request, env, url);
    return json({ error: "未找到" }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ level: "error", message: "请求处理失败", error: error instanceof Error ? error.message : "unknown" }));
    return json({ error: "服务器错误" }, 500);
  }
}
