import { QueryRunner } from "typeorm";
import { TransactionType } from "@regops/shared";
import { EvaluatorTransaction, RecentCashTransaction, RecentCredit, VelocityRawStats } from "@regops/rules-engine";

/**
 * Plain-function equivalent of apps/api's RuleFactsService — apps/worker has
 * no NestJS DI container, so this is the worker-side duplicate glue (same
 * split as CounterpartyScreeningService's own worker-side duplicate in
 * ./counterparty-screening.ts). Identical SQL to RuleFactsService; kept
 * duplicated rather than shared for the same reason every other worker/api
 * query-layer split in this codebase is (no shared runtime to hang a common
 * class off cleanly given each side's own DI story).
 */

export async function fetchRecentCashTransactions(
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

export async function fetchRecentCredits(
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

export async function fetchVelocityRawStats(
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
