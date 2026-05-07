import { KeepaClient, KeepaApiError } from "./adapter/client.js";
import { getProduct, getTokenStatus, getBestSellers, getCategoryLookup } from "./adapter/endpoints.js";
import {
  toUniversalEnvelope,
  toErrorEnvelope,
  transformProductSnapshot,
  transformBuyBox,
  transformVariationFamily,
  transformSalesHistory,
  transformDeals,
  transformSellerStats,
} from "./adapter/transformer.js";
import { decodeCsvTimeSeries } from "./adapter/keepa-csv.js";
import { CSV_TYPE, DEFAULT_DOMAIN } from "./constants.js";
import { initDb } from "./storage/db.js";
import { insertSnapshot, getLatestSnapshot, getSnapshotHistory } from "./storage/snapshots.js";
import { insertChange, getRecentChanges, getUnacknowledgedChanges } from "./storage/changes.js";
import { addTrackedAsin, listTrackedAsins } from "./storage/tracked-asins.js";
import { insertPromo, listPromos } from "./storage/promos.js";
import { detectChanges } from "./analysis/change-detection.js";
import { analyzeBsrTrend } from "./analysis/bsr-trend.js";
import { checkVariationChanges } from "./analysis/variation-monitor.js";
import { analyzePromoImpact } from "./analysis/promo-correlation.js";
import type { UniversalEnvelope } from "./schema/universal.js";
import type { DatabaseLike } from "./storage/db.js";

export class KeepaSkill {
  private client: KeepaClient;
  private db: Promise<DatabaseLike>;

  constructor(opts?: { apiKey?: string; dbPath?: string }) {
    this.client = new KeepaClient({ apiKey: opts?.apiKey });
    this.db = initDb(opts?.dbPath);
  }

  private handleError(err: unknown): UniversalEnvelope {
    if (err instanceof KeepaApiError) {
      return toErrorEnvelope(
        `keepa_${err.httpStatus}`,
        err.message,
        err.httpStatus
      );
    }
    return toErrorEnvelope(
      "adapter_error",
      err instanceof Error ? err.message : "Unknown error"
    );
  }

  // --- Queries ---

