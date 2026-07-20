import { QueryRunner } from "typeorm";
import type { RedisClient } from "bullmq";
import { CustomerEntity, TenantEntity } from "@regops/db";
import { ScreeningCheckType, ScreeningResultType, ScreeningTrigger } from "@regops/shared";
import { ScreeningInput } from "@regops/screening-engine";
import { CounterpartyScreeningFacts, EvaluatorTransaction } from "@regops/rules-engine";
import { runScreeningCheck } from "../screening/screening-check-runner";

const DEFAULT_CACHE_HOURS = 168;

/**
 * Plain-function equivalent of apps/api's CounterpartyScreeningService for
 * the HIGH_RISK_COUNTERPARTY scenario (Section 6.4) — apps/worker has no
 * NestJS DI container, so this calls this app's own screening-check-runner.ts
 * (already the worker-side duplicate of ScreeningService.runCheckInline)
 * rather than duplicating the provider-resolution/internal-blacklist logic a
 * second time. Same two resolution paths, same 7-day Redis cache key/TTL
 * convention, same fail-open-on-provider-error behavior as the apps/api
 * original.
 */
export async function resolveCounterpartyScreening(
  qr: QueryRunner,
  redisClient: RedisClient,
  tenantId: string,
  transaction: EvaluatorTransaction,
  ruleConfig: Record<string, unknown>,
): Promise<CounterpartyScreeningFacts | null> {
  if (transaction.counterpartyCustomerId) {
    const customer = await qr.manager
      .getRepository(CustomerEntity)
      .findOne({ where: { tenantId, id: transaction.counterpartyCustomerId } });
    if (!customer) return null;
    return {
      isInternal: true,
      isSanctioned: customer.isSanctioned,
      isPep: customer.isPep,
      matchSource: null,
      matchScore: null,
      screeningCheckId: null,
    };
  }

  if (!transaction.counterpartyName) return null;

  const cacheKey = buildCacheKey(tenantId, transaction);
  const cacheHours = Number(ruleConfig.externalScreeningCacheHours ?? DEFAULT_CACHE_HOURS);
  const cached = await readCache(redisClient, cacheKey);
  if (cached) return cached;

  const tenant = await qr.manager.getRepository(TenantEntity).findOneOrFail({ where: { id: tenantId } });
  const input: ScreeningInput = {
    fullName: transaction.counterpartyName,
    dateOfBirth: null,
    bvn: null,
    nin: null,
    country: "NG",
    nationality: null,
  };

  const [sanctionsOutcome, pepOutcome] = await Promise.all([
    screenSafely(qr, tenant, ScreeningCheckType.SANCTIONS, input),
    screenSafely(qr, tenant, ScreeningCheckType.PEP, input),
  ]);

  const isSanctioned = sanctionsOutcome?.result === ScreeningResultType.CONFIRMED_MATCH;
  // Same non-binary PEP treatment as CounterpartyScreeningService: any
  // non-CLEAN, non-ERROR result counts as a PEP hit.
  const isPep =
    pepOutcome?.result != null &&
    pepOutcome.result !== ScreeningResultType.CLEAN &&
    pepOutcome.result !== ScreeningResultType.ERROR;
  const primaryOutcome = isSanctioned ? sanctionsOutcome : isPep ? pepOutcome : (sanctionsOutcome ?? pepOutcome);

  const facts: CounterpartyScreeningFacts = {
    isInternal: false,
    isSanctioned,
    isPep,
    matchSource: isSanctioned ? "SANCTIONS" : isPep ? "PEP" : null,
    matchScore: primaryOutcome?.highestMatchScore ?? null,
    screeningCheckId: primaryOutcome?.id ?? null,
  };

  await writeCache(redisClient, cacheKey, facts, cacheHours);
  return facts;
}

async function screenSafely(
  qr: QueryRunner,
  tenant: TenantEntity,
  checkType: ScreeningCheckType,
  input: ScreeningInput,
): Promise<{ id: string; result: ScreeningResultType | null; highestMatchScore: number | null } | null> {
  try {
    // customerId null — no known Customer row for an external counterparty,
    // same as CounterpartyScreeningService.screenSafely's own call.
    const { check } = await runScreeningCheck(qr, tenant, checkType, input, ScreeningTrigger.TRANSACTION_MONITORING, null);
    return { id: check.id, result: check.result, highestMatchScore: check.highestMatchScore };
  } catch (err) {
    // Fail-open for transaction-monitoring counterparty screening (unlike
    // Prompt 3's onboarding sanctions pre-screen, which fails closed) — a
    // provider outage should not block transaction processing; the
    // HIGH_RISK_COUNTERPARTY rule simply can't fire for this transaction.
    console.warn(`[rules] Counterparty ${checkType} screening failed for tenant ${tenant.id}: ${(err as Error).message}`);
    return null;
  }
}

function buildCacheKey(tenantId: string, transaction: EvaluatorTransaction): string {
  const identity =
    transaction.counterpartyBank && transaction.counterpartyAccount
      ? `${transaction.counterpartyBank}:${transaction.counterpartyAccount}`
      : `name:${(transaction.counterpartyName ?? "").toUpperCase().trim()}`;
  return `cp-screen:${tenantId}:${identity}`;
}

async function readCache(client: RedisClient, key: string): Promise<CounterpartyScreeningFacts | null> {
  try {
    const raw = await client.get(key);
    return raw ? (JSON.parse(raw) as CounterpartyScreeningFacts) : null;
  } catch (err) {
    console.warn(`[rules] Counterparty screening cache read failed: ${(err as Error).message}`);
    return null;
  }
}

async function writeCache(client: RedisClient, key: string, facts: CounterpartyScreeningFacts, hours: number): Promise<void> {
  try {
    await client.set(key, JSON.stringify(facts), { EX: Math.max(1, Math.round(hours * 3600)) });
  } catch (err) {
    console.warn(`[rules] Counterparty screening cache write failed: ${(err as Error).message}`);
  }
}
