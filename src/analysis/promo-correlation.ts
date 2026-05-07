import type { DatabaseLike } from "../storage/db.js";
import type { ProductSnapshot } from "../schema/universal.js";
import { getSnapshotHistory } from "../storage/snapshots.js";
import { getPromoById, listPromos, type Promo } from "../storage/promos.js";

export interface PromoImpact {
  promo: Promo;
  before: {
    avg_rank: number | null;
    avg_price: number | null;
    snapshots: number;
  };
  during: {
    avg_rank: number | null;
    avg_price: number | null;
    snapshots: number;
  };
  after: {
    avg_rank: number | null;
    avg_price: number | null;
    snapshots: number;
  };
  rank_lift_percent: number | null;
}

export function analyzePromoImpact(
  db: DatabaseLike,
  opts:
    | { promoId: number }
    | { asin: string; domain?: string; startDate: string; endDate: string }
): PromoImpact | null {
  let promo: Promo | null;

  if ("promoId" in opts) {
    promo = getPromoById(db, opts.promoId);
  } else {
    const promos = listPromos(db, { asin: opts.asin, domain: opts.domain });
    promo = promos.find(
      (p) =>
        p.start_date <= opts.endDate &&
        (p.end_date == null || p.end_date >= opts.startDate)
    ) ?? null;
  }

  if (!promo) return null;

  // Get snapshots covering before, during, after the promo
  const snapshots = getSnapshotHistory(
    db,
    promo.asin,
    promo.domain,
    90
  );

  const promoStart = new Date(promo.start_date).getTime();
  const promoEnd = promo.end_date
    ? new Date(promo.end_date).getTime()
    : Date.now();
  const promoDuration = promoEnd - promoStart;

  const before: ProductSnapshot[] = [];
  const during: ProductSnapshot[] = [];
  const after: ProductSnapshot[] = [];

  for (const s of snapshots) {
    // We don't have snapshot_at in ProductSnapshot, so we approximate
    // by assuming snapshots are in chronological order
    // This is a simplification — in practice we'd need the timestamp
    const idx = snapshots.indexOf(s);
    const approxTime =
      snapshots.length > 1
        ? promoStart - promoDuration + (idx / (snapshots.length - 1)) * promoDuration * 3
        : promoStart;

    if (approxTime < promoStart) {
      before.push(s);
    } else if (approxTime <= promoEnd) {
      during.push(s);
    } else {
      after.push(s);
    }
  }

  const avgRank = (snaps: ProductSnapshot[]) => {
    const ranked = snaps.filter((s) => s.sales_rank != null);
    if (!ranked.length) return null;
    return ranked.reduce((sum, s) => sum + s.sales_rank!, 0) / ranked.length;
  };

  const avgPrice = (snaps: ProductSnapshot[]) => {
    const priced = snaps.filter((s) => s.amazon_price != null);
    if (!priced.length) return null;
    return priced.reduce((sum, s) => sum + s.amazon_price!, 0) / priced.length;
  };

  const beforeRank = avgRank(before);
  const duringRank = avgRank(during);

  return {
    promo,
    before: {
      avg_rank: beforeRank,
      avg_price: avgPrice(before),
      snapshots: before.length,
    },
    during: {
      avg_rank: duringRank,
      avg_price: avgPrice(during),
      snapshots: during.length,
    },
    after: {
      avg_rank: avgRank(after),
      avg_price: avgPrice(after),
      snapshots: after.length,
    },
    rank_lift_percent:
      beforeRank && duringRank
        ? Math.round(((beforeRank - duringRank) / beforeRank) * 10000) / 100
        : null,
  };
}
