import type { DatabaseLike } from "./db.js";

export interface Promo {
  id?: number;
  asin: string;
  domain: string;
  promo_type: string;
  start_date: string;
  end_date: string | null;
  notes: string | null;
  created_at?: string;
}

export function insertPromo(db: DatabaseLike, promo: Promo): number {
  const stmt = db.prepare(`
    INSERT INTO promos (asin, domain, promo_type, start_date, end_date, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    promo.asin,
    promo.domain,
    promo.promo_type,
    promo.start_date,
    promo.end_date,
    promo.notes
  );
  return result.lastInsertRowid as number;
}

export function listPromos(
  db: DatabaseLike,
  opts?: {
    asin?: string;
    domain?: string;
    activeOnly?: boolean;
  }
): Promo[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.asin) {
    conditions.push("asin = ?");
    params.push(opts.asin);
  }
  if (opts?.domain) {
    conditions.push("domain = ?");
    params.push(opts.domain);
  }
  if (opts?.activeOnly) {
    conditions.push("(end_date IS NULL OR end_date >= date('now'))");
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  return db
    .prepare(
      `SELECT id, asin, domain, promo_type, start_date, end_date, notes, created_at
       FROM promos ${where}
       ORDER BY start_date DESC`
    )
    .all(...params) as Promo[];
}

export function getPromoById(
  db: DatabaseLike,
  promoId: number
): Promo | null {
  return (
    (db
      .prepare(
        `SELECT id, asin, domain, promo_type, start_date, end_date, notes, created_at
         FROM promos WHERE id = ?`
      )
      .get(promoId) as Promo | undefined) ?? null
  );
}
