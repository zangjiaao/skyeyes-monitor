export const DELIVERY_MODES = ["email", "none"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export function parseDeliveryMode(value: unknown): DeliveryMode {
  if (value === "email" || value === "none") return value;
  throw new Error("推送方式无效");
}

export interface EmailGroup {
  id: string;
  name: string;
  emails: string[];
}

/** 收件人相同的分组合并成一封；每个人只收到自己被选中的分组。 */
export interface EmailBucket {
  emails: string[];
  groupIds: string[];
  names: string[];
}

export function emailBuckets(groups: EmailGroup[]): EmailBucket[] {
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const groupsByEmail = new Map<string, string[]>();
  for (const group of groups) {
    const emails = [...new Set(group.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
    for (const email of emails) {
      const ids = groupsByEmail.get(email) ?? [];
      ids.push(group.id);
      groupsByEmail.set(email, ids);
    }
  }

  const buckets = new Map<string, EmailBucket>();
  for (const [email, groupIds] of groupsByEmail) {
    const uniqueIds = [...new Set(groupIds)].sort();
    const key = uniqueIds.join("\0");
    const bucket = buckets.get(key) ?? {
      emails: [],
      groupIds: uniqueIds,
      names: uniqueIds.map((id) => names.get(id) ?? id),
    };
    bucket.emails.push(email);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, emails: [...bucket.emails].sort() }))
    .sort((left, right) => left.emails[0].localeCompare(right.emails[0]) || left.names[0].localeCompare(right.names[0], "zh"));
}

export function scopeLabel(names: string[]): string {
  const joined = names.join("、");
  return joined.length <= 80 ? joined : `${joined.slice(0, 80)}…`;
}