  async getProduct(
    asins: string[],
    opts?: { domain?: string; statsDays?: number }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins,
        domain: opts?.domain,
        stats: opts?.statsDays ?? 30,
        rating: true,
      });
      const products = (res.data.products ?? []).map((p) =>
        transformProductSnapshot(p, opts?.domain)
      );
      return toUniversalEnvelope("product_snapshot", products, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getPriceHistory(
    asins: string[],
    opts?: { domain?: string; days?: number }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins,
        domain: opts?.domain,
        stats: opts?.days ?? 90,
        history: true,
        rating: true,
      });
      const histories = (res.data.products ?? []).map((p) => {
        const csv = p.csv ?? [];
        return {
          asin: p.asin,
          amazon_price: decodeCsvTimeSeries(csv[CSV_TYPE.AMAZON], { isPriceCents: true }),
          new_price: decodeCsvTimeSeries(csv[CSV_TYPE.NEW], { isPriceCents: true }),
          used_price: decodeCsvTimeSeries(csv[CSV_TYPE.USED], { isPriceCents: true }),
          sales_rank: decodeCsvTimeSeries(csv[CSV_TYPE.SALES_RANK]),
          rating: decodeCsvTimeSeries(csv[CSV_TYPE.RATING]),
          review_count: decodeCsvTimeSeries(csv[CSV_TYPE.COUNT_REVIEWS]),
          buy_box_price: decodeCsvTimeSeries(csv[CSV_TYPE.BUY_BOX_SHIPPING], { isPriceCents: true }),
          list_price: decodeCsvTimeSeries(csv[CSV_TYPE.LIST_PRICE], { isPriceCents: true }),
          lightning_deal: decodeCsvTimeSeries(csv[CSV_TYPE.LIGHTNING_DEAL], { isPriceCents: true }),
          fba_price: decodeCsvTimeSeries(csv[CSV_TYPE.NEW_FBA], { isPriceCents: true }),
          fbm_price: decodeCsvTimeSeries(csv[CSV_TYPE.NEW_FBM_SHIPPING], { isPriceCents: true }),
          offer_count_new: decodeCsvTimeSeries(csv[CSV_TYPE.COUNT_NEW]),
          offer_count_used: decodeCsvTimeSeries(csv[CSV_TYPE.COUNT_USED]),
        };
      });
      return toUniversalEnvelope("price_history", histories, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getBuyBox(
    asins: string[],
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins,
        domain: opts?.domain,
        stats: 1,
        offers: 20,
      });
      const buyBoxes = (res.data.products ?? []).map(transformBuyBox);
      return toUniversalEnvelope("buy_box", buyBoxes, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getVariations(
    asin: string,
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins: [asin],
        domain: opts?.domain,
        stats: 1,
      });
      const variations = (res.data.products ?? []).map(transformVariationFamily);
      return toUniversalEnvelope("variation_family", variations[0] ?? null, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async checkTokens(): Promise<UniversalEnvelope> {
    try {
      const res = await getTokenStatus(this.client);
      return toUniversalEnvelope("token_status", {
        tokens_left: res.data.tokensLeft,
        refill_in_ms: res.data.refillIn,
        refill_rate: res.data.refillRate,
      }, { tokens: res.tokens });
    } catch (err) {
      return this.handleError(err);
    }
  }

  // --- Monitoring ---

  async trackAsins(
    asins: string[],
    opts?: { domain?: string; label?: string; priority?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      for (const asin of asins) {
        addTrackedAsin(db, {
          asin,
          domain: opts?.domain,
          label: opts?.label,
          priority: opts?.priority,
        });
      }
      const tracked = listTrackedAsins(db, { domain: opts?.domain });
      return toUniversalEnvelope("tracked_asins", {
        added: asins.length,
        total_tracked: tracked.length,
        asins: tracked,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async takeSnapshot(opts?: {
    asins?: string[];
    domain?: string;
  }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const domainStr = opts?.domain ?? DEFAULT_DOMAIN;
      const targetAsins = opts?.asins?.length
        ? opts.asins
        : listTrackedAsins(db, { domain: domainStr }).map((t) => t.asin);

      if (!targetAsins.length) {
        return toUniversalEnvelope("snapshot_result", {
          message: "No ASINs to snapshot",
          snapshots: 0,
          changes: [],
        });
      }

      const allChanges: unknown[] = [];
      let snapshotCount = 0;

      for (let i = 0; i < targetAsins.length; i += 100) {
        const batch = targetAsins.slice(i, i + 100);
        const res = await getProduct(this.client, {
          asins: batch,
          domain: domainStr,
          stats: 30,
          rating: true,
        });

        for (const raw of res.data.products ?? []) {
          const snapshot = transformProductSnapshot(raw, domainStr);
          const previous = getLatestSnapshot(db, snapshot.asin, domainStr);
          insertSnapshot(db, snapshot, JSON.stringify(raw));
          snapshotCount++;

          if (previous) {
            const changes = detectChanges(previous, snapshot);
            for (const change of changes) {
              insertChange(db, change);
              allChanges.push(change);
            }
          }
        }
      }

      return toUniversalEnvelope("snapshot_result", {
        snapshots: snapshotCount,
        changes: allChanges,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getChanges(opts?: {
    asins?: string[];
    domain?: string;
    days?: number;
    severity?: string;
  }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const changes = getRecentChanges(db, {
        asins: opts?.asins,
        domain: opts?.domain,
        days: opts?.days ?? 7,
        severity: opts?.severity,
      });
      return toUniversalEnvelope("changes", changes);
    } catch (err) {
      return this.handleError(err);
    }
  }

  async analyzeBsrTrend(
    asins: string[],
    opts?: { periodDays?: number; domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const domainStr = opts?.domain ?? DEFAULT_DOMAIN;
      const trends = asins.map((asin) => {
        const snapshots = getSnapshotHistory(
          db,
          asin,
          domainStr,
          opts?.periodDays ?? 10
        );
        return analyzeBsrTrend(snapshots, asin, {
          periodDays: opts?.periodDays,
        });
      });
      return toUniversalEnvelope("bsr_trend", trends);
    } catch (err) {
      return this.handleError(err);
    }
  }

  async checkVariations(
    asins: string[],
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const domainStr = opts?.domain ?? DEFAULT_DOMAIN;
      const res = await getProduct(this.client, {
        asins,
        domain: domainStr,
        stats: 1,
        rating: true,
      });

      const allAlerts: unknown[] = [];
      for (const raw of res.data.products ?? []) {
        const current = transformProductSnapshot(raw, domainStr);
        const previous = getLatestSnapshot(db, current.asin, domainStr);
        if (previous) {
          const alerts = checkVariationChanges(previous, current);
          allAlerts.push(...alerts);
        }
      }

      return toUniversalEnvelope("variation_alerts", allAlerts, {
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  // --- New Tools ---

  async getSalesHistory(
    asins: string[],
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins,
        domain: opts?.domain,
        stats: 30,
        history: true,
      });
      const histories = (res.data.products ?? []).map(transformSalesHistory);
      return toUniversalEnvelope("sales_history", histories, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getDeals(
    asins: string[],
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins,
        domain: opts?.domain,
        stats: 30,
        history: true,
      });
      const deals = (res.data.products ?? []).map(transformDeals);
      return toUniversalEnvelope("deals", deals, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getSellerStats(
    asins: string[],
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getProduct(this.client, {
        asins,
        domain: opts?.domain,
        stats: 30,
        offers: 20,
      });
      const stats = (res.data.products ?? []).map(transformSellerStats);
      return toUniversalEnvelope("seller_stats", stats, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getBestSellers(
    category: number,
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getBestSellers(this.client, {
        domain: opts?.domain,
        category,
      });
      const data = res.data.bestSellersList;
      return toUniversalEnvelope("best_sellers", {
        category_id: data?.categoryId ?? category,
        asin_list: data?.asinList ?? [],
        last_update: data?.lastUpdate ?? null,
      }, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getCategory(
    category: number,
    opts?: { domain?: string }
  ): Promise<UniversalEnvelope> {
    try {
      const res = await getCategoryLookup(this.client, {
        domain: opts?.domain,
        category,
      });
      const categories = res.data.categories ?? {};
      const catData = categories[String(category)] ?? null;
      return toUniversalEnvelope("category", catData ? {
        category_id: catData.catId,
        name: catData.name,
        parent: catData.parent ?? null,
        children: catData.children ?? [],
        highest_rank: catData.highestRank ?? null,
        product_count: catData.productCount ?? null,
      } : null, {
        marketplace: opts?.domain ?? DEFAULT_DOMAIN,
        tokens: res.tokens,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  // --- Promos ---

  async addPromo(promo: {
    asin: string;
    promoType: string;
    startDate: string;
    endDate?: string;
    notes?: string;
    domain?: string;
  }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const id = insertPromo(db, {
        asin: promo.asin,
        domain: promo.domain ?? DEFAULT_DOMAIN,
        promo_type: promo.promoType,
        start_date: promo.startDate,
        end_date: promo.endDate ?? null,
        notes: promo.notes ?? null,
      });
      return toUniversalEnvelope("promo_created", {
        id,
        asin: promo.asin,
        promo_type: promo.promoType,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }

  async listPromos(opts?: {
    asin?: string;
    activeOnly?: boolean;
    domain?: string;
  }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const promos = listPromos(db, {
        asin: opts?.asin,
        domain: opts?.domain,
        activeOnly: opts?.activeOnly,
      });
      return toUniversalEnvelope("promos", promos);
    } catch (err) {
      return this.handleError(err);
    }
  }

  async analyzePromoImpact(opts: {
    promoId?: number;
    asin?: string;
    startDate?: string;
    endDate?: string;
    domain?: string;
  }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      let impact;
      if (opts.promoId) {
        impact = analyzePromoImpact(db, { promoId: opts.promoId });
      } else if (opts.asin && opts.startDate && opts.endDate) {
        impact = analyzePromoImpact(db, {
          asin: opts.asin,
          domain: opts.domain,
          startDate: opts.startDate,
          endDate: opts.endDate,
        });
      } else {
        return toErrorEnvelope(
          "invalid_params",
          "Provide either promoId or (asin + startDate + endDate)"
        );
      }
      return toUniversalEnvelope("promo_impact", impact);
    } catch (err) {
      return this.handleError(err);
    }
  }

  // --- Alerts (for bot consumption) ---

  async getAlerts(opts?: { domain?: string }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const changes = getUnacknowledgedChanges(db, {
        domain: opts?.domain,
      });
      return toUniversalEnvelope("alerts", changes);
    } catch (err) {
      return this.handleError(err);
    }
  }

  async getDailySummary(opts?: {
    domain?: string;
  }): Promise<UniversalEnvelope> {
    try {
      const db = await this.db;
      const domainStr = opts?.domain ?? DEFAULT_DOMAIN;
      const changes = getRecentChanges(db, {
        domain: domainStr,
        days: 1,
      });

      const critical = changes.filter((c) => c.severity === "critical");
      const warnings = changes.filter((c) => c.severity === "warning");
      const info = changes.filter((c) => c.severity === "info");

      const tracked = listTrackedAsins(db, { domain: domainStr });

      return toUniversalEnvelope("daily_summary", {
        date: new Date().toISOString().split("T")[0],
        domain: domainStr,
        total_tracked: tracked.length,
        total_changes: changes.length,
        critical_count: critical.length,
        warning_count: warnings.length,
        info_count: info.length,
        critical_changes: critical,
        warning_changes: warnings,
      });
    } catch (err) {
      return this.handleError(err);
    }
  }
}
