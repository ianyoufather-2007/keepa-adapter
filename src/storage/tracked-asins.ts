import type { DatabaseLike } from "./db.js";

export interface TrackedAsin {
  asin: string;
  domain: string;
  label: string | null;
  parent_asin_expected: string | null;
  priority: string;
  active: boolean;
  added_at: string;
}

export function addTrackedAsin(
  db: DatabaseLike,
  opts: {
    asin: string;
    domain?: string;
    label?: string;
    parentAsinExpected?: string;
    priority?: string;
  }
): void {
  db.prepare(`
    INSERT OR REPLACE INTO tracked_asins (asin, domain, label, parent_asin_expected, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    opts.asin,
    opts.domain ?? "com",
    opts.label ?? null,
    opts.parentAsinExpected ?? null,
    opts.priority ?? "standard"
  );
}

export function listTrackedAsins(
  db: DatabaseLike,
  opts?: { domain?: string; activeOnly?: boolean; priority?: string }
): TrackedAsin[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.domain) {
    conditions.push("domain = ?");
    params.push(opts.domain);
  }
  if (opts?.activeOnly !== false) {
    conditions.push("active = 1");
  }
  if (opts?.priority) {
    conditions.push("priority = ?");
    params.push(opts.priority);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const rows = db
    .prepare(`SELECT * FROM tracked_asins ${where} ORDER BY added_at`)
    .all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    asin: r.asin as string,
    domain: r.domain as string,
    label: (r.label as string) ?? null,
    parent_asin_expected: (r.parent_asin_expected as string) ?? null,
    priority: r.priority as string,
    active: (r.active as number) === 1,
    added_at: r.added_at as string,
  }));
}

export function removeTrackedAsin(
  db: DatabaseLike,
  asin: string,
  domain = "com"
): void {
  db.prepare(
    "UPDATE tracked_asins SET active = 0 WHERE asin = ? AND domain = ?"
  ).run(asin, domain);
}

export function setApprovedVariationValue(
  db: DatabaseLike,
  opts: {
    asin: string;
    domain?: string;
    attributeName: string;
    approvedValue: string;
  }
): void {
  db.prepare(`
    INSERT OR REPLACE INTO approved_variation_values (asin, domain, attribute_name, approved_value)
    VALUES (?, ?, ?, ?)
  `).run(opts.asin, opts.domain ?? "com", opts.attributeName, opts.approvedValue);
}

export function getApprovedVariationValues(
  db: DatabaseLike,
  asin: string,
  domain = "com"
): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT attribute_name, approved_value FROM approved_variation_values WHERE asin = ? AND domain = ?"
    )
    .all(asin, domain) as { attribute_name: string; approved_value: string }[];

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.attribute_name] = row.approved_value;
  }
  return result;
}
