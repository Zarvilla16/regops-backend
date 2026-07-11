import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { In, QueryRunner } from "typeorm";
import { CustomerEntity, ScreeningCheckEntity, ScreeningMatchEntity } from "@regops/db";
import {
  AuthUserContext,
  MatchDecision,
  MatchReviewStatus,
  ScoreTrigger,
  ScreeningCheckType,
  ScreeningMatchDto,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskService } from "../risk/risk.service";
import { ScreeningService } from "./screening.service";
import { SCREENING_EVENTS } from "./screening.events";
import { RequestMeta } from "../customers/customers.service";

@Injectable()
export class MatchReviewService {
  constructor(
    private readonly screeningService: ScreeningService,
    private readonly riskService: RiskService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * checkType isn't a column on screening_match (Section 3.3's schema has no
   * such field) — every list/detail read here resolves it from the parent
   * screening_check, since a reviewer needs to know at a glance whether a
   * given match is a SANCTIONS/PEP/ADVERSE_MEDIA hit, not just an opaque
   * screeningCheckId to resolve separately.
   *
   * Two queries, not a single join: a `leftJoin(Entity, alias, condition)` +
   * `addSelect` + `orderBy` + pagination combination hit a real TypeORM bug
   * (`getRawAndEntities()` throwing `Cannot read properties of undefined
   * (reading 'databaseName')` inside `createOrderByCombinedWithSelectExpression`
   * — reproduced directly via this project's own e2e suite, not assumed).
   * A plain paginated match query followed by one batch lookup of the
   * distinct `screeningCheckId`s involved sidesteps that code path entirely
   * and is simple enough to reason about — one extra small `IN (...)` query
   * per page, not per row.
   */
  async findMatches(
    qr: QueryRunner,
    tenantId: string,
    filters: { customerId?: string; reviewStatus?: MatchReviewStatus },
    page: number,
    limit: number,
  ): Promise<{ data: ScreeningMatchDto[]; meta: { page: number; limit: number; total: number } }> {
    const qb = qr.manager
      .getRepository(ScreeningMatchEntity)
      .createQueryBuilder("m")
      .where("m.tenant_id = :tenantId", { tenantId });

    if (filters.customerId) qb.andWhere("m.customer_id = :customerId", { customerId: filters.customerId });
    // Section 6: "Pending review queue (default filter)" — default to
    // PENDING_REVIEW unless the caller explicitly asks for something else.
    qb.andWhere("m.review_status = :reviewStatus", { reviewStatus: filters.reviewStatus ?? MatchReviewStatus.PENDING_REVIEW });

    qb.orderBy("m.created_at", "DESC");
    qb.skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();

    const checkIds = [...new Set(rows.map((r) => r.screeningCheckId))];
    const checks = checkIds.length
      ? await qr.manager.getRepository(ScreeningCheckEntity).find({ where: { id: In(checkIds) } })
      : [];
    const checkTypeById = new Map(checks.map((c) => [c.id, c.checkType]));

    const data = rows.map((r) => this.screeningService.toMatchDto(r, checkTypeById.get(r.screeningCheckId)!));
    return { data, meta: { page, limit, total } };
  }

  async findMatchById(qr: QueryRunner, tenantId: string, id: string): Promise<ScreeningMatchDto> {
    const match = await qr.manager.getRepository(ScreeningMatchEntity).findOne({ where: { id, tenantId } });
    if (!match) {
      throw new NotFoundException({ code: "SCREENING_MATCH_NOT_FOUND", message: "Screening match not found." });
    }
    // The FK is NOT NULL (screening_check_id uuid NOT NULL REFERENCES
    // screening_check(id)), so a match's parent check always exists —
    // findOneOrFail reflects that guarantee rather than tolerating a null
    // that would mean the schema's own constraint had already been violated.
    const check = await qr.manager.getRepository(ScreeningCheckEntity).findOneOrFail({ where: { id: match.screeningCheckId } });
    return this.screeningService.toMatchDto(match, check.checkType);
  }

  /**
   * Section 6.1's decision logic:
   *  - TRUE_POSITIVE on SANCTIONS -> is_sanctioned=true, re-score, emit
   *    customer.sanctions_confirmed.
   *  - TRUE_POSITIVE on PEP -> is_pep=true, re-score, emit customer.pep_confirmed.
   *  - TRUE_POSITIVE on ADVERSE_MEDIA -> no dedicated customer flag exists
   *    for this in the current schema; the decision is still recorded and
   *    audited, just with no downstream flag/event (UI rendering of adverse
   *    media results is a later prompt per Section 2.2).
   *  - FALSE_POSITIVE -> no flag change; recorded with its reason. Future
   *    identical matches still land in the review queue — no global whitelist.
   *  - Decision is final: an already-REVIEWED match is rejected with 409.
   */
  async reviewMatch(
    qr: QueryRunner,
    tenantId: string,
    matchId: string,
    decision: MatchDecision,
    decisionReason: string,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<ScreeningMatchDto> {
    const matchRepo = qr.manager.getRepository(ScreeningMatchEntity);
    const match = await matchRepo.findOne({ where: { id: matchId, tenantId } });
    if (!match) {
      throw new NotFoundException({ code: "SCREENING_MATCH_NOT_FOUND", message: "Screening match not found." });
    }
    if (match.reviewStatus === MatchReviewStatus.REVIEWED) {
      throw new ConflictException({
        code: "MATCH_ALREADY_REVIEWED",
        message: "This match has already been reviewed. Decisions are final — start a new manual screen to reverse one.",
      });
    }

    // Same FK-guarantee reasoning as findMatchById above.
    const check = await qr.manager.getRepository(ScreeningCheckEntity).findOneOrFail({ where: { id: match.screeningCheckId } });

    match.reviewStatus = MatchReviewStatus.REVIEWED;
    match.decision = decision;
    match.decisionReason = decisionReason;
    match.reviewedBy = currentUser.sub;
    match.reviewedAt = new Date();
    await matchRepo.save(match);

    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: "screening.match.reviewed",
      entityType: "screening_match",
      entityId: match.id,
      afterState: { decision, decisionReason, checkType: check.checkType },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    if (decision === MatchDecision.TRUE_POSITIVE && match.customerId) {
      await this.applyTruePositive(qr, tenantId, check, match, currentUser, meta);
    }

    const saved = await matchRepo.findOneOrFail({ where: { id: match.id } });
    return this.screeningService.toMatchDto(saved, check.checkType);
  }

  private async applyTruePositive(
    qr: QueryRunner,
    tenantId: string,
    check: ScreeningCheckEntity,
    match: ScreeningMatchEntity,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ): Promise<void> {
    if (check.checkType !== ScreeningCheckType.SANCTIONS && check.checkType !== ScreeningCheckType.PEP) {
      // ADVERSE_MEDIA — no customer flag/event defined for it (see docblock above).
      return;
    }

    const customerRepo = qr.manager.getRepository(CustomerEntity);
    const flagField = check.checkType === ScreeningCheckType.SANCTIONS ? "isSanctioned" : "isPep";

    await customerRepo.update({ id: match.customerId! }, { [flagField]: true, lastScreenedAt: new Date() } as Partial<CustomerEntity>);
    const rescoredCustomer = await customerRepo.findOneOrFail({ where: { id: match.customerId! } });
    const history = await this.riskService.calculateAndPersist(qr, rescoredCustomer, ScoreTrigger.SCREENING_MATCH, currentUser.sub);

    const eventName = check.checkType === ScreeningCheckType.SANCTIONS ? SCREENING_EVENTS.SANCTIONS_CONFIRMED : SCREENING_EVENTS.PEP_CONFIRMED;
    this.eventEmitter.emit(eventName, {
      tenantId,
      customerId: match.customerId,
      matchId: match.id,
      reviewedBy: currentUser.sub,
    });

    // Section 4.1's "every state change is audit-logged" principle applies here just as
    // much as it does to the automated equivalent (apps/worker's applyConfirmedMatchFlag,
    // which writes customer.sanctions_flagged/customer.pep_flagged) — this human-reviewed
    // flag flip + re-score was previously only visible as an in-process event, with no
    // audit_log row of its own. Uses the *_confirmed action names (mirroring the event
    // names above 1:1) to stay distinguishable in the trail from the automated *_flagged
    // path, same reasoning RiskService's rescoreManual/rescoreScheduled already established
    // for keeping MANUAL/SCHEDULED re-scores independently visible rather than folded
    // together.
    const auditAction = check.checkType === ScreeningCheckType.SANCTIONS ? "customer.sanctions_confirmed" : "customer.pep_confirmed";
    await this.auditService.record(qr, {
      tenantId,
      userId: currentUser.sub,
      action: auditAction,
      entityType: "customer",
      entityId: match.customerId!,
      afterState: { [flagField]: true, riskScore: history.score, riskLevel: history.level, matchId: match.id },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
