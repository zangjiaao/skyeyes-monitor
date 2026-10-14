import type { AppSettings } from "../config/settings";
import { DeferredBatchError } from "./lease";

/**
 * Workers 免费版每次调用最多 50 次外部子请求（fetch，重定向的每一跳都算）。
 * 2026-02-11 的限额说明把 Cloudflare 服务另算一档：免费版 1000 次。
 * D1、R2、KV、Queue 的绑定调用走这 1000 次，不占那 50 次，因此这里不计数。
 * Workers AI 的 ai.run 也是绑定调用，但一条 RSS 后面会跟多次翻译和评分，
 * 所以和 DeepSeek 的 fetch 一起计入本预算，避免一次队列消息把 50 次打满。
 *
 * @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
 * @see https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/
 */
export const SUBREQUEST_BUDGET_DEFAULT = 40;
export const SUBREQUEST_BUDGET_MIN = 6;
export const SUBREQUEST_BUDGET_MAX = 45;
export const SUBREQUEST_DEFER_SEC = 1;

const DEEPSEEK_ATTEMPTS = 3;
const TRANSLATION_MODEL_CALLS = 2;

export class SubrequestBudgetError extends DeferredBatchError {
  constructor() {
    super(SUBREQUEST_DEFER_SEC);
    this.name = "SubrequestBudgetError";
    this.message = "子请求预算已用尽，本批次稍后继续";
  }
}

export class SubrequestBudget {
  readonly limit: number;
  used = 0;

  constructor(limit: number) {
    const parsed = Number.isFinite(limit) ? Math.floor(limit) : SUBREQUEST_BUDGET_DEFAULT;
    this.limit = Math.min(SUBREQUEST_BUDGET_MAX, Math.max(SUBREQUEST_BUDGET_MIN, parsed));
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  tryCharge(cost = 1): boolean {
    if (cost <= 0) return true;
    if (this.used + cost > this.limit) return false;
    this.used += cost;
    return true;
  }

  charge(cost = 1): void {
    if (!this.tryCharge(cost)) throw new SubrequestBudgetError();
  }
}

/** DeepSeek 最多 3 次，机器翻译加备用模型最多 2 次。开始抓下一页或下一条之前要留得下这一整段。 */
export function interpretReservation(settings: AppSettings, hasDeepseekKey: boolean): number {
  const deepseek = settings.aiProvider === "deepseek" && settings.aiEnabled && hasDeepseekKey;
  if (deepseek) {
    return DEEPSEEK_ATTEMPTS + (settings.translationEnabled ? TRANSLATION_MODEL_CALLS : 0);
  }
  let cost = 0;
  if (settings.translationEnabled) cost += TRANSLATION_MODEL_CALLS;
  if (settings.relevanceEnabled) cost += 1;
  return cost;
}

/** 外部抓取占 1 次。后面还要解读时，剩不下完整的一条就不发起这次抓取。 */
export function beginSourceFetch(budget: SubrequestBudget, interpretReserve: number): void {
  const needed = 1 + Math.max(0, interpretReserve);
  if (budget.remaining < needed) throw new SubrequestBudgetError();
  budget.charge(1);
}
