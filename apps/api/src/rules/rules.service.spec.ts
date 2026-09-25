import { BadRequestException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { RuleEntity } from "@regops/db";
import { AlertSeverity, AuthUserContext, RuleAction, RuleScenarioType, UserRole } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { EvaluatorFactsGatheringService } from "./facts/evaluator-facts-gathering.service";
import { RULE_EVENTS } from "./rules.events";
import { RulesService } from "./rules.service";

// --- Fake QueryRunner -------------------------------------------------------
// Same hand-built double as CasesService/AlertsService's specs — RulesService.
// update() does a single `repo.save()` (no explicit transaction boundary),
// so no transaction bookkeeping is needed here either.

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
const RULE_ID = "rule-1";
const CURRENT_USER: AuthUserContext = { sub: "user-1", tenantId: TENANT, role: UserRole.COMPLIANCE_OFFICER, email: "officer@demomfb.dev" };
const META = { ipAddress: null, userAgent: null };

function makeRule(overrides: Partial<RuleEntity> = {}): RuleEntity {
  return Object.assign(new RuleEntity(), {
    id: RULE_ID,
    tenantId: TENANT,
    name: "Large cash transaction",
    scenarioType: RuleScenarioType.LARGE_CASH,
    description: "Flags large cash transactions",
    config: { thresholdIndividual: 5_000_000 },
    severity: AlertSeverity.HIGH,
    action: RuleAction.FLAG,
    isActive: true,
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
  const factsGatheringService = {} as EvaluatorFactsGatheringService;
  const service = new RulesService(auditService as unknown as AuditService, eventEmitter as unknown as EventEmitter2, factsGatheringService);
  return { service, auditService, eventEmitter };
}

describe("RulesService", () => {
  describe("update — tenant guard (findOneEntity)", () => {
    it("throws RULE_NOT_FOUND when no rule matches id+tenant", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(null) } });

      await expectRejection(service.update(qr, TENANT, RULE_ID, {}, false, CURRENT_USER, META), NotFoundException, "RULE_NOT_FOUND");
    });

    it("scopes the lookup by tenantId, not id alone", async () => {
      const { service } = makeService();
      const findOne = jest.fn().mockResolvedValue(makeRule());
      const qr = makeQueryRunner({ RuleEntity: { findOne } });

      await service.update(qr, TENANT, RULE_ID, {}, false, CURRENT_USER, META);

      expect(findOne).toHaveBeenCalledWith({ where: { id: RULE_ID, tenantId: TENANT } });
    });
  });

  describe("update — disable-reason guard", () => {
    it("rejects isActive:false with no reason when the rule is currently active", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ isActive: true })) } });

      await expectRejection(
        service.update(qr, TENANT, RULE_ID, { isActive: false }, false, CURRENT_USER, META),
        BadRequestException,
        "DISABLE_REASON_REQUIRED",
      );
    });

    it("rejects isActive:false with a whitespace-only reason", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ isActive: true })) } });

      await expectRejection(
        service.update(qr, TENANT, RULE_ID, { isActive: false, reason: "   " }, false, CURRENT_USER, META),
        BadRequestException,
        "DISABLE_REASON_REQUIRED",
      );
    });

    it("does not require a reason when the rule is already inactive (no active->inactive transition)", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ isActive: false })) } });

      await expect(service.update(qr, TENANT, RULE_ID, { isActive: false }, false, CURRENT_USER, META)).resolves.toBeDefined();
    });

    it("accepts isActive:false with a reason, recording rule.disable", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ isActive: true })) } });

      await service.update(qr, TENANT, RULE_ID, { isActive: false, reason: "false positives spiking" }, false, CURRENT_USER, META);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "rule.disable", afterState: expect.objectContaining({ isActive: false, reason: "false positives spiking" }) }),
      );
    });
  });

  describe("update — loosening-confirmation guard", () => {
    it("rejects a loosening config change without X-Confirm-Loosening", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await expectRejection(
        service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 8_000_000 } }, false, CURRENT_USER, META),
        UnprocessableEntityException,
        "LOOSENING_CONFIRMATION_REQUIRED",
      );
    });

    it("includes the changed keys in the 422 details", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      let caught: unknown;
      try {
        await service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 8_000_000 } }, false, CURRENT_USER, META);
      } catch (err) {
        caught = err;
      }
      expect((caught as { response?: unknown }).response).toMatchObject({ details: { changedKeys: ["thresholdIndividual"] } });
    });

    it("allows a loosening config change when confirmedLoosening is true", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await expect(
        service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 8_000_000 } }, true, CURRENT_USER, META),
      ).resolves.toBeDefined();
    });

    it("does not require confirmation for a tightening config change", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await expect(
        service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 3_000_000 } }, false, CURRENT_USER, META),
      ).resolves.toBeDefined();
    });

    it("does not require confirmation when no config is supplied at all", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule()) } });

      await expect(service.update(qr, TENANT, RULE_ID, { isActive: true }, false, CURRENT_USER, META)).resolves.toBeDefined();
    });

    it("merges the confirmed config into the existing config rather than replacing it", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000, minCount: 3 } })) },
      });

      const result = await service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 8_000_000 } }, true, CURRENT_USER, META);

      expect(result.config).toEqual({ thresholdIndividual: 8_000_000, minCount: 3 });
    });
  });

  describe("update — emitted event reflects loosening state", () => {
    it("emits RULE_EVENTS.UPDATED with isLoosening: true for a confirmed loosening change", async () => {
      const { service, eventEmitter } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 8_000_000 } }, true, CURRENT_USER, META);

      expect(eventEmitter.emit).toHaveBeenCalledWith(RULE_EVENTS.UPDATED, expect.objectContaining({ isLoosening: true, ruleId: RULE_ID }));
    });

    it("emits RULE_EVENTS.UPDATED with isLoosening: false for a non-loosening change", async () => {
      const { service, eventEmitter } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 3_000_000 } }, false, CURRENT_USER, META);

      expect(eventEmitter.emit).toHaveBeenCalledWith(RULE_EVENTS.UPDATED, expect.objectContaining({ isLoosening: false, ruleId: RULE_ID }));
    });
  });

  describe("update — audit action naming", () => {
    it("uses rule.update (not rule.disable) for a plain config change", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 3_000_000 } }, false, CURRENT_USER, META);

      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "rule.update" }));
    });

    it("uses rule.update, not rule.disable, when re-enabling a rule (isActive: true)", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ isActive: false })) } });

      await service.update(qr, TENANT, RULE_ID, { isActive: true }, false, CURRENT_USER, META);

      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "rule.update" }));
    });

    it("captures the before/after config on the audit row", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ RuleEntity: { findOne: jest.fn().mockResolvedValue(makeRule({ config: { thresholdIndividual: 5_000_000 } })) } });

      await service.update(qr, TENANT, RULE_ID, { config: { thresholdIndividual: 3_000_000 } }, false, CURRENT_USER, META);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          beforeState: { config: { thresholdIndividual: 5_000_000 }, isActive: true },
          afterState: expect.objectContaining({ config: { thresholdIndividual: 3_000_000 } }),
        }),
      );
    });
  });
});
