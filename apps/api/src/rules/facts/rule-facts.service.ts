import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { TransactionType } from "@regops/shared";
import { EvaluatorTransaction, RecentCashTransaction, RecentCredit, VelocityRawStats } from "@regops/rules-engine";

/**
 * Fact-gathering queries backing the STRUCTURING, RAPID_INFLOW_OUTFLOW, and
 * VELOCITY_SPIKE evaluators — deliberately outside packages/rules-engine
 * (which has no QueryRunner/TypeORM dependency by design, so it stays
 * unit-testable with plain fixtures — see that package's evaluators). Same
 * split as VelocityAdapterService (query) / velocity-scoring.ts (pure logic).
 */
@Injectable()
export class RuleFactsService {
  async fetchRecentCashTransactions(
    qr: QueryRunner,
    tenantId: string,
    customerId: string,
    transaction: EvaluatorTransaction,
    windowHours: number,
  ): Promise<RecentCashTransaction[]> {
    const since = new Date(transaction.occurredAt.getTime() - windowHours * 3_600_000);
    const rows: { id: string; amount: string; type: TransactionType; occurred_at: Date }[] = await qr.manager.query(
      `SELECT id, amount::text AS amount, type::text AS type, occurred_at
       FROM transaction
       WHERE tenant_id = $1 AND customer_id = $2 AND channel = 'CASH'
         AND occurred_at >= $3 AND occurred_at <= $4`,
      [tenantId, customerId, since, transaction.occurredAt],
    );
    return rows.map((r) => ({ id: r.id, amount: Number(r.amount), type: r.type, occurredAt: new Date(r.occurred_at) }));
  }

  async fetchRecentCredits(
    qr: QueryRunner,
    tenantId: string,
    customerId: string,
    transaction: EvaluatorTransaction,
    windowMinutes: number,
  ): Promise<RecentCredit[]> {
    const since = new Date(transaction.occurredAt.getTime() - windowMinutes * 60_000);
    const rows: { id: string; amount: string; occurred_at: Date; counterparty_customer_id: string | null }[] = await qr.manager.query(
      `SELECT id, amount::text AS amount, occurred_at, counterparty_customer_id
       FROM transaction
       WHERE tenant_id = $1 AND customer_id = $2 AND type = 'CREDIT'
         AND channel IN ('TRANSFER', 'MOBILE', 'USSD')
         AND occurred_at >= $3 AND occurred_at < $4`,
      [tenantId, customerId, since, transaction.occurredAt],
    );
    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      occurredAt: new Date(r.occurred_at),
      counterpartyCustomerId: r.counterparty_customer_id,
    }));
  }

  /** Section 6.5's raw stats — a dedicated query rather than reusing
   * VelocityAdapterService.getStats (Prompt 4), which returns a risk *score*
   * (TransactionVelocityFactor's shape), not the raw rollingDailyAvg30d/
   * spikeRatio/dormancyDays numbers this scenario's evaluator needs. Same
   * day-grouped-by-occurred_at query shape as that service, intentionally
   * duplicated rather than refactoring Prompt 4's stable, already-tested
   * code — see HANDOFF.md's Prompt 5 deviations. */
  async fetchVelocityRawStats(
    qr: QueryRunner,
    tenantId: string,
    customerId: string,
    historyDays: number,
    now: Date,
    onboardedAt: Date,
  ): Promise<VelocityRawStats> {
    const windowDays = Math.max(historyDays, 90);
    const rows: { day: string; total: string; count: string }[] = await qr.manager.query(
      `SELECT
         TO_CHAR(DATE(occurred_at), 'YYYY-MM-DD') AS day,
         SUM(amount)::text AS total,
         COUNT(*)::text AS count
       FROM transaction
       WHERE tenant_id = $1 AND customer_id = $2 AND occurred_at >= $3
       GROUP BY DATE(occurred_at)`,
      [tenantId, customerId, new Date(now.getTime() - windowDays * 86_400_000)],
    );

    const today = now.toISOString().slice(0, 10);
    const historyStart = new Date(now.getTime() - historyDays * 86_400_000).toISOString().slice(0, 10);
    const todayRow = rows.find((r) => r.day === today) ?? null;
    const historicalRows = rows.filter((r) => r.day >= historyStart && r.day < today);

    const todayTotal = todayRow ? Number(todayRow.total) : 0;
    const todayCount = todayRow ? Number(todayRow.count) : 0;
    const rollingDailyAvg =
      historicalRows.length > 0 ? historicalRows.reduce((sum, r) => sum + Number(r.total), 0) / historicalRows.length : 0;

    const priorDays = rows.filter((r) => r.day < today).sort((a, b) => (a.day < b.day ? 1 : -1));
    const dormancyDays =
      priorDays.length === 0 ? windowDays : Math.floor((now.getTime() - new Date(`${priorDays[0].day}T00:00:00Z`).getTime()) / 86_400_000);

    const customerAgeDays = Math.floor((now.getTime() - onboardedAt.getTime()) / 86_400_000);

    return {
      rollingDailyAvg,
      todayTotal,
      todayCount,
      historicalDayCount: historicalRows.length,
      dormancyDays,
      hasPriorActivityInWindow: priorDays.length > 0,
      customerAgeDays,
    };
  }
}
