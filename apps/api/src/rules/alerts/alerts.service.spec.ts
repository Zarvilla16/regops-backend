import { BadRequestException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { AlertEntity } from "@regops/db";
import { AlertCloseCategory, AlertSeverity, AlertStatus, AuthUserContext, RuleScenarioType, UserRole } from "@regops/shared";
import { AuditService } from "../../audit/audit.service";
import { ALERT_EVENTS } from "../rules.events";
import { AlertsService } from "./alerts.service";

// --- Fake QueryRunner ------------------------------------------------------
// Same hand-built double as CasesService's spec (see that file's docblock for
// why no library/precedent is used) — AlertsService.assign()/close() do a
// single `repo.save()` with no explicit `startTransaction()` wrapper (unlike
// CasesService's multi-write methods), and `toDto()` is a pure synchronous
// mapper over the entity with no further DB calls, so these tests need no
// `toDto`/detail-assembly stubbing at all — every assertion below exercises
// the real save/audit/event-emission decision logic end to end.

interface RepoDouble {
  findOne: jest.Mock;
  save: jest.Mock;
}

function makeRepo(overrides: Partial<RepoDouble> = {}): RepoDouble {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(async (x: unknown) => x),
    ...overrides,
  };
}

function makeQueryRunner(repos: Record<string, Partial<RepoDouble>> = {}): QueryRunner {
  const cache = new Map<string, RepoDouble>();
  const getRepository = jest.fn((entity: { name: string }) => {
    if (!cache.has(entity.name)) cache.set(entity.name, makeRepo(repos[entity.name]));
    return cache.get(entity.name);
  });
  return { manager: { getRepository, query: jest.fn() } } as unknown as QueryRunner;
}

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

// --- Fixtures ---------------------------------------------------------------

const TENANT = "tenant-1";
const ALERT_ID = "alert-1";
const CURRENT_USER: AuthUserContext = { sub: "user-1", tenantId: TENANT, role: UserRole.COMPLIANCE_OFFICER, email: "officer@demomfb.dev" };
const META = { ipAddress: null, userAgent: null };

