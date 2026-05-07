import type { DatabaseLike } from "./db.js";
import type { ChangeEvent } from "../schema/universal.js";

export function insertChange(
  db: DatabaseLike,
  change: ChangeEvent
): number {
  const stmt = db.prepare(`
    INSERT INTO changes (asin, domain, field, old_value, new_value, severity, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    change.asin,
    change.domain,
    change.field,
    change.old_value,
    change.new_value,
    change.severity,
    change.detected_at
  );
  return result.lastInsertRowid as number;
}

export function getRecentChanges(
  db: DatabaseLike,
  opts?: {
    asins?: string[];
    domain?: string;
    days?: number;
    severity?: string;
  }
): ChangeEvent[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.domain) {
    conditions.push("domain = ?");
    params.push(opts.domain);
  }
  if (opts?.days) {
    conditions.push("detected_at >= datetime('now', '-' || ? || ' days')");
    params.push(opts.days);
  }
  if (opts?.severity) {
    conditions.push("severity = ?");
    params.push(opts.severity);
  }
  if (opts?.asins?.length) {
    conditions.push(
      `asin IN (${opts.asins.map(() => "?").join(",")})`
    );
    params.push(...opts.asins);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const rows = db
    .prepare(
      `SELECT asin, domain, field, old_value, new_value, severity, detected_at
       FROM changes ${where}
       ORDER BY detected_at DESC`
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    asin: r.asin as string,
    domain: r.domain as string,
    field: r.field as string,
    old_value: (r.old_value as string) ?? null,
    new_value: (r.new_value as string) ?? null,
    severity: r.severity as "critical" | "warning" | "info",
    detected_at: r.detected_at as string,
  }));
}

export function getUnacknowledgedChanges(
  db: DatabaseLike,
  opts?: { domain?: string }
): ChangeEvent[] {
  const conditions = ["acknowledged = 0"];
  const params: unknown[] = [];

  if (opts?.domain) {
    conditions.push("domain = ?");
    params.push(opts.domain);
  }

  const rows = db
    .prepare(
      `SELECT asin, domain, field, old_value, new_value, severity, detected_at
       FROM changes WHERE ${conditions.join(" AND ")}
       ORDER BY detected_at DESC`
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    asin: r.asin as string,
    domain: r.domain as string,
    field: r.field as string,
    old_value: (r.old_value as string) ?? null,
    new_value: (r.new_value as string) ?? null,
    severity: r.severity as "critical" | "warning" | "info",
    detected_at: r.detected_at as string,
  }));
}

export function acknowledgeChanges(
  db: DatabaseLike,
  ids?: number[]
): void {
  if (ids?.length) {
    db.prepare(
      `UPDATE changes SET acknowledged = 1 WHERE id IN (${ids.map(() => "?").join(",")})`
    ).run(...ids);
  } else {
    db.prepare("UPDATE changes SET acknowledged = 1").run();
  }
}
