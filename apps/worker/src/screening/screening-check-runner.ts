import { QueryRunner } from "typeorm";
import {
  AuditLogEntity,
  CustomerEntity,
  InternalBlacklistEntity,
  ScreeningCheckEntity,
  ScreeningMatchEntity,
  ScreeningProviderConfigEntity,
  TenantEntity,
} from "@regops/db";
import {
  MatchReviewStatus,
  ScreeningCheckStatus,
  ScreeningCheckType,
  ScreeningProviderName,
  ScreeningResultType,
  ScreeningTrigger,
} from "@regops/shared";
import {
  bandHighestScore,
  computeInputHash,
  MockProvider,
  parseTenantThresholds,
  PremblyProvider,
  screenWithFallback,
  ScreeningInput,
  ScreeningProvider,
  ScreeningResult,
  SmileIdProvider,
} from "@regops/screening-engine";

/**
 * Plain-function equivalent of apps/api's ScreeningService.runCheckInline +
 * ProviderRegistry + InternalBlacklistProvider + SecretsService — apps/worker
 * has no NestJS DI container, so the same core engine logic (already pure in
 * @regops/screening-engine) needs its own duplicated persistence/resolution
 * glue here, same rationale as apps/worker's existing computeRiskScore in
 * ingestion-job.processor.ts duplicating apps/api's RiskService.
 */

const FUZZY_NAME_SIMILARITY_THRESHOLD = 0.85;
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** Minimal equivalent of apps/api's AuditService.record() — same shape as
 * apply-confirmed-match.ts's own copy; kept duplicated across worker-side
 * files rather than shared for the same reason ingestion-job.processor.ts's
 * recordAudit is: no NestJS DI container to hang a common service off. */
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

function resolveSecret(ref: string): string {
  if (ref.startsWith("env://")) return process.env[ref.slice(6)] ?? "";
  if (ref.startsWith("vault://")) throw new Error("vault:// secret resolution is not implemented in v1.");
  throw new Error(`Unknown secret ref scheme: ${ref}`);
}

function providerByName(name: ScreeningProviderName): ScreeningProvider {
  switch (name) {
    case ScreeningProviderName.SMILE_ID:
      return new SmileIdProvider();
    case ScreeningProviderName.PREMBLY:
      return new PremblyProvider();
    case ScreeningProviderName.MOCK:
      return new MockProvider();
  }
}

interface ResolvedProvider {
  provider: ScreeningProvider;
  config: Record<string, unknown>;
}

async function resolveProviders(
  qr: QueryRunner,
  tenantId: string,
  checkType: ScreeningCheckType,
): Promise<{ primary: ResolvedProvider; fallback?: ResolvedProvider }> {
  const configs = await qr.manager
    .getRepository(ScreeningProviderConfigEntity)
    .find({ where: { tenantId, checkType, isActive: true } });
  const primaryConfig = configs.find((c) => c.isPrimary);
  const fallbackConfig = configs.find((c) => c.isFallback);

  if (!primaryConfig) {
    throw new Error(`No primary ${checkType} provider configured for tenant ${tenantId}`);
  }

  const toResolved = (entity: ScreeningProviderConfigEntity): ResolvedProvider => {
    const provider = providerByName(entity.provider);
    const secret = resolveSecret(entity.credentialsRef);
    const config: Record<string, unknown> =
      entity.provider === ScreeningProviderName.PREMBLY
        ? { apiKey: secret, appId: (entity.config.appId as string) ?? "", ...entity.config }
        : { apiKey: secret, apiSecret: (entity.config.apiSecret as string) ?? secret, ...entity.config };
    return { provider, config };
  };

  return { primary: toResolved(primaryConfig), fallback: fallbackConfig ? toResolved(fallbackConfig) : undefined };
}

/** Duplicate of apps/api's InternalBlacklistProvider.check — same SQL, no
 * NestJS DI needed since this is a plain function against the request's
 * QueryRunner. */
async function checkInternalBlacklist(qr: QueryRunner, tenantId: string, input: ScreeningInput): Promise<ScreeningResult | null> {
  const start = Date.now();
  const qb = qr.manager
    .getRepository(InternalBlacklistEntity)
    .createQueryBuilder("bl")
    .where("bl.tenant_id = :tenantId", { tenantId })
    .andWhere("(bl.expires_at IS NULL OR bl.expires_at > now())");

  const orConditions: string[] = [];
  const params: Record<string, unknown> = { tenantId };
  if (input.bvn) {
    orConditions.push("bl.bvn = :bvn");
    params.bvn = input.bvn;
  }
  if (input.nin) {
    orConditions.push("bl.nin = :nin");
    params.nin = input.nin;
  }
  orConditions.push("similarity(bl.full_name, :fullName) >= :threshold");
  params.fullName = input.fullName;
  params.threshold = FUZZY_NAME_SIMILARITY_THRESHOLD;

  qb.andWhere(`(${orConditions.join(" OR ")})`, params);
  qb.orderBy("similarity(bl.full_name, :fullName)", "DESC");

  const hit = await qb.getOne();
  if (!hit) return null;

  return {
    status: ScreeningResultType.CONFIRMED_MATCH,
    highestMatchScore: 100,
    matches: [
      {
        listSource: "INTERNAL_BLACKLIST",
        matchName: hit.fullName,
        matchScore: 100,
        matchData: { blacklistId: hit.id, reason: hit.reason, bvn: hit.bvn, nin: hit.nin },
      },
    ],
    providerReference: hit.id,
    rawResponse: { blacklistId: hit.id },
    latencyMs: Date.now() - start,
  };
}

