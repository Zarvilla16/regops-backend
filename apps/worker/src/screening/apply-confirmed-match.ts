import { QueryRunner } from "typeorm";
import { AuditLogEntity, CustomerEntity, RiskFactorConfigEntity, RiskScoreHistoryEntity } from "@regops/db";
import { RiskFactorType, ScoreTrigger, ScreeningCheckType } from "@regops/shared";
import { aggregateRiskScore, createFactorRegistry, RiskFactorContext, runFactors } from "@regops/risk-engine";

/** Minimal equivalent of apps/api's AuditService.record() — same shape, no
 * NestJS DI container to inject one into here (see the identical reasoning
 * in ingestion-job.processor.ts's own recordAudit). */
async function recordAudit(
  qr: QueryRunner,
  params: { tenantId: string; action: string; entityType: string; entityId: string; afterState: Record<string, unknown> },
): Promise<void> {
  const repo = qr.manager.getRepository(AuditLogEntity);
  await repo.save(
    repo.create({
      tenantId: params.tenantId,
      userId: null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      beforeState: null,
      afterState: params.afterState,
      ipAddress: null,
      userAgent: null,
    }),
  );
}

/** Same pure-computation shape as apps/api's RiskService.calculateAndPersist
 * and apps/worker's own ingestion-job.processor.ts computeRiskScore — no
 * NestJS DI available here, so this is the worker-side duplicate glue that
 * calls the shared, framework-free @regops/risk-engine package directly. */
async function computeRiskScore(
  customer: CustomerEntity,
  configByType: Map<RiskFactorType, RiskFactorConfigEntity>,
  now: Date,
) {
  const results = await runFactors(createFactorRegistry(), (factor) => {
    const config = configByType.get(factor.type);
    if (!config) return null;
    const ctx: RiskFactorContext = {
      customerId: customer.id,
      customer: {
        customerType: customer.customerType,
        occupation: customer.occupation,
        country: customer.country,
        nationality: customer.nationality,
        kycTier: customer.kycTier,
        isPep: customer.isPep,
        isSanctioned: customer.isSanctioned,
      },
      tenant: { id: customer.tenantId },
      config: { factorType: config.factorType, weight: config.weight, config: config.config, isActive: config.isActive },
      now,
    };
    return ctx;
  });
  return aggregateRiskScore(results, customer);
}

/**
 * Sets is_pep or is_sanctioned (per checkType), re-scores (ScoreTrigger.
 * SCREENING_MATCH — same trigger apps/api's MatchReviewService uses for the
 * human-reviewed TRUE_POSITIVE path, since this is the automated-detection
 * equivalent), and returns whether the flag actually changed from false to
 * true (so the caller only reports pepFlagged/sanctionsFlagged when this
 * was the check that did it, not on every CONFIRMED_MATCH re-run).
 */
export async function applyConfirmedMatchFlag(
  qr: QueryRunner,
  customer: CustomerEntity,
  checkType: ScreeningCheckType.SANCTIONS | ScreeningCheckType.PEP,
  checkId: string,
): Promise<boolean> {
  const flagField = checkType === ScreeningCheckType.SANCTIONS ? "isSanctioned" : "isPep";
  if (customer[flagField]) return false; // already flagged — nothing new to report.

  const customerRepo = qr.manager.getRepository(CustomerEntity);
  const now = new Date();

  await customerRepo.update({ id: customer.id }, { [flagField]: true, lastScreenedAt: now } as Partial<CustomerEntity>);
  const updated = await customerRepo.findOneOrFail({ where: { id: customer.id } });

  const configs = await qr.manager
    .getRepository(RiskFactorConfigEntity)
    .find({ where: { tenantId: customer.tenantId, isActive: true } });
  const configByType = new Map(configs.map((c) => [c.factorType, c]));

  const { score, level, factors } = await computeRiskScore(updated, configByType, now);
  const previousScore = updated.riskScore;
  const previousLevel = updated.riskLevel;

  await qr.manager.getRepository(RiskScoreHistoryEntity).save(
    qr.manager.getRepository(RiskScoreHistoryEntity).create({
      tenantId: customer.tenantId,
      customerId: customer.id,
      score,
      level,
      factors,
      trigger: ScoreTrigger.SCREENING_MATCH,
      previousScore,
      previousLevel,
      calculatedAt: now,
      calculatedBy: null,
    }),
  );
  await customerRepo.update({ id: customer.id }, { riskScore: score, riskLevel: level, lastRiskCalculatedAt: now });

  // Section 12's Definition of Done requires customer.pep_flagged /
  // customer.sanctions_flagged as audit LOG actions, not just in-process
  // events (apps/api's QueueEvents bridge — see async-screening-queue.service.ts
  // / rescreen-queue.service.ts — still separately re-emits the EventEmitter2
  // event once this job's completion is observed).
  const action = checkType === ScreeningCheckType.SANCTIONS ? "customer.sanctions_flagged" : "customer.pep_flagged";
  await recordAudit(qr, {
    tenantId: customer.tenantId,
    action,
    entityType: "customer",
    entityId: customer.id,
    afterState: { checkId },
  });

  return true;
}
