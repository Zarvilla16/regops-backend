import { Injectable, Logger } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { CustomerEntity, TenantEntity } from "@regops/db";
import { ScreeningCheckType, ScreeningResultType, ScreeningTrigger } from "@regops/shared";
import { ScreeningInput } from "@regops/screening-engine";
import { CounterpartyScreeningFacts, EvaluatorTransaction } from "@regops/rules-engine";
import { ScreeningService } from "../../screening/screening.service";
import { RuleEvaluationQueueService } from "../queue/rule-evaluation-queue.service";

const DEFAULT_CACHE_HOURS = 168;

/** Redis-cached wrapper around ScreeningService (Prompt 3) for the
 * HIGH_RISK_COUNTERPARTY scenario (Section 6.4). Two resolution paths:
 * - Internal counterparty (counterparty_customer_id set): direct Customer
 *   flag lookup, no external call at all.
 * - External counterparty (counterparty_name set, no known customer id):
 *   cached SANCTIONS + PEP screen via ScreeningService.runCheckInline.
 */
@Injectable()
export class CounterpartyScreeningService {
  private readonly logger = new Logger(CounterpartyScreeningService.name);

  constructor(
    private readonly screeningService: ScreeningService,
    private readonly ruleEvaluationQueueService: RuleEvaluationQueueService,
  ) {}

  async resolve(
    qr: QueryRunner,
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

    const cacheKey = this.cacheKey(tenantId, transaction);
    const cacheHours = Number(ruleConfig.externalScreeningCacheHours ?? DEFAULT_CACHE_HOURS);
    const cached = await this.readCache(cacheKey);
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
      this.screenSafely(qr, tenant, ScreeningCheckType.SANCTIONS, input),
      this.screenSafely(qr, tenant, ScreeningCheckType.PEP, input),
    ]);

    const isSanctioned = sanctionsOutcome?.check.result === ScreeningResultType.CONFIRMED_MATCH;
    // PEP screening has no binary "confirmed" concept the way sanctions
    // blocklists do — any non-CLEAN, non-ERROR result is treated as a PEP
    // hit here, consistent with Prompt 3's own POTENTIAL_MATCH/CONFIRMED_MATCH banding.
    const isPep =
      pepOutcome?.check.result != null &&
      pepOutcome.check.result !== ScreeningResultType.CLEAN &&
      pepOutcome.check.result !== ScreeningResultType.ERROR;
    const primaryOutcome = isSanctioned ? sanctionsOutcome : isPep ? pepOutcome : (sanctionsOutcome ?? pepOutcome);

    const facts: CounterpartyScreeningFacts = {
      isInternal: false,
      isSanctioned,
      isPep,
      matchSource: isSanctioned ? "SANCTIONS" : isPep ? "PEP" : null,
      matchScore: primaryOutcome?.check.highestMatchScore ?? null,
      screeningCheckId: primaryOutcome?.check.id ?? null,
    };

    await this.writeCache(cacheKey, facts, cacheHours);
    return facts;
  }

  private async screenSafely(
    qr: QueryRunner,
    tenant: TenantEntity,
    checkType: ScreeningCheckType,
    input: ScreeningInput,
  ): Promise<{ check: { id: string; result: ScreeningResultType | null; highestMatchScore: number | null } } | null> {
    try {
      const outcome = await this.screeningService.runCheckInline(
        qr,
        tenant,
        checkType,
        input,
        ScreeningTrigger.TRANSACTION_MONITORING,
        null,
        null,
      );
      return { check: outcome.check };
    } catch (err) {
      // Fail-open for transaction-monitoring counterparty screening (unlike
      // Prompt 3's onboarding sanctions pre-screen, which fails closed) —
      // a provider outage should not block transaction processing; the
      // HIGH_RISK_COUNTERPARTY rule simply can't fire for this transaction.
      this.logger.warn(`Counterparty ${checkType} screening failed for tenant ${tenant.id}: ${(err as Error).message}`);
      return null;
    }
  }

  private cacheKey(tenantId: string, transaction: EvaluatorTransaction): string {
    const identity = transaction.counterpartyBank && transaction.counterpartyAccount
      ? `${transaction.counterpartyBank}:${transaction.counterpartyAccount}`
      : `name:${(transaction.counterpartyName ?? "").toUpperCase().trim()}`;
    return `cp-screen:${tenantId}:${identity}`;
  }

  private async readCache(key: string): Promise<CounterpartyScreeningFacts | null> {
    try {
      const client = await this.ruleEvaluationQueueService.getClient();
      const raw = await client.get(key);
      return raw ? (JSON.parse(raw) as CounterpartyScreeningFacts) : null;
    } catch (err) {
      this.logger.warn(`Counterparty screening cache read failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async writeCache(key: string, facts: CounterpartyScreeningFacts, hours: number): Promise<void> {
    try {
      const client = await this.ruleEvaluationQueueService.getClient();
      await client.set(key, JSON.stringify(facts), { EX: Math.max(1, Math.round(hours * 3600)) });
    } catch (err) {
      this.logger.warn(`Counterparty screening cache write failed: ${(err as Error).message}`);
    }
  }
}
