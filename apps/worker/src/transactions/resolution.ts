import * as crypto from "crypto";
import { QueryRunner } from "typeorm";
import { AuditLogEntity, CustomerAccountEntity, CustomerEntity, RiskFactorConfigEntity, RiskScoreHistoryEntity } from "@regops/db";
import { AccountType, CustomerStatus, CustomerType, RiskFactorType, ScoreTrigger, UnknownCustomerMode } from "@regops/shared";
import { aggregateRiskScore, createFactorRegistry, RiskFactorContext, runFactors } from "@regops/risk-engine";

/** Postgres unique_violation — see resolveCustomers' docblock for why this
 * is caught rather than prevented. */
const UNIQUE_VIOLATION = "23505";

export interface CustomerResolution {
  customerId: string;
  /** True if this batch is what created the stub — used only for the error
   * report / audit trail, not for control flow. */
  wasAutoCreated: boolean;
}

/**
 * Bulk-resolves customer_cbs_id -> Customer for every row in a chunk
 * (spec Section 7.1 — one `= ANY($2)` query, not N+1). Rows whose
 * customer_cbs_id isn't found are handled per `mode`:
 *  - REJECT: simply absent from the returned map; caller emits UNKNOWN_CUSTOMER.
 *  - AUTO_CREATE_STUB: a stub Customer is created inline (Section 5.6) and
 *    added to the map.
 *
 * Concurrent chunks (this function runs inside each chunk's own transaction,
 * chunks run with bounded concurrency) can race to auto-create a stub for
 * the SAME cbs_customer_id — customer.uq_customer_tenant_cbs_id is the
 * backstop. On a unique-violation here, re-SELECT the row the other chunk
 * just committed and use its id instead of failing every row that needed it.
 */
