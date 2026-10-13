import { Hono } from "hono";
import { assertAllowedEmail, authenticate } from "../auth/access";
import { EDITABLE_SETTINGS, SETTING_DEFAULTS, loadSettings, saveSettings, validateSettingsPatch } from "../config/settings";
import { authorBlockKey, DELIVERABLE_SQL } from "../domain/gate";
import { closedWindow, decideSchedule } from "../domain/time";
import { TARGET_KINDS, type TargetKind } from "../domain/types";
import { parseCsv, parseXlsx } from "../import/table";
import { storeExcel } from "../pipeline/run";
import { startManualRun } from "../schedule";

const EXCEL_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type AppVars = { email: string };

function jsonError(error: unknown, status: 400 | 403 | 500 = 400): Response {
  const message = error instanceof Error ? error.message : "请求失败";
  return Response.json({ error: message }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const payload = await request.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return payload as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

async function loadRateLimit(db: D1Database, now: Date, xQps: number) {
  const empty = {
    xQps,
    hits24h: 0,
    hits7d: 0,
    lastHitAt: null as string | null,
    lastRetryAfterSeconds: null as number | null,
    recent: [] as Array<{
      id: string;
      source: string;
      status: number;
      retryAfterSeconds: number | null;
      delaySeconds: number;
      recordedAt: string;
    }>,
  };
  try {
    const since24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [day, week, recent] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE source = 'x' AND recorded_at >= ?").bind(since24).first<{ n: number }>(),
      db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE source = 'x' AND recorded_at >= ?").bind(since7).first<{ n: number }>(),
      db.prepare(
        `SELECT id, source, status, retry_after_seconds, delay_seconds, recorded_at
         FROM rate_events WHERE source = 'x' ORDER BY recorded_at DESC LIMIT 8`,
      ).all<{
        id: string;
        source: string;
        status: number;
        retry_after_seconds: number | null;
        delay_seconds: number;
        recorded_at: string;
      }>(),
    ]);
    const last = recent.results[0];
    return {
      xQps,
      hits24h: Number(day?.n ?? 0),
      hits7d: Number(week?.n ?? 0),
      lastHitAt: last?.recorded_at ?? null,
      lastRetryAfterSeconds: last?.retry_after_seconds ?? null,
      recent: recent.results.map((row) => ({
        id: row.id,
        source: row.source,
        status: row.status,
        retryAfterSeconds: row.retry_after_seconds,
        delaySeconds: row.delay_seconds,
        recordedAt: row.recorded_at,
      })),
    };
  } catch {
    return empty;
  }
}

