import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { computeVelocityScore, DailyStat, VelocityFactorConfig } from "./velocity-scoring";

/**
 * Backs TransactionVelocityFactor (packages/risk-engine) — that package's
 * `TransactionVelocityAdapter.getStats(customerId)` interface takes only a
 * customerId (no tenantId/QueryRunner/config), so RiskService builds a
 * per-call closure adapter around this service's `getStats` (see
 * RiskService.calculateAndPersist) rather than injecting this service
 * directly as the adapter — that's what actually supplies the missing
 * tenant/connection/config context.
 */
@Injectable()
export class VelocityAdapterService {
  /** GREATEST(30, dormancyDays) — one query window wide enough to cover both
   * the 30-day spike/channel signals and the dormancy-reactivation lookback
   * (spec Section 9.3's own pseudocode only shows the 30-day case; dormancy
   * needs a wider window, so it's queried once at the wider size and the
   * spike/channel logic re-slices the last 30 days out of the same result). */
  async getStats(
    qr: QueryRunner,
    tenantId: string,
    customerId: string,
    config: VelocityFactorConfig,
    now: Date,
  ): Promise<{ score: number; detail: Record<string, unknown> }> {
    const windowDays = Math.max(30, config.dormancyDays ?? 90);

    const rows: { day: string; total: string; count: string; channels: string[] }[] = await qr.manager.query(
      `SELECT
         TO_CHAR(DATE(occurred_at), 'YYYY-MM-DD') AS day,
         SUM(amount)::text AS total,
         COUNT(*)::text AS count,
         -- ::text[] — node-postgres has no OID mapping for an array of our
         -- custom transaction_channel_enum type and would otherwise hand
         -- back the raw "{MOBILE,POS}" literal instead of a real JS array.
         ARRAY_AGG(DISTINCT channel::text) AS channels
       FROM transaction
       WHERE tenant_id = $1 AND customer_id = $2 AND occurred_at >= $3
       GROUP BY DATE(occurred_at)`,
      [tenantId, customerId, new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)],
    );

    const dailyStats: DailyStat[] = rows.map((r) => ({
      day: r.day,
      total: Number(r.total),
      count: Number(r.count),
      channels: r.channels,
    }));

    return computeVelocityScore(dailyStats, config, now);
  }
}