function makeAlert(overrides: Partial<AlertEntity> = {}): AlertEntity {
  return Object.assign(new AlertEntity(), {
    id: ALERT_ID,
    tenantId: TENANT,
    ruleId: "rule-1",
    customerId: "customer-1",
    triggeringTransactionId: null,
    scenarioType: RuleScenarioType.LARGE_CASH,
    severity: AlertSeverity.HIGH,
    status: AlertStatus.NEW,
    title: "Large cash transaction",
    evidence: {},
    dedupKey: "dedup-1",
    fireCount: 1,
    firstFiredAt: new Date("2026-01-01T00:00:00.000Z"),
    lastFiredAt: new Date("2026-01-01T00:00:00.000Z"),
    assignedTo: null,
    closedAt: null,
    closedBy: null,
    closeCategory: null,
    closureReason: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

function makeAuditService(): jest.Mocked<Pick<AuditService, "record">> {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

function makeEventEmitter(): jest.Mocked<Pick<EventEmitter2, "emit">> {
  return { emit: jest.fn() };
}

function makeService() {
  const auditService = makeAuditService();
  const eventEmitter = makeEventEmitter();
  const service = new AlertsService(auditService as unknown as AuditService, eventEmitter as unknown as EventEmitter2);
  return { service, auditService, eventEmitter };
}

describe("AlertsService", () => {
  describe("assign — status guard", () => {
    it("rejects assigning a CLOSED alert", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.CLOSED })) } });

      await expectRejection(
        service.assign(qr, TENANT, ALERT_ID, "user-2", CURRENT_USER, META),
        BadRequestException,
        "ALERT_CLOSED",
      );
    });
  });

  describe("assign — NEW -> ASSIGNED auto-transition", () => {
    it("flips a NEW alert to ASSIGNED and sets assignedTo", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.NEW })) } });

      const result = await service.assign(qr, TENANT, ALERT_ID, "user-2", CURRENT_USER, META);

      expect(result.status).toBe(AlertStatus.ASSIGNED);
      expect(result.assignedTo).toBe("user-2");
    });

    it.each([AlertStatus.ASSIGNED, AlertStatus.UNDER_REVIEW])("leaves an already-%s alert's status untouched, only reassigning it", async (status) => {
      const { service } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status, assignedTo: "user-1" })) } });

      const result = await service.assign(qr, TENANT, ALERT_ID, "user-2", CURRENT_USER, META);

      expect(result.status).toBe(status);
      expect(result.assignedTo).toBe("user-2");
    });
  });

  describe("assign — STATUS_CHANGED event, emitted only on a genuine status change", () => {
    it("emits STATUS_CHANGED when NEW -> ASSIGNED", async () => {
      const { service, eventEmitter } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.NEW })) } });

      await service.assign(qr, TENANT, ALERT_ID, "user-2", CURRENT_USER, META);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ALERT_EVENTS.STATUS_CHANGED,
        expect.objectContaining({ alertId: ALERT_ID, previousStatus: AlertStatus.NEW, newStatus: AlertStatus.ASSIGNED }),
      );
    });

    it("does not emit STATUS_CHANGED when reassigning an alert whose status doesn't actually change", async () => {
      const { service, eventEmitter } = makeService();
      const qr = makeQueryRunner({
        AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.ASSIGNED, assignedTo: "user-1" })) },
      });

      await service.assign(qr, TENANT, ALERT_ID, "user-2", CURRENT_USER, META);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe("assign — audit", () => {
    it("records alert.assign with before/after status and assignee", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.NEW })) } });

      await service.assign(qr, TENANT, ALERT_ID, "user-2", CURRENT_USER, META);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "alert.assign",
          beforeState: { status: AlertStatus.NEW, assignedTo: null },
          afterState: { status: AlertStatus.ASSIGNED, assignedTo: "user-2" },
        }),
      );
    });
  });

  describe("close — status guard", () => {
    it("rejects closing an already-CLOSED alert", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.CLOSED })) } });

      await expectRejection(
        service.close(qr, TENANT, ALERT_ID, AlertCloseCategory.FALSE_POSITIVE, "not suspicious", CURRENT_USER, META),
        BadRequestException,
        "ALERT_ALREADY_CLOSED",
      );
    });
  });

  describe("close — happy path", () => {
    it.each([AlertStatus.NEW, AlertStatus.ASSIGNED, AlertStatus.UNDER_REVIEW])("closes a %s alert, recording category/reason/closedBy", async (status) => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status })) } });

      const result = await service.close(qr, TENANT, ALERT_ID, AlertCloseCategory.RESOLVED, "confirmed legitimate", CURRENT_USER, META);

      expect(result.status).toBe(AlertStatus.CLOSED);
      expect(result.closeCategory).toBe(AlertCloseCategory.RESOLVED);
      expect(result.closureReason).toBe("confirmed legitimate");
      expect(result.closedBy).toBe(CURRENT_USER.sub);
      expect(result.closedAt).not.toBeNull();
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "alert.close" }));
    });

    it("emits CLOSED with the category and the pre-close status", async () => {
      const { service, eventEmitter } = makeService();
      const qr = makeQueryRunner({ AlertEntity: { findOne: jest.fn().mockResolvedValue(makeAlert({ status: AlertStatus.ASSIGNED })) } });

      await service.close(qr, TENANT, ALERT_ID, AlertCloseCategory.FALSE_POSITIVE, "duplicate of another alert", CURRENT_USER, META);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ALERT_EVENTS.CLOSED,
        expect.objectContaining({ alertId: ALERT_ID, closeCategory: AlertCloseCategory.FALSE_POSITIVE, previousStatus: AlertStatus.ASSIGNED }),
      );
    });
  });
});
