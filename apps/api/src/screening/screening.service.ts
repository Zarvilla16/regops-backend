import { Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity, ScreeningCheckEntity, ScreeningMatchEntity, TenantEntity } from "@regops/db";
import {
  MatchReviewStatus,
  ScoreTrigger,
  ScreeningCheckDto,
  ScreeningCheckStatus,
  ScreeningCheckType,
  ScreeningMatchDto,
  ScreeningProviderName,
  ScreeningResultType,
  ScreeningTrigger,
} from "@regops/shared";
import {
  bandHighestScore,
  computeInputHash,
  parseTenantThresholds,
  screenWithFallback,
  ScreeningInput,
  ScreeningResult,
} from "@regops/screening-engine";
import { InternalBlacklistProvider } from "./providers/internal-blacklist.provider";
import { ProviderRegistry } from "./providers/provider.registry";
import { SCREENING_EVENTS } from "./screening.events";
import { AsyncScreeningQueueService } from "./async-screening-queue.service";
import { RiskService } from "../risk/risk.service";
import { AuditService } from "../audit/audit.service";

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // Section 5.5: 1 hour.

@Injectable()
export class ScreeningService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly internalBlacklistProvider: InternalBlacklistProvider,
    private readonly providerRegistry: ProviderRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly asyncScreeningQueue: AsyncScreeningQueueService,
    private readonly riskService: RiskService,
    private readonly auditService: AuditService,
  ) {}

  buildScreeningInputFromCustomer(customer: Pick<CustomerEntity, "fullName" | "dateOfBirth" | "bvn" | "nin" | "country" | "nationality">): ScreeningInput {
    return {
      fullName: customer.fullName,
      dateOfBirth: customer.dateOfBirth,
      bvn: customer.bvn,
      nin: customer.nin,
      country: customer.country,
      nationality: customer.nationality,
    };
  }

  toCheckDto(check: ScreeningCheckEntity): ScreeningCheckDto {
    return {
      id: check.id,
      tenantId: check.tenantId,
      customerId: check.customerId,
      checkType: check.checkType,
      provider: check.provider,
      inputData: check.inputData,
      status: check.status,
      result: check.result,
      highestMatchScore: check.highestMatchScore,
      providerReference: check.providerReference,
      rawResponse: check.rawResponse,
      errorMessage: check.errorMessage,
      latencyMs: check.latencyMs,
      trigger: check.trigger,
      triggeredBy: check.triggeredBy,
      startedAt: check.startedAt.toISOString(),
      completedAt: check.completedAt ? check.completedAt.toISOString() : null,
    };
  }

  /** checkType is not a column on screening_match itself (Section 3.3's schema
   * has no such field) — it's always resolved from the parent ScreeningCheck
   * by the caller and passed in here, never looked up internally, so this
   * method's own signature makes the join impossible to forget. */
  toMatchDto(match: ScreeningMatchEntity, checkType: ScreeningCheckType): ScreeningMatchDto {
    return {
      id: match.id,
      tenantId: match.tenantId,
      screeningCheckId: match.screeningCheckId,
      checkType,
      customerId: match.customerId,
      listSource: match.listSource,
      matchName: match.matchName,
      matchScore: match.matchScore,
      matchData: match.matchData,
      reviewStatus: match.reviewStatus,
      decision: match.decision,
      decisionReason: match.decisionReason,
      reviewedBy: match.reviewedBy,
      reviewedAt: match.reviewedAt ? match.reviewedAt.toISOString() : null,
      createdAt: match.createdAt.toISOString(),
    };
  }

  /**
   * Same pattern as RescoreSchedulerService.withTenantContext (apps/api's
   * risk module) — a fresh, dedicated connection scoped to exactly one
   * tenant, committed independently of whatever ambient per-request
   * transaction the caller might also be running inside.
   *
   * This is the mechanism that lets a screening_check audit row survive even
   * when the calling request ultimately throws (e.g. the synchronous
   * sanctions block's 422, Section 5.1/10.3): TransactionInterceptor only
   * commits-or-rolls-back the *request's own* queryRunner (`req.queryRunner`,
   * opened by TenantContextMiddleware); a check/match write made on this
   * separate connection has already committed by the time that later
   * rollback (if any) happens, so it's untouched by it.
   */
  private async withDedicatedTenantContext<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
        [tenantId],
      );
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) {
        await qr.rollbackTransaction();
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  private async findRecentCompletedCheck(
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

  /**
   * The core engine (Section 4/5): dedup, internal blacklist first, then the
   * registry-resolved primary/fallback provider with retry, then persist a
   * ScreeningCheck (+ ScreeningMatch rows for anything at/above the
   * potential-match threshold). Runs entirely on the caller-supplied
   * QueryRunner — callers decide whether that's the dedicated,
   * independently-committed connection (sync sanctions path) or a plain
   * ambient one (nothing else in this prompt calls it with an ambient one
   * today, but async worker processors open their own equivalent connection
   * the same way).
   */
  async runCheckInline(
    qr: QueryRunner,
    tenant: TenantEntity,
    checkType: ScreeningCheckType,
    input: ScreeningInput,
    trigger: ScreeningTrigger,
    customerId: string | null,
    triggeredBy: string | null,
  ): Promise<{ check: ScreeningCheckEntity; matches: ScreeningMatchEntity[] }> {
    const inputHash = computeInputHash(input);
    const startedAt = new Date();
    const checkRepo = qr.manager.getRepository(ScreeningCheckEntity);
    const matchRepo = qr.manager.getRepository(ScreeningMatchEntity);

    if (customerId) {
      const cached = await this.findRecentCompletedCheck(qr, customerId, checkType, inputHash);
      if (cached) {
        const matches = await matchRepo.find({ where: { screeningCheckId: cached.id } });
        return { check: cached, matches };
      }
    }

    const thresholds = parseTenantThresholds(tenant.config);

    // Resolved up front (cheap: DB + secret lookup, no network call) even on
    // a blacklist hit, purely so the check row's NOT NULL `provider` column
    // has something meaningful to record — the resolved provider is never
    // actually called when the blacklist short-circuits (Section 4.4).
    const { primary, fallback } = await this.providerRegistry.resolve(qr, tenant.id, checkType);
    const blacklistResult = await this.internalBlacklistProvider.check(qr, tenant.id, input);

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
            triggeredBy,
            startedAt,
            completedAt: new Date(),
          }),
        );
        await this.auditService.record(qr, {
          tenantId: tenant.id,
          userId: triggeredBy,
          action: "screening.check.completed",
          entityType: "screening_check",
          entityId: check.id,
          afterState: { checkType, status: check.status, result: check.result, customerId },
          ipAddress: null,
          userAgent: null,
        });
        this.eventEmitter.emit(SCREENING_EVENTS.CHECK_COMPLETED, {
          tenantId: tenant.id,
          checkId: check.id,
          customerId,
          checkType,
          result: check.result,
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
        triggeredBy,
        startedAt,
        completedAt: new Date(),
      }),
    );

    // "Last screened" must move on every completed check, clean ones included — otherwise a customer screened clean
    // looks never screened. (A pre-screen at onboarding has no customer row yet; attachCustomer() sets it then.)
    if (customerId) {
      await qr.manager.getRepository(CustomerEntity).update({ id: customerId }, { lastScreenedAt: check.completedAt });
    }

    const matches: ScreeningMatchEntity[] = [];
    if (bandedStatus !== ScreeningResultType.CLEAN) {
      const eligibleMatches =screeningResult.matches.filter((m) => m.matchScore >= thresholds.potentialMatchMin);
      for (const m of eligibleMatches) {
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
        this.eventEmitter.emit(SCREENING_EVENTS.MATCH_FOUND, {
          tenantId: tenant.id,
          matchId: saved.id,
          checkId: check.id,
          customerId,
          matchScore: saved.matchScore,
        });
      }
    }

    await this.auditService.record(qr, {
      tenantId: tenant.id,
      userId: triggeredBy,
      action: "screening.check.completed",
      entityType: "screening_check",
      entityId: check.id,
      afterState: { checkType, status: check.status, result: check.result, customerId, matchCount: matches.length },
      ipAddress: null,
      userAgent: null,
    });
    this.eventEmitter.emit(SCREENING_EVENTS.CHECK_COMPLETED, {
      tenantId: tenant.id,
      checkId: check.id,
      customerId,
      checkType,
      result: check.result,
    });

    return { check, matches };
  }

  /**
   * Section 5.1's synchronous, blocking sanctions pre-screen. Called from
   * CustomersService.create() BEFORE the Customer row is inserted, and
   * always on its own dedicated connection (see withDedicatedTenantContext)
   * so the resulting audit row survives even when this throws.
   *
   * - CONFIRMED_MATCH -> 422 SANCTIONS_MATCH_BLOCK (Section 5.1's exact code).
   * - FAILED (provider outage, no working fallback) -> 503, fail-closed
   *   (Section 4.5/10.4) — never fail open on a sanctions check.
   * - Otherwise (CLEAN or POTENTIAL_MATCH) -> returns the check; the caller
   *   proceeds to create the customer.
   */
  async screenSync(
    tenantId: string,
    checkType: ScreeningCheckType,
    input: ScreeningInput,
    trigger: ScreeningTrigger,
    triggeredBy: string | null,
  ): Promise<{ check: ScreeningCheckEntity; matches: ScreeningMatchEntity[] }> {
    const outcome = await this.withDedicatedTenantContext(tenantId, async (qr) => {
      const tenant = await qr.manager.getRepository(TenantEntity).findOneOrFail({ where: { id: tenantId } });
      const result = await this.runCheckInline(qr, tenant, checkType, input, trigger, null, triggeredBy);

      // Written on the SAME dedicated connection/transaction as the check
      // itself (Section 12's Definition of Done requires this action) — a
      // tagged-result pattern, not throwing here, is what lets this commit
      // normally before screenSync throws the actual 422 below (same
      // reasoning as AuthService.login()'s bug #8 fix in HANDOFF.md: the
      // audit write must land even though the request ultimately errors).
      if (result.check.result === ScreeningResultType.CONFIRMED_MATCH) {
        await this.auditService.record(qr, {
          tenantId,
          userId: triggeredBy,
          action: "customer.create.blocked",
          entityType: "customer",
          entityId: null,
          afterState: { screeningCheckId: result.check.id, checkType, code: "SANCTIONS_MATCH_BLOCK" },
          ipAddress: null,
          userAgent: null,
        });
      }

      return result;
    });

    if (outcome.check.status === ScreeningCheckStatus.FAILED) {
      throw new ServiceUnavailableException({
        code: "SCREENING_PROVIDER_UNAVAILABLE",
        message: "Sanctions screening is temporarily unavailable. Please retry shortly — customer creation cannot proceed without it.",
        details: { screeningCheckId: outcome.check.id },
      });
    }

    if (outcome.check.result === ScreeningResultType.CONFIRMED_MATCH) {
      throw new UnprocessableEntityException({
        code: "SANCTIONS_MATCH_BLOCK",
        message: "Customer matches a sanctions list and cannot be onboarded.",
        details: {
          screeningCheckId: outcome.check.id,
          matchCount: outcome.matches.length,
          // Deliberately no list_source/match_name here — info leak risk
          // (Section 5.1); a compliance officer sees full details via
          // GET /screening/matches, not the blocked API caller.
        },
      });
    }

    return outcome;
  }

  /**
   * POST /screening/customers/:id/sanctions (Section 6) — a synchronous
   * on-demand sanctions re-check for a customer that ALREADY exists, unlike
   * screenSync's onboarding pre-screen. There is nothing to "block" here (no
   * customer creation in flight), so this never throws on CONFIRMED_MATCH —
   * instead it applies the same auto-flag treatment Section 5.3's scheduled
   * re-screen applies to an existing customer: set is_sanctioned, re-score,
   * emit customer.sanctions_flagged (never sanctions_confirmed — that name
   * is reserved for the manual match-review TRUE_POSITIVE path). Runs on the
   * caller's own (ambient) queryRunner — there's no "must survive this same
   * request's later rollback" concern here the way there is for the
   * onboarding block, since this call doesn't itself throw an exception that
   * would trigger one.
   */
  async screenExistingCustomerSanctions(
    qr: QueryRunner,
    tenant: TenantEntity,
    customer: CustomerEntity,
    triggeredBy: string,
  ): Promise<{ check: ScreeningCheckEntity; matches: ScreeningMatchEntity[] }> {
    const input = this.buildScreeningInputFromCustomer(customer);
    const outcome = await this.runCheckInline(qr, tenant, ScreeningCheckType.SANCTIONS, input, ScreeningTrigger.MANUAL, customer.id, triggeredBy);

    if (outcome.check.status === ScreeningCheckStatus.FAILED) {
      throw new ServiceUnavailableException({
        code: "SCREENING_PROVIDER_UNAVAILABLE",
        message: "Sanctions screening is temporarily unavailable. Please retry shortly.",
        details: { screeningCheckId: outcome.check.id },
      });
    }

    if (outcome.check.result === ScreeningResultType.CONFIRMED_MATCH && !customer.isSanctioned) {
      const customerRepo = qr.manager.getRepository(CustomerEntity);
      await customerRepo.update({ id: customer.id }, { isSanctioned: true, lastScreenedAt: new Date() });
      const rescored = await customerRepo.findOneOrFail({ where: { id: customer.id } });
      await this.riskService.calculateAndPersist(qr, rescored, ScoreTrigger.SCREENING_MATCH, null);

      await this.auditService.record(qr, {
        tenantId: tenant.id,
        userId: triggeredBy,
        action: "customer.sanctions_flagged",
        entityType: "customer",
        entityId: customer.id,
        afterState: { checkId: outcome.check.id, matchId: outcome.matches[0]?.id ?? null },
        ipAddress: null,
        userAgent: null,
      });
      this.eventEmitter.emit(SCREENING_EVENTS.SANCTIONS_FLAGGED, {
        tenantId: tenant.id,
        customerId: customer.id,
        checkId: outcome.check.id,
        matchId: outcome.matches[0]?.id ?? null,
      });
    }

    return outcome;
  }

  /** After a customer row is successfully created, attaches its id to the
   * screening_check row the sync pre-screen left with customer_id NULL
   * (Section 5.1). Runs on the caller's own (ambient) queryRunner, inside
   * the same transaction as the rest of customer creation — if that
   * transaction later rolls back for an unrelated reason, this update
   * correctly rolls back with it, leaving the already-independently-committed
   * check row exactly as it was (customer_id NULL), which is still correct:
   * no customer row actually exists in that case either. */
  async attachCustomer(qr: QueryRunner, checkId: string, customerId: string): Promise<void> {
    await qr.manager.getRepository(ScreeningCheckEntity).update({ id: checkId }, { customerId });
    await qr.manager.getRepository(ScreeningMatchEntity).update({ screeningCheckId: checkId }, { customerId });
    // The onboarding pre-screen is this customer's first screening.
    await qr.manager.getRepository(CustomerEntity).update({ id: customerId }, { lastScreenedAt: new Date() });
  }

  /** Section 5.2's "enqueue async PEP and adverse media screening" — always
   * called AFTER the customer-creation transaction has committed (mirroring
   * where CustomersService.create() already emits customer.created), so the
   * worker can never race ahead of a customer row that doesn't durably exist
   * yet. */
  async enqueueAsync(
    tenantId: string,
    customerId: string,
    checkTypes: ScreeningCheckType[],
    trigger: ScreeningTrigger,
  ): Promise<void> {
    await this.asyncScreeningQueue.enqueue({ tenantId, customerId, checkTypes, trigger });
  }

  /** POST /screening/customers/:id/screen (Section 5.4/6) — always async,
   * for any role COMPLIANCE_OFFICER+. */
  async manualScreen(tenantId: string, customerId: string, checkTypes: ScreeningCheckType[]): Promise<{ queued: true; checkTypes: ScreeningCheckType[] }> {
    await this.asyncScreeningQueue.enqueue({
      tenantId,
      customerId,
      checkTypes,
      trigger: ScreeningTrigger.MANUAL,
    });
    return { queued: true, checkTypes };
  }

  async findChecks(
    qr: QueryRunner,
    tenantId: string,
    filters: { customerId?: string; checkTypes?: ScreeningCheckType[]; statuses?: ScreeningCheckStatus[]; results?: ScreeningResultType[] },
    page: number,
    limit: number,
  ): Promise<{ data: ScreeningCheckDto[]; meta: { page: number; limit: number; total: number } }> {
    const qb = qr.manager
      .getRepository(ScreeningCheckEntity)
      .createQueryBuilder("c")
      .where("c.tenant_id = :tenantId", { tenantId });

    if (filters.customerId) qb.andWhere("c.customer_id = :customerId", { customerId: filters.customerId });
    if (filters.checkTypes?.length) qb.andWhere("c.check_type IN (:...checkTypes)", { checkTypes: filters.checkTypes });
    if (filters.statuses?.length) qb.andWhere("c.status IN (:...statuses)", { statuses: filters.statuses });
    if (filters.results?.length) qb.andWhere("c.result IN (:...results)", { results: filters.results });

    qb.orderBy("c.started_at", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { data: rows.map((r) => this.toCheckDto(r)), meta: { page, limit, total } };
  }

  async findCheckById(qr: QueryRunner, tenantId: string, id: string): Promise<ScreeningCheckDto> {
    const check = await qr.manager.getRepository(ScreeningCheckEntity).findOne({ where: { id, tenantId } });
    if (!check) {
      throw new NotFoundException({ code: "SCREENING_CHECK_NOT_FOUND", message: "Screening check not found." });
    }
    return this.toCheckDto(check);
  }
}