async function findRecentCompletedCheck(
  qr: QueryRunner,
  customerId: string,
  checkType: ScreeningCheckType,
  inputHash: string,
): Promise<ScreeningCheckEntity | null> {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  return qr.manager
    .getRepository(ScreeningCheckEntity)
    .createQueryBuilder("c")
    .where("c.customer_id = :customerId", { customerId })
    .andWhere("c.check_type = :checkType", { checkType })
    .andWhere("c.input_hash = :inputHash", { inputHash })
    .andWhere("c.status = :status", { status: ScreeningCheckStatus.COMPLETED })
    .andWhere("c.started_at >= :since", { since })
    .orderBy("c.started_at", "DESC")
    .getOne();
}

export function buildScreeningInputFromCustomer(customer: CustomerEntity): ScreeningInput {
  return {
    fullName: customer.fullName,
    dateOfBirth: customer.dateOfBirth,
    bvn: customer.bvn,
    nin: customer.nin,
    country: customer.country,
    nationality: customer.nationality,
  };
}

/** Duplicate of apps/api's ScreeningService.runCheckInline — see that
 * file's docblock for the full behavioral spec (dedup, internal blacklist
 * first, registry resolve + retry/fallback, persist check + matches). */
export async function runScreeningCheck(
  qr: QueryRunner,
  tenant: TenantEntity,
  checkType: ScreeningCheckType,
  input: ScreeningInput,
  trigger: ScreeningTrigger,
  customerId: string,
): Promise<{ check: ScreeningCheckEntity; matches: ScreeningMatchEntity[] }> {
  const inputHash = computeInputHash(input);
  const startedAt = new Date();
  const checkRepo = qr.manager.getRepository(ScreeningCheckEntity);
  const matchRepo = qr.manager.getRepository(ScreeningMatchEntity);

  const cached = await findRecentCompletedCheck(qr, customerId, checkType, inputHash);
  if (cached) {
    const matches = await matchRepo.find({ where: { screeningCheckId: cached.id } });
    return { check: cached, matches };
  }

  const thresholds = parseTenantThresholds(tenant.config);
  const { primary, fallback } = await resolveProviders(qr, tenant.id, checkType);
  const blacklistResult = await checkInternalBlacklist(qr, tenant.id, input);

  let providerUsed: ScreeningProviderName = primary.provider.name;
  let screeningResult: ScreeningResult;

  if (blacklistResult) {
    screeningResult = blacklistResult;
  } else {
    try {
      const outcome = await screenWithFallback(checkType, input, primary, fallback);
      providerUsed = outcome.providerUsed;
      screeningResult = outcome.result;
    } catch (err) {
      const check = await checkRepo.save(
        checkRepo.create({
          tenantId: tenant.id,
          customerId,
          checkType,
          provider: providerUsed,
          inputData: input as unknown as Record<string, unknown>,
          inputHash,
          status: ScreeningCheckStatus.FAILED,
          result: ScreeningResultType.ERROR,
          highestMatchScore: null,
          providerReference: null,
          rawResponse: null,
          errorMessage: (err as Error).message,
          latencyMs: null,
          trigger,
          triggeredBy: null,
          startedAt,
          completedAt: new Date(),
        }),
      );
      await recordAudit(qr, {
        tenantId: tenant.id,
        action: "screening.check.completed",
        entityType: "screening_check",
        entityId: check.id,
        afterState: { checkType, status: check.status, result: check.result, customerId },
      });
      return { check, matches: [] };
    }
  }

  const bandedStatus = bandHighestScore(screeningResult.highestMatchScore, thresholds);
  const check = await checkRepo.save(
    checkRepo.create({
      tenantId: tenant.id,
      customerId,
      checkType,
      provider: providerUsed,
      inputData: input as unknown as Record<string, unknown>,
      inputHash,
      status: ScreeningCheckStatus.COMPLETED,
      result: bandedStatus,
      highestMatchScore: screeningResult.highestMatchScore,
      providerReference: screeningResult.providerReference,
      rawResponse: screeningResult.rawResponse,
      errorMessage: null,
      latencyMs: screeningResult.latencyMs,
      trigger,
      triggeredBy: null,
      startedAt,
      completedAt: new Date(),
    }),
  );

  const matches: ScreeningMatchEntity[] = [];
  if (bandedStatus !== ScreeningResultType.CLEAN) {
    const eligible = screeningResult.matches.filter((m) => m.matchScore >= thresholds.potentialMatchMin);
    for (const m of eligible) {
      const saved = await matchRepo.save(
        matchRepo.create({
          tenantId: tenant.id,
          screeningCheckId: check.id,
          customerId,
          listSource: m.listSource,
          matchName: m.matchName,
          matchScore: m.matchScore,
          matchData: m.matchData,
          reviewStatus: MatchReviewStatus.PENDING_REVIEW,
          decision: null,
          decisionReason: null,
          reviewedBy: null,
          reviewedAt: null,
          createdAt: new Date(),
        }),
      );
      matches.push(saved);
    }
  }

  await recordAudit(qr, {
    tenantId: tenant.id,
    action: "screening.check.completed",
    entityType: "screening_check",
    entityId: check.id,
    afterState: { checkType, status: check.status, result: check.result, customerId, matchCount: matches.length },
  });

  return { check, matches };
}