export async function resolveCustomers(
  qr: QueryRunner,
  tenantId: string,
  cbsCustomerIds: string[],
  mode: UnknownCustomerMode,
  fullNameByCbsId: Map<string, string | undefined>,
  configByType: Map<RiskFactorType, RiskFactorConfigEntity>,
  auditUserId: string | null,
): Promise<Map<string, CustomerResolution>> {
  const unique = [...new Set(cbsCustomerIds)];
  if (unique.length === 0) return new Map();

  const customerRepo = qr.manager.getRepository(CustomerEntity);
  const existing = await customerRepo
    .createQueryBuilder("c")
    .where("c.tenant_id = :tenantId", { tenantId })
    .andWhere("c.cbs_customer_id IN (:...ids)", { ids: unique })
    .getMany();

  const resolved = new Map<string, CustomerResolution>();
  for (const c of existing) {
    resolved.set(c.cbsCustomerId, { customerId: c.id, wasAutoCreated: false });
  }

  if (mode !== UnknownCustomerMode.AUTO_CREATE_STUB) {
    return resolved;
  }

  const missing = unique.filter((id) => !resolved.has(id));
  const historyRepo = qr.manager.getRepository(RiskScoreHistoryEntity);
  const auditRepo = qr.manager.getRepository(AuditLogEntity);
  const now = new Date();

  for (const cbsCustomerId of missing) {
    const fields = {
      tenantId,
      cbsCustomerId,
      bvn: null,
      nin: null,
      fullName: fullNameByCbsId.get(cbsCustomerId) ?? `Unknown Customer ${cbsCustomerId}`,
      email: null,
      phone: null,
      dateOfBirth: null,
      customerType: CustomerType.INDIVIDUAL,
      occupation: null,
      country: "NG",
      nationality: null,
      kycTier: 1,
      status: CustomerStatus.PENDING_KYC,
      onboardedAt: now,
      isPep: false,
      isSanctioned: false,
    };

    let customerId: string;
    try {
      const { score, level, factors } = await computeInitialRiskScore(fields, configByType, now);
      const customer = await customerRepo.save(
        customerRepo.create({ ...fields, riskScore: score, riskLevel: level, lastRiskCalculatedAt: now }),
      );
      customerId = customer.id;

      await historyRepo.save(
        historyRepo.create({
          tenantId,
          customerId,
          score,
          level,
          factors,
          trigger: ScoreTrigger.INITIAL,
          previousScore: null,
          previousLevel: null,
          calculatedAt: now,
          calculatedBy: null,
        }),
      );
      await auditRepo.save(
        auditRepo.create({
          tenantId,
          userId: auditUserId,
          action: "customer.create",
          entityType: "customer",
          entityId: customerId,
          beforeState: null,
          afterState: { ...customer, source: "transaction_ingestion_auto_stub" },
          ipAddress: null,
          userAgent: null,
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      // Lost the race to another concurrently-processing chunk — use the
      // row it just committed instead of failing every transaction that
      // needed this customer.
      const winner = await customerRepo.findOneOrFail({ where: { tenantId, cbsCustomerId } });
      customerId = winner.id;
    }

    resolved.set(cbsCustomerId, { customerId, wasAutoCreated: true });
  }

  return resolved;
}

async function computeInitialRiskScore(
  fields: Pick<CustomerEntity, "tenantId" | "customerType" | "occupation" | "country" | "nationality" | "kycTier" | "isPep" | "isSanctioned">,
  configByType: Map<RiskFactorType, RiskFactorConfigEntity>,
  now: Date,
) {
  // No TransactionVelocityAdapter here — computed BEFORE this row's own
  // transaction is inserted (Section 5.6 runs resolution ahead of persist),
  // so a genuinely new stub has zero transaction history regardless; the
  // scaffold's documented rawValue=0 fallback is the exactly correct value
  // for this specific case, not a shortcut.
  const results = await runFactors(createFactorRegistry(), (factor) => {
    const config = configByType.get(factor.type);
    if (!config) return null;
    const ctx: RiskFactorContext = {
      customerId: "",
      customer: {
        customerType: fields.customerType,
        occupation: fields.occupation ?? null,
        country: fields.country,
        nationality: fields.nationality ?? null,
        kycTier: fields.kycTier,
        isPep: fields.isPep,
        isSanctioned: fields.isSanctioned,
      },
      tenant: { id: fields.tenantId },
      config: { factorType: config.factorType, weight: config.weight, config: config.config, isActive: config.isActive },
      now,
    };
    return ctx;
  });
  return aggregateRiskScore(results, fields);
}

/**
 * Bulk-resolves/auto-creates CustomerAccount rows for every distinct
 * (accountNumber, customerId) pair in a chunk (spec Section 5.7 — never
 * rejects a transaction for a missing account). Same unique-violation race
 * handling as resolveCustomers, on customer_account.uq_customer_account_tenant_account_number.
 */
export async function resolveAccounts(
  qr: QueryRunner,
  tenantId: string,
  rows: { accountNumber: string; customerId: string }[],
): Promise<void> {
  const uniqueAccountNumbers = [...new Set(rows.map((r) => r.accountNumber))];
  if (uniqueAccountNumbers.length === 0) return;

  const repo = qr.manager.getRepository(CustomerAccountEntity);
  const existing = await repo
    .createQueryBuilder("a")
    .where("a.tenant_id = :tenantId", { tenantId })
    .andWhere("a.account_number IN (:...numbers)", { numbers: uniqueAccountNumbers })
    .getMany();
  const existingNumbers = new Set(existing.map((a) => a.accountNumber));

  const firstCustomerForNumber = new Map<string, string>();
  for (const r of rows) {
    if (!firstCustomerForNumber.has(r.accountNumber)) firstCustomerForNumber.set(r.accountNumber, r.customerId);
  }

  for (const accountNumber of uniqueAccountNumbers) {
    if (existingNumbers.has(accountNumber)) continue;
    try {
      await repo.save(
        repo.create({
          tenantId,
          customerId: firstCustomerForNumber.get(accountNumber) as string,
          accountNumber,
          accountType: AccountType.SAVINGS,
        }),
      );
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      // Another concurrent chunk created it first — nothing further to do.
    }
  }
}

/**
 * Match-only bulk lookup for counterparty_account -> customerId (spec
 * Section 5.7's internal-transfer detection) — never auto-creates; an
 * unmatched counterparty account is a genuinely external transfer.
 */
export async function resolveCounterpartyAccounts(
  qr: QueryRunner,
  tenantId: string,
  counterpartyAccountNumbers: (string | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(counterpartyAccountNumbers.filter((a): a is string => Boolean(a)))];
  if (unique.length === 0) return new Map();

  const repo = qr.manager.getRepository(CustomerAccountEntity);
  const existing = await repo
    .createQueryBuilder("a")
    .where("a.tenant_id = :tenantId", { tenantId })
    .andWhere("a.account_number IN (:...numbers)", { numbers: unique })
    .getMany();

  return new Map(existing.map((a) => [a.accountNumber, a.customerId]));
}

/** Generates the id this batch's INSERT statement will use for a row —
 * pulled out only so ingestion-processor.ts doesn't import "crypto" solely
 * for this one call. */
export function newTransactionId(): string {
  return crypto.randomUUID();
}