export function createApp(): Hono<{ Bindings: Env; Variables: AppVars }> {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

  app.use("/api/*", async (c, next) => {
    try {
      const email = await authenticate(c.req.raw, c.env, c.executionCtx as ExecutionContext);
      await assertAllowedEmail(c.env, email);
      c.set("email", email);
    } catch (error) {
      return jsonError(error, 403);
    }
    await next();
  });

  app.get("/api/status", async (c) => {
    const settings = await loadSettings(c.env.DB);
    const now = new Date();
    const decision = decideSchedule(now, {
      timeZone: settings.timeZone,
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
    });
    const schedule = {
      timeZone: settings.timeZone,
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
    };
    const today = closedWindow(now, schedule, 0);
    const yesterday = closedWindow(now, schedule, 1);
    const [countries, totals, todayCounts, yesterdayCounts, runs, failed, usage] = await Promise.all([
      c.env.DB.prepare("SELECT id, name, code, enabled FROM countries ORDER BY name").all(),
      c.env.DB.prepare(`SELECT country_id, COUNT(*) AS n FROM records WHERE ${DELIVERABLE_SQL} GROUP BY country_id`).all<{ country_id: string; n: number }>(),
      c.env.DB.prepare(`SELECT country_id, COUNT(*) AS n FROM records WHERE ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ? GROUP BY country_id`)
        .bind(today.start.toISOString(), today.end.toISOString()).all<{ country_id: string; n: number }>(),
      c.env.DB.prepare(`SELECT country_id, COUNT(*) AS n FROM records WHERE ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ? GROUP BY country_id`)
        .bind(yesterday.start.toISOString(), yesterday.end.toISOString()).all<{ country_id: string; n: number }>(),
      c.env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 12").all(),
      c.env.DB.prepare(
        `SELECT b.id, b.run_id, b.source, b.error, b.finished_at, c.name AS country_name
         FROM batches b JOIN countries c ON c.id = b.country_id
         WHERE b.status = 'failed' ORDER BY b.finished_at DESC LIMIT 20`,
      ).all(),
      c.env.DB.prepare(
        `SELECT source, SUM(calls) AS calls, SUM(items) AS items
         FROM api_usage WHERE recorded_at >= ? GROUP BY source`,
      ).bind(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()).all(),
    ]);
    const rateLimit = await loadRateLimit(c.env.DB, now, settings.xQps);
    const countMap = (rows: { country_id: string; n: number }[]) => new Map(rows.map((row) => [row.country_id, row.n]));
    const totalMap = countMap(totals.results);
    const todayMap = countMap(todayCounts.results);
    const yesterdayMap = countMap(yesterdayCounts.results);
    const latestBatches = await c.env.DB.prepare(
      "SELECT source, status, error, created_at FROM batches ORDER BY created_at DESC LIMIT 30",
    ).all<{ source: string; status: string; error: string | null; created_at: string }>();
    const health = new Map<string, { status: string; error: string | null }>();
    for (const batch of latestBatches.results) {
      if (!health.has(batch.source)) health.set(batch.source, { status: batch.status, error: batch.error });
    }
    return c.json({
      now: now.toISOString(),
      email: c.get("email"),
      timezone: settings.timeZone,
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
      batchSize: settings.batchSize,
      nextRun: decision.nextRun.toISOString(),
      lastSlot: decision.slotKey,
      countries: countries.results.map((country) => {
        const row = country as { id: string; name: string; code: string; enabled: number };
        return {
          ...row,
          enabled: row.enabled === 1,
          total: totalMap.get(row.id) ?? 0,
          today: todayMap.get(row.id) ?? 0,
          yesterday: yesterdayMap.get(row.id) ?? 0,
        };
      }),
      runs: runs.results,
      failedBatches: failed.results,
      apiUsage: usage.results,
      rateLimit,
      sources: {
        x: {
          label: "X / twitterapi.io",
          enabled: settings.sources.x,
          configured: Boolean(c.env.TWITTERAPI_IO_KEY),
          healthy: health.get("x")?.status !== "failed",
          lastError: health.get("x")?.error ?? null,
        },
        google_news: {
          label: "Google News RSS",
          enabled: settings.sources.google_news,
          configured: true,
          healthy: health.get("google_news")?.status !== "failed",
          lastError: health.get("google_news")?.error ?? null,
        },
        gdelt: {
          label: "GDELT",
          enabled: settings.sources.gdelt,
          configured: true,
          healthy: health.get("gdelt")?.status !== "failed",
          lastError: health.get("gdelt")?.error ?? null,
        },
      },
      delivery: {
        emailEnabled: settings.emailEnabled,
        provider: settings.emailProvider,
        resendConfigured: Boolean(c.env.RESEND_API_KEY),
        cloudflareConfigured: true,
        fromConfigured: Boolean(settings.emailFrom),
        translationEnabled: settings.translationEnabled,
        accessConfigured: Boolean(c.env.TEAM_DOMAIN && c.env.POLICY_AUD),
      },
    });
  });

  app.get("/api/countries", async (c) => {
    const rows = await c.env.DB.prepare("SELECT id, name, code, enabled, created_at FROM countries ORDER BY name").all();
    return c.json({ countries: rows.results });
  });

  app.post("/api/countries", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const name = requireString(body.name, "名称");
      const code = requireString(body.code, "代码").toLowerCase();
      if (!/^[a-z0-9-]{2,32}$/.test(code)) throw new Error("代码只能包含小写字母、数字和连字符");
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO countries (id, name, code, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
      ).bind(id, name, code, new Date().toISOString()).run();
      return c.json({ id }, 201);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.patch("/api/countries/:id", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const current = await c.env.DB.prepare("SELECT id FROM countries WHERE id = ?").bind(c.req.param("id")).first();
      if (!current) return c.json({ error: "国家不存在" }, 404);
      if (typeof body.name === "string" && body.name.trim()) {
        await c.env.DB.prepare("UPDATE countries SET name = ? WHERE id = ?").bind(body.name.trim(), c.req.param("id")).run();
      }
      if (typeof body.enabled === "boolean") {
        await c.env.DB.prepare("UPDATE countries SET enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, c.req.param("id")).run();
      }
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/countries/:id", async (c) => {
    const id = c.req.param("id");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM targets WHERE country_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM countries WHERE id = ?").bind(id),
    ]);
    return c.json({ ok: true });
  });

  app.get("/api/targets", async (c) => {
    const countryId = c.req.query("countryId");
    const statement = countryId
      ? c.env.DB.prepare("SELECT * FROM targets WHERE country_id = ? ORDER BY name").bind(countryId)
      : c.env.DB.prepare("SELECT * FROM targets ORDER BY name");
    const rows = await statement.all();
    return c.json({ targets: rows.results });
  });

  app.post("/api/targets", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const countryId = requireString(body.countryId, "国家");
      const name = requireString(body.name, "名称");
      const query = requireString(body.query ?? body.name, "检索词");
      const kind = requireString(body.kind, "类型") as TargetKind;
      if (!TARGET_KINDS.includes(kind)) throw new Error("类型无效");
      const country = await c.env.DB.prepare("SELECT id FROM countries WHERE id = ?").bind(countryId).first();
      if (!country) throw new Error("国家不存在");
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO targets (id, country_id, kind, name, query, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, countryId, kind, name, query, body.enabled === false ? 0 : 1, new Date().toISOString()).run();
      return c.json({ id }, 201);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.patch("/api/targets/:id", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const id = c.req.param("id");
      const current = await c.env.DB.prepare("SELECT id FROM targets WHERE id = ?").bind(id).first();
      if (!current) return c.json({ error: "目标不存在" }, 404);
      if (typeof body.name === "string") {
        await c.env.DB.prepare("UPDATE targets SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
      }
      if (typeof body.query === "string") {
        await c.env.DB.prepare("UPDATE targets SET query = ? WHERE id = ?").bind(body.query.trim(), id).run();
      }
      if (typeof body.kind === "string") {
        if (!TARGET_KINDS.includes(body.kind as TargetKind)) throw new Error("类型无效");
        await c.env.DB.prepare("UPDATE targets SET kind = ? WHERE id = ?").bind(body.kind, id).run();
      }
      if (typeof body.enabled === "boolean") {
        await c.env.DB.prepare("UPDATE targets SET enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, id).run();
      }
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/targets/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  app.post("/api/targets/import", async (c) => {
    try {
      const form = await c.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("请上传 file 字段");
      if (file.size > 2_000_000) throw new Error("文件不能超过 2MB");
      const name = file.name.toLowerCase();
      const rows = name.endsWith(".csv")
        ? parseCsv(await file.text())
        : parseXlsx(new Uint8Array(await file.arrayBuffer()));
      if (rows.length === 0) throw new Error("文件里没有数据行");
      if (rows.length > 5000) throw new Error("一次最多导入 5000 行");
      const countries = await c.env.DB.prepare("SELECT id, code FROM countries").all<{ id: string; code: string }>();
      const byCode = new Map(countries.results.map((country) => [country.code, country.id]));
      const statements: D1PreparedStatement[] = [];
      const now = new Date().toISOString();
      for (const row of rows) {
        const countryId = byCode.get(row.countryCode);
        if (!countryId) throw new Error(`未知国家代码 ${row.countryCode}，请先创建国家`);
        statements.push(c.env.DB.prepare(
          "INSERT INTO targets (id, country_id, kind, name, query, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), countryId, row.kind, row.name, row.query, row.enabled ? 1 : 0, now));
      }
      for (let index = 0; index < statements.length; index += 40) {
        await c.env.DB.batch(statements.slice(index, index + 40));
      }
      return c.json({ imported: rows.length });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/recipients", async (c) => {
    const rows = await c.env.DB.prepare("SELECT id, email, enabled, created_at FROM recipients ORDER BY email").all();
    return c.json({ recipients: rows.results });
  });

  app.post("/api/recipients", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const email = requireString(body.email, "邮箱").toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)",
      ).bind(id, email, new Date().toISOString()).run();
      return c.json({ id }, 201);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.patch("/api/recipients/:id", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      if (typeof body.enabled !== "boolean") throw new Error("缺少 enabled");
      await c.env.DB.prepare("UPDATE recipients SET enabled = ? WHERE id = ?")
        .bind(body.enabled ? 1 : 0, c.req.param("id")).run();
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/recipients/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM recipients WHERE id = ?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  app.get("/api/settings", async (c) => {
    const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    const values: Record<string, string> = { ...SETTING_DEFAULTS };
    for (const key of EDITABLE_SETTINGS) {
      if (values[key] === undefined) values[key] = "";
    }
    for (const row of rows.results) values[row.key] = row.value;
    return c.json({ settings: values });
  });

  app.put("/api/settings", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const patch = validateSettingsPatch(body);
      const settings = await saveSettings(c.env.DB, patch);
      return c.json({
        ok: true,
        scheduleHour: settings.scheduleHour,
        windowHours: settings.windowHours,
        batchSize: settings.batchSize,
      });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/records", async (c) => {
    const settings = await loadSettings(c.env.DB);
    const view = c.req.query("view") || "all";
    const countryId = c.req.query("countryId");
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 40)));
    const offset = Math.max(0, Number(c.req.query("offset") || 0));
    const clauses = ["1 = 1"];
    const binds: string[] = [];
    if (countryId) {
      clauses.push("country_id = ?");
      binds.push(countryId);
    }
    if (view === "today" || view === "yesterday") {
      const bounds = closedWindow(new Date(), {
        timeZone: settings.timeZone,
        scheduleHour: settings.scheduleHour,
        windowHours: settings.windowHours,
      }, view === "today" ? 0 : 1);
      clauses.push(DELIVERABLE_SQL);
      clauses.push("published_at >= ? AND published_at < ?");
      binds.push(bounds.start.toISOString(), bounds.end.toISOString());
    }
    const where = clauses.join(" AND ");
    const rows = await c.env.DB.prepare(
      `SELECT id, source, url, country_name, matched_target, author_handle, author_name, author_url,
              original_text, published_at, collected_at, translation_zh, relevance_score,
              exclude_reason, is_spam, time_status
       FROM records WHERE ${where} ORDER BY COALESCE(published_at, collected_at) DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset).all();
    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where}`)
      .bind(...binds).first<{ n: number }>();
    return c.json({ records: rows.results, total: total?.n ?? 0 });
  });

  app.post("/api/records/:id/spam", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const id = c.req.param("id");
      const row = await c.env.DB.prepare(
        "SELECT id, author_handle, author_url, url FROM records WHERE id = ?",
      ).bind(id).first<{ id: string; author_handle: string; author_url: string; url: string }>();
      if (!row) return c.json({ error: "记录不存在" }, 404);
      await c.env.DB.prepare(
        "UPDATE records SET is_spam = 1, exclude_reason = 'spam' WHERE id = ?",
      ).bind(id).run();
      let blocked: string | null = null;
      if (body.blockAuthor === true) {
        blocked = authorBlockKey({
          authorHandle: row.author_handle,
          authorUrl: row.author_url,
          url: row.url,
        });
        if (!blocked) throw new Error("没有可屏蔽的作者");
        const settings = await loadSettings(c.env.DB);
        if (!settings.blockedAccounts.includes(blocked)) {
          await saveSettings(c.env.DB, {
            blocked_accounts: [...settings.blockedAccounts, blocked].join(","),
          });
        }
      }
      return c.json({ ok: true, blocked });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/export/excel", async (c) => {
    const settings = await loadSettings(c.env.DB);
    const object = await c.env.EXPORTS.get(settings.excelKey || c.env.EXCEL_FILENAME);
    if (!object) return c.json({ error: "还没有生成 Excel，请先运行一次或点击重新生成" }, 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": EXCEL_TYPE,
        "Content-Disposition": `attachment; filename="${settings.excelKey || "skyeyes.xlsx"}"`,
      },
    });
  });

  app.post("/api/export/excel", async (c) => {
    try {
      const settings = await loadSettings(c.env.DB);
      const stored = await storeExcel(c.env, settings);
      return c.json({ ok: true, key: stored.key, bytes: stored.bytes.byteLength, truncated: stored.truncated });
    } catch (error) {
      return jsonError(error, 500);
    }
  });

  app.post("/api/runs", async (c) => {
    try {
      const started = await startManualRun(c.env);
      return c.json(started, 202);
    } catch (error) {
      return jsonError(error, 500);
    }
  });

  app.get("/api/runs", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 30").all();
    return c.json({ runs: rows.results });
  });

  app.get("/api/runs/:id", async (c) => {
    const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(c.req.param("id")).first();
    if (!run) return c.json({ error: "运行不存在" }, 404);
    const batches = await c.env.DB.prepare(
      `SELECT b.*, c.name AS country_name FROM batches b
       JOIN countries c ON c.id = b.country_id WHERE b.run_id = ? ORDER BY b.batch_index`,
    ).bind(c.req.param("id")).all();
    return c.json({ run, batches: batches.results });
  });

  app.all("/api/*", (c) => c.json({ error: "接口不存在" }, 404));
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
