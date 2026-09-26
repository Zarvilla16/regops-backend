import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { AlertEntity, CaseApprovalEventEntity, CaseEntity, CustomerEntity, TransactionEntity } from "@regops/db";
import {
  AlertStatus,
  AuthUserContext,
  CaseApprovalOutcome,
  CasePriority,
  CaseStatus,
  RiskLevel,
  TransactionChannel,
  TransactionSource,
  TransactionType,
  UserRole,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { CaseTimelineService } from "./case-timeline.service";
import { CasesService } from "./cases.service";

// --- Fake QueryRunner ---------------------------------------------------
// No TypeORM-mocking precedent exists anywhere in this codebase (see the
// investigation this test file's own PR/commit message summarizes) — every
// prior .spec.ts tests a pure function. This is a hand-built double, not a
// library: `manager.getRepository(Entity)` is keyed off the real entity
// class's `.name` (exactly how the service calls it — `qr.manager.
// getRepository(CaseEntity)`, never a string token), and `startTransaction`/
// `commitTransaction`/`rollbackTransaction` are tracked so a test COULD
// assert transaction boundaries if it needed to, though none of the tests
// below do — every guard-rejection path throws before `qr.startTransaction()`
// is ever reached, so those need no transaction bookkeeping at all.

interface RepoDouble {
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function makeRepo(overrides: Partial<RepoDouble> = {}): RepoDouble {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((x: unknown) => x),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn(async (x: unknown) => x),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

/** where/andWhere/orderBy/skip/take all return `this` — same fluent chain
 * TypeORM's real QueryBuilder exposes, terminated by getMany()/getManyAndCount(). */
function makeQueryBuilder(getManyResult: unknown[] = [], getManyAndCountResult?: [unknown[], number]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ["where", "andWhere", "leftJoin", "orderBy", "skip", "take"]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(getManyResult);
  qb.getManyAndCount = jest.fn().mockResolvedValue(getManyAndCountResult ?? [getManyResult, getManyResult.length]);
  return qb;
}

function makeQueryRunner(repos: Record<string, Partial<RepoDouble>> = {}): QueryRunner {
  const cache = new Map<string, RepoDouble>();
  const getRepository = jest.fn((entity: { name: string }) => {
    if (!cache.has(entity.name)) cache.set(entity.name, makeRepo(repos[entity.name]));
    return cache.get(entity.name);
  });
  return {
    manager: { getRepository, query: jest.fn() },
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: false,
  } as unknown as QueryRunner;
}

// --- Fixtures -------------------------------------------------------------

const TENANT = "tenant-1";
const CASE_ID = "case-1";
const CUSTOMER_ID = "customer-1";
const ASSIGNEE_ID = "user-assignee";
const SUBMITTER_ID = "user-submitter";
const OTHER_ID = "user-other";
const META = { ipAddress: null, userAgent: null };

function makeCurrentUser(sub: string): AuthUserContext {
  return { sub, tenantId: TENANT, role: UserRole.COMPLIANCE_OFFICER, email: `${sub}@demomfb.dev` };
}

function makeCase(overrides: Partial<CaseEntity> = {}): CaseEntity {
  return Object.assign(new CaseEntity(), {
    id: CASE_ID,
    tenantId: TENANT,
    caseNumber: "CASE-2026-0001",
    customerId: CUSTOMER_ID,
    status: CaseStatus.OPEN,
    priority: CasePriority.MEDIUM,
    assignedTo: ASSIGNEE_ID,
    createdBy: ASSIGNEE_ID,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    escalationRationale: null,
    closedAt: null,
    closedBy: null,
    closureReason: null,
    ...overrides,
  });
}

function makeAlert(overrides: Partial<AlertEntity> = {}): AlertEntity {
  return Object.assign(new AlertEntity(), {
    id: "alert-1",
    tenantId: TENANT,
    status: AlertStatus.NEW,
    evidence: {},
    ...overrides,
  });
}

function makeTransaction(overrides: Partial<TransactionEntity> = {}): TransactionEntity {
  return Object.assign(new TransactionEntity(), {
    id: "txn-1",
    tenantId: TENANT,
    cbsTransactionId: "cbs-1",
    customerId: CUSTOMER_ID,
    accountNumber: "0000000001",
    amount: "100000",
    currency: "NGN",
    type: TransactionType.CREDIT,
    channel: TransactionChannel.MOBILE,
    counterpartyAccount: null,
    counterpartyBank: null,
    counterpartyName: null,
    counterpartyCustomerId: null,
    narration: null,
    reference: null,
    balanceAfter: null,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    ingestedAt: new Date("2026-01-01T00:00:00.000Z"),
    source: TransactionSource.WEBHOOK,
    ingestionBatchId: null,
    ...overrides,
  });
}

function makeCustomer(overrides: Partial<CustomerEntity> = {}): CustomerEntity {
  return Object.assign(new CustomerEntity(), {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    riskLevel: RiskLevel.LOW,
    lastRiskCalculatedAt: new Date(),
    ...overrides,
  });
}

function makeAuditService(): jest.Mocked<Pick<AuditService, "record">> {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

function makeService(auditService = makeAuditService()) {
  const timelineService = { build: jest.fn() } as unknown as CaseTimelineService;
  const service = new CasesService(auditService as unknown as AuditService, timelineService);
  jest.spyOn(service, "toDetail").mockResolvedValue({} as never);
  return { service, auditService };
}

/** Asserts both the exception class and the structured `{ code }` every
 * guard in these services throws with — `rejects.toMatchObject` can't check
 * `instanceof` reliably (it compares `.constructor` by reference, which
 * happens to work but isn't what the matcher is for), so this catches
 * manually instead. */
async function expectRejection(promise: Promise<unknown>, ErrorClass: new (...args: never[]) => Error, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ErrorClass);
  expect((caught as { response?: unknown }).response).toMatchObject({ code });
}

describe("CasesService", () => {
  const NON_SUBMITTABLE_STATUSES: CaseStatus[] = [CaseStatus.PENDING_APPROVAL, CaseStatus.CLOSED, CaseStatus.SAR_FILED];
  const NON_APPROVABLE_STATUSES: CaseStatus[] = [CaseStatus.OPEN, CaseStatus.UNDER_INVESTIGATION, CaseStatus.CLOSED, CaseStatus.SAR_FILED];
  const NON_CLOSABLE_STATUSES: CaseStatus[] = [CaseStatus.PENDING_APPROVAL, CaseStatus.CLOSED, CaseStatus.SAR_FILED];

  // A checklist that passes all 4 items: one non-NEW alert (ALERT_REVIEWED),
  // that same alert set with no related transactions (TRANSACTIONS_REVIEWED
  // vacuously true), one note (NOTE_ADDED), a fresh risk score (RISK_SCORE_CURRENT).
  function completeChecklistRepos(): Record<string, Partial<RepoDouble>> {
    return {
      CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
      CaseAlertEntity: { find: jest.fn().mockResolvedValue([{ alertId: "alert-1" }]) },
      AlertEntity: { createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([makeAlert({ status: AlertStatus.ASSIGNED })])) },
      CaseNoteEntity: { count: jest.fn().mockResolvedValue(1) },
      CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer()) },
    };
  }

  describe("submit — transition guard", () => {
    it.each(NON_SUBMITTABLE_STATUSES)("rejects submission from %s with INVALID_TRANSITION", async (status) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status })) } });

      await expectRejection(service.submit(qr, TENANT, CASE_ID, "rationale", makeCurrentUser(OTHER_ID), META), ConflictException, "INVALID_TRANSITION");
    });

    it.each([CaseStatus.OPEN, CaseStatus.UNDER_INVESTIGATION])("allows submission from %s", async (status) => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({
        ...completeChecklistRepos(),
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status })) },
      });

      await service.submit(qr, TENANT, CASE_ID, "escalating because...", makeCurrentUser(OTHER_ID), META);
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "case.submitted_for_approval" }));
    });
  });

  describe("submit — maker-checker guard (submitter cannot be assignee)", () => {
    it("rejects when the current user is the case's own assignee", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ assignedTo: ASSIGNEE_ID })) } });

      await expectRejection(service.submit(qr, TENANT, CASE_ID, "rationale", makeCurrentUser(ASSIGNEE_ID), META), ForbiddenException, "SUBMITTER_CANNOT_BE_ASSIGNEE");
    });

    it("allows submission by anyone other than the assignee", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner(completeChecklistRepos());

      await expect(service.submit(qr, TENANT, CASE_ID, "rationale", makeCurrentUser(OTHER_ID), META)).resolves.toBeDefined();
    });
  });

  describe("submit — checklist and rationale guards", () => {
    it("rejects when the escalation checklist is incomplete", async () => {
      const { service } = makeService();
      // No linked alerts, no notes, no customer -> every item fails.
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) } });

      await expectRejection(
        service.submit(qr, TENANT, CASE_ID, "rationale", makeCurrentUser(OTHER_ID), META),
        BadRequestException,
        "ESCALATION_CHECKLIST_INCOMPLETE",
      );
    });

    it("rejects an empty or whitespace-only rationale even with a complete checklist", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner(completeChecklistRepos());

      await expectRejection(service.submit(qr, TENANT, CASE_ID, "   ", makeCurrentUser(OTHER_ID), META), BadRequestException, "ESCALATION_RATIONALE_REQUIRED");
    });
  });

  describe("submit — happy path", () => {
    it("writes the expected status/submission fields and audit action", async () => {
      const { service, auditService } = makeService();
      const repos = completeChecklistRepos();
      const qr = makeQueryRunner(repos);

      await service.submit(qr, TENANT, CASE_ID, "  escalating  ", makeCurrentUser(OTHER_ID), META);

      const caseRepo = qr.manager.getRepository(CaseEntity);
      expect(caseRepo.update).toHaveBeenCalledWith(
        { id: CASE_ID },
        expect.objectContaining({ status: CaseStatus.PENDING_APPROVAL, submittedBy: OTHER_ID, escalationRationale: "escalating" }),
      );
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "case.submitted_for_approval" }));
    });
  });

  describe("approve — transition guard", () => {
    it.each(NON_APPROVABLE_STATUSES)("rejects approval from %s with INVALID_TRANSITION", async (status) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status, submittedBy: SUBMITTER_ID })) } });

      await expectRejection(service.approve(qr, TENANT, CASE_ID, makeCurrentUser(OTHER_ID), META), ConflictException, "INVALID_TRANSITION");
    });
  });

  describe("approve — maker-checker guard (approver cannot be submitter)", () => {
    it("rejects when the current user is the case's own submitter", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status: CaseStatus.PENDING_APPROVAL, submittedBy: SUBMITTER_ID })) },
      });

      await expectRejection(service.approve(qr, TENANT, CASE_ID, makeCurrentUser(SUBMITTER_ID), META), ForbiddenException, "APPROVER_CANNOT_BE_SUBMITTER");
    });
  });

  describe("approve — happy path", () => {
    it("writes SAR_FILED, an APPROVED approval event, and a draft SAR report", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status: CaseStatus.PENDING_APPROVAL, submittedBy: SUBMITTER_ID })) },
      });

      await service.approve(qr, TENANT, CASE_ID, makeCurrentUser(OTHER_ID), META);

      const caseRepo = qr.manager.getRepository(CaseEntity);
      expect(caseRepo.update).toHaveBeenCalledWith(
        { id: CASE_ID },
        expect.objectContaining({ status: CaseStatus.SAR_FILED, approvedBy: OTHER_ID }),
      );
      const approvalRepo = qr.manager.getRepository(CaseApprovalEventEntity);
      expect(approvalRepo.save).toHaveBeenCalledWith(expect.objectContaining({ outcome: CaseApprovalOutcome.APPROVED }));
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "case.approved" }));
    });
  });

  describe("reject — transition guard", () => {
    it.each(NON_APPROVABLE_STATUSES)("rejects rejection from %s with INVALID_TRANSITION", async (status) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status, submittedBy: SUBMITTER_ID })) } });

      await expectRejection(service.reject(qr, TENANT, CASE_ID, "needs more work", makeCurrentUser(OTHER_ID), META), ConflictException, "INVALID_TRANSITION");
    });
  });

  describe("reject — maker-checker guard and reason requirement", () => {
    it("rejects when the current user is the case's own submitter", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status: CaseStatus.PENDING_APPROVAL, submittedBy: SUBMITTER_ID })) },
      });

      await expectRejection(service.reject(qr, TENANT, CASE_ID, "needs more work", makeCurrentUser(SUBMITTER_ID), META), ForbiddenException, "APPROVER_CANNOT_BE_SUBMITTER");
    });

    it("rejects an empty or whitespace-only reason", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status: CaseStatus.PENDING_APPROVAL, submittedBy: SUBMITTER_ID })) },
      });

      await expectRejection(service.reject(qr, TENANT, CASE_ID, "  ", makeCurrentUser(OTHER_ID), META), BadRequestException, "REJECTION_REASON_REQUIRED");
    });
  });

  describe("reject — happy path", () => {
    it("sends the case back to UNDER_INVESTIGATION and clears submission fields", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status: CaseStatus.PENDING_APPROVAL, submittedBy: SUBMITTER_ID })) },
      });

      await service.reject(qr, TENANT, CASE_ID, "double-check the second transaction", makeCurrentUser(OTHER_ID), META);

      const caseRepo = qr.manager.getRepository(CaseEntity);
      expect(caseRepo.update).toHaveBeenCalledWith(
        { id: CASE_ID },
        { status: CaseStatus.UNDER_INVESTIGATION, submittedBy: null, submittedAt: null, escalationRationale: null },
      );
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "case.rejected" }));
    });
  });

  describe("close — transition guard", () => {
    it.each(NON_CLOSABLE_STATUSES)("rejects closing from %s with INVALID_TRANSITION", async (status) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status })) } });

      await expectRejection(service.close(qr, TENANT, CASE_ID, "reason", makeCurrentUser(OTHER_ID), META), ConflictException, "INVALID_TRANSITION");
    });

    it.each([CaseStatus.OPEN, CaseStatus.UNDER_INVESTIGATION])("allows closing from %s", async (status) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase({ status })) } });

      await expect(service.close(qr, TENANT, CASE_ID, "false positive", makeCurrentUser(OTHER_ID), META)).resolves.toBeDefined();
    });
  });

  describe("close — closure reason default", () => {
    it("uses the given reason, trimmed, when provided", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) } });

      await service.close(qr, TENANT, CASE_ID, "  verified legitimate  ", makeCurrentUser(OTHER_ID), META);

      const caseRepo = qr.manager.getRepository(CaseEntity);
      expect(caseRepo.update).toHaveBeenCalledWith({ id: CASE_ID }, expect.objectContaining({ closureReason: "verified legitimate" }));
    });

    it.each([undefined, "", "   "])("falls back to the default closure reason when given %p", async (reason) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) } });

      await service.close(qr, TENANT, CASE_ID, reason, makeCurrentUser(OTHER_ID), META);

      const caseRepo = qr.manager.getRepository(CaseEntity);
      expect(caseRepo.update).toHaveBeenCalledWith(
        { id: CASE_ID },
        expect.objectContaining({ closureReason: "False positive — no suspicious activity confirmed after investigation." }),
      );
    });
  });

  describe("computeChecklist", () => {
    it("ALERT_REVIEWED passes when at least one linked alert is off NEW (some, not every)", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CaseAlertEntity: { find: jest.fn().mockResolvedValue([{ alertId: "a1" }, { alertId: "a2" }]) },
        AlertEntity: {
          createQueryBuilder: jest
            .fn()
            .mockReturnValue(makeQueryBuilder([makeAlert({ id: "a1", status: AlertStatus.NEW }), makeAlert({ id: "a2", status: AlertStatus.ASSIGNED })])),
        },
      });

      const checklist = await service.computeChecklist(qr, TENANT, CASE_ID);
      expect(checklist.items.find((i) => i.key === "ALERT_REVIEWED")?.passed).toBe(true);
    });

    it("TRANSACTIONS_REVIEWED is stricter (every) — fails with the same one-of-two-reviewed alert set once transactions exist", async () => {
      const { service } = makeService();
      const alerts = [
        makeAlert({ id: "a1", status: AlertStatus.NEW, evidence: { relatedTransactionIds: ["t1"] } }),
        makeAlert({ id: "a2", status: AlertStatus.ASSIGNED, evidence: {} }),
      ];
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CaseAlertEntity: { find: jest.fn().mockResolvedValue([{ alertId: "a1" }, { alertId: "a2" }]) },
        AlertEntity: { createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(alerts)) },
        TransactionEntity: { createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([makeTransaction({ id: "t1" })])) },
      });

      const checklist = await service.computeChecklist(qr, TENANT, CASE_ID);
      // Item 1 (some) already passed above with this exact alert mix — item 3
      // (every) must independently fail here: one alert (a1) is still NEW.
      expect(checklist.items.find((i) => i.key === "ALERT_REVIEWED")?.passed).toBe(true);
      expect(checklist.items.find((i) => i.key === "TRANSACTIONS_REVIEWED")?.passed).toBe(false);
    });

    it("TRANSACTIONS_REVIEWED passes vacuously when there are no derived transactions at all", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CaseAlertEntity: { find: jest.fn().mockResolvedValue([{ alertId: "a1" }]) },
        AlertEntity: { createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder([makeAlert({ status: AlertStatus.NEW })])) },
      });

      const checklist = await service.computeChecklist(qr, TENANT, CASE_ID);
      expect(checklist.items.find((i) => i.key === "TRANSACTIONS_REVIEWED")?.passed).toBe(true);
    });

    it.each([0, 1])("NOTE_ADDED reflects whether any note exists (count=%i)", async (count) => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CaseNoteEntity: { count: jest.fn().mockResolvedValue(count) },
      });

      const checklist = await service.computeChecklist(qr, TENANT, CASE_ID);
      expect(checklist.items.find((i) => i.key === "NOTE_ADDED")?.passed).toBe(count > 0);
    });

    it("RISK_SCORE_CURRENT is false when no customer record is found", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(null) },
      });

      const checklist = await service.computeChecklist(qr, TENANT, CASE_ID);
      expect(checklist.items.find((i) => i.key === "RISK_SCORE_CURRENT")?.passed).toBe(false);
    });

    it("RISK_SCORE_CURRENT respects the risk-band cadence — stale for CRITICAL past 1 day, current for LOW within 30 days", async () => {
      const { service } = makeService();
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

      const staleQr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ riskLevel: RiskLevel.CRITICAL, lastRiskCalculatedAt: twoDaysAgo })) },
      });
      const staleChecklist = await service.computeChecklist(staleQr, TENANT, CASE_ID);
      expect(staleChecklist.items.find((i) => i.key === "RISK_SCORE_CURRENT")?.passed).toBe(false);

      const currentQr = makeQueryRunner({
        CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) },
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ riskLevel: RiskLevel.LOW, lastRiskCalculatedAt: tenDaysAgo })) },
      });
      const currentChecklist = await service.computeChecklist(currentQr, TENANT, CASE_ID);
      expect(currentChecklist.items.find((i) => i.key === "RISK_SCORE_CURRENT")?.passed).toBe(true);
    });

    it("complete is true only when every item passes", async () => {
      const { service } = makeService();
      const completeQr = makeQueryRunner(completeChecklistRepos());
      expect((await service.computeChecklist(completeQr, TENANT, CASE_ID)).complete).toBe(true);

      const incompleteQr = makeQueryRunner({ CaseEntity: { findOne: jest.fn().mockResolvedValue(makeCase()) } });
      expect((await service.computeChecklist(incompleteQr, TENANT, CASE_ID)).complete).toBe(false);
    });
  });

  describe("maybeStartInvestigation — auto-transition trigger", () => {
    it("transitions OPEN -> UNDER_INVESTIGATION and records an audit row when the update actually matched", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { update: jest.fn().mockResolvedValue({ affected: 1 }) } });

      await service.maybeStartInvestigation(qr, TENANT, CASE_ID, "actor-1", META);

      const caseRepo = qr.manager.getRepository(CaseEntity);
      expect(caseRepo.update).toHaveBeenCalledWith({ id: CASE_ID, tenantId: TENANT, status: CaseStatus.OPEN }, { status: CaseStatus.UNDER_INVESTIGATION });
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "case.investigation_started" }));
    });

    it("no-ops — no audit row — when the case was not OPEN (the conditional UPDATE matched nothing)", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { update: jest.fn().mockResolvedValue({ affected: 0 }) } });

      await service.maybeStartInvestigation(qr, TENANT, CASE_ID, "actor-1", META);

      expect(auditService.record).not.toHaveBeenCalled();
    });

    it("tolerates a null actor/meta (the event-driven listener call site has no HTTP request)", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ CaseEntity: { update: jest.fn().mockResolvedValue({ affected: 1 }) } });

      await service.maybeStartInvestigation(qr, TENANT, CASE_ID, null, null);

      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: null, ipAddress: null, userAgent: null }));
    });
  });
});
