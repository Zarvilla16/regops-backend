import { NotFoundException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { CustomerEntity, RiskFactorConfigEntity } from "@regops/db";
import { AuthUserContext, CustomerType, RiskLevel, ScoreTrigger, UserRole } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskFactorConfigService } from "./config/risk-factor-config.service";
import { RiskService } from "./risk.service";

// --- Fake QueryRunner -------------------------------------------------------
// Same hand-built double as the other specs in this codebase. calculateAndPersist
// calls the REAL risk-engine (createFactorRegistry/runFactors/aggregateRiskScore —
// static imports, not injected, so they can't be swapped for a double) — that
// package's own factor logic (weighting, PEP/sanctioned CRITICAL override) is
// already 100% covered by its own spec files. What's under test here is
// RiskService's OWN orchestration around it: which trigger sets calculatedBy,
// when the risk_changed event fires, and that isPep/isSanctioned actually reach
// aggregateRiskScore's override (verified by leaving riskFactorConfigService's
// config list empty, so every factor's own math contributes nothing (contextless
// factors are skipped per run-factors.ts's null-context contract) and the
// resulting CRITICAL level can only have come from the override, not a factor).

interface RepoDouble {
  find: jest.Mock;
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
}

function makeRepo(overrides: Partial<RepoDouble> = {}): RepoDouble {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: unknown) => x),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
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

// --- Fixtures ---------------------------------------------------------------

const TENANT = "tenant-1";
const CUSTOMER_ID = "customer-1";
const CURRENT_USER: AuthUserContext = { sub: "user-1", tenantId: TENANT, role: UserRole.COMPLIANCE_OFFICER, email: "officer@demomfb.dev" };

function makeCustomer(overrides: Partial<CustomerEntity> = {}): CustomerEntity {
  return Object.assign(new CustomerEntity(), {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    customerType: CustomerType.INDIVIDUAL,
    occupation: null,
    country: "NG",
    nationality: "NG",
    kycTier: 1,
    isPep: false,
    isSanctioned: false,
    riskScore: 10,
    riskLevel: RiskLevel.LOW,
    lastRiskCalculatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

function makeAuditService(): jest.Mocked<Pick<AuditService, "record">> {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

function makeEventEmitter(): jest.Mocked<Pick<EventEmitter2, "emit">> {
  return { emit: jest.fn() };
}

function makeRiskFactorConfigService(configs: RiskFactorConfigEntity[] = []): jest.Mocked<Pick<RiskFactorConfigService, "findActiveForTenant">> {
  return { findActiveForTenant: jest.fn().mockResolvedValue(configs) };
}

function makeService(configs: RiskFactorConfigEntity[] = []) {
  const auditService = makeAuditService();
  const eventEmitter = makeEventEmitter();
  const riskFactorConfigService = makeRiskFactorConfigService(configs);
  // velocityAdapterService omitted (@Optional()) — none of these tests supply
  // a TRANSACTION_VELOCITY config row, so it's never consulted.
  const service = new RiskService(
    riskFactorConfigService as unknown as RiskFactorConfigService,
    auditService as unknown as AuditService,
    eventEmitter as unknown as EventEmitter2,
  );
  return { service, auditService, eventEmitter, riskFactorConfigService };
}

describe("RiskService", () => {
  describe("calculateAndPersist — PEP/sanctioned CRITICAL override reaches the aggregator", () => {
    it("forces CRITICAL for a PEP customer even with zero contributing factors", async () => {
      const { service } = makeService([]); // no configs -> every factor context is null -> skipped
      const qr = makeQueryRunner();
      const customer = makeCustomer({ isPep: true, riskLevel: RiskLevel.LOW });

      const history = await service.calculateAndPersist(qr, customer, ScoreTrigger.MANUAL, "user-1");

      expect(history.level).toBe(RiskLevel.CRITICAL);
      expect(history.factors).toMatchObject({ override: "PEP_FLAG" });
    });

    it("forces CRITICAL for a sanctioned (non-PEP) customer the same way", async () => {
      const { service } = makeService([]);
      const qr = makeQueryRunner();
      const customer = makeCustomer({ isPep: false, isSanctioned: true, riskLevel: RiskLevel.LOW });

      const history = await service.calculateAndPersist(qr, customer, ScoreTrigger.MANUAL, "user-1");

      expect(history.level).toBe(RiskLevel.CRITICAL);
    });

    it("does not override a customer who is neither PEP nor sanctioned", async () => {
      const { service } = makeService([]);
      const qr = makeQueryRunner();
      const customer = makeCustomer({ isPep: false, isSanctioned: false });

      const history = await service.calculateAndPersist(qr, customer, ScoreTrigger.MANUAL, "user-1");

      expect(history.level).toBe(RiskLevel.LOW);
      expect(history.factors).not.toHaveProperty("override");
    });
  });

  describe("calculateAndPersist — calculatedBy is trigger-scoped", () => {
    it("records calculatedBy only for a MANUAL trigger", async () => {
      const { service } = makeService([]);
      const qr = makeQueryRunner();

      const history = await service.calculateAndPersist(qr, makeCustomer(), ScoreTrigger.MANUAL, "user-1");

      expect(history.calculatedBy).toBe("user-1");
    });

    it.each([ScoreTrigger.SCHEDULED, ScoreTrigger.TRANSACTION_ACTIVITY, ScoreTrigger.INITIAL, ScoreTrigger.CUSTOMER_UPDATED, ScoreTrigger.SCREENING_MATCH])(
      "nulls out calculatedBy for a %s trigger even when a caller id is passed",
      async (trigger) => {
        const { service } = makeService([]);
        const qr = makeQueryRunner();

        const history = await service.calculateAndPersist(qr, makeCustomer(), trigger, "some-actor-id");

        expect(history.calculatedBy).toBeNull();
      },
    );
  });

  describe("calculateAndPersist — writes history unconditionally, updates the cached customer fields, and emits only on a level transition", () => {
    it("writes a RiskScoreHistory row and updates the customer cache even when the level does not change", async () => {
      const { service, eventEmitter } = makeService([]);
      const customerRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
      const qr = makeQueryRunner({ CustomerEntity: customerRepo });
      const customer = makeCustomer({ riskLevel: RiskLevel.LOW, isPep: false, isSanctioned: false });

      const history = await service.calculateAndPersist(qr, customer, ScoreTrigger.SCHEDULED, null);

      expect(history.level).toBe(RiskLevel.LOW);
      expect(customerRepo.update).toHaveBeenCalledWith(
        { id: CUSTOMER_ID },
        expect.objectContaining({ riskLevel: RiskLevel.LOW, riskScore: history.score }),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("emits customer.risk_changed with before/after levels when the level actually transitions", async () => {
      const { service, eventEmitter } = makeService([]);
      const qr = makeQueryRunner();
      const customer = makeCustomer({ riskLevel: RiskLevel.LOW, isPep: true }); // forced CRITICAL by the override

      const history = await service.calculateAndPersist(qr, customer, ScoreTrigger.SCHEDULED, null);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        "customer.risk_changed",
        expect.objectContaining({
          tenantId: TENANT,
          customerId: CUSTOMER_ID,
          previousLevel: RiskLevel.LOW,
          newLevel: RiskLevel.CRITICAL,
          riskScoreHistoryId: history.id,
        }),
      );
    });

    it("records the previousScore/previousLevel on the history row from the customer's cached fields", async () => {
      const { service } = makeService([]);
      const qr = makeQueryRunner();
      const customer = makeCustomer({ riskScore: 42, riskLevel: RiskLevel.MEDIUM });

      const history = await service.calculateAndPersist(qr, customer, ScoreTrigger.SCHEDULED, null);

      expect(history.previousScore).toBe(42);
      expect(history.previousLevel).toBe(RiskLevel.MEDIUM);
    });
  });

  describe("re-score entry points — each writes its own dedicated audit action", () => {
    it("rescoreManual writes risk.rescore.manual", async () => {
      const { service, auditService } = makeService([]);
      const qr = makeQueryRunner();

      await service.rescoreManual(qr, makeCustomer(), CURRENT_USER);

      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "risk.rescore.manual", userId: CURRENT_USER.sub }));
    });

    it("rescoreScheduled writes risk.rescore.scheduled with a null userId", async () => {
      const { service, auditService } = makeService([]);
      const qr = makeQueryRunner();

      await service.rescoreScheduled(qr, makeCustomer());

      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "risk.rescore.scheduled", userId: null }));
    });

    it("rescoreEventTriggered writes risk.rescore.transaction_activity with a null userId", async () => {
      const { service, auditService } = makeService([]);
      const qr = makeQueryRunner();

      await service.rescoreEventTriggered(qr, makeCustomer());

      expect(auditService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "risk.rescore.transaction_activity", userId: null }),
      );
    });
  });

  describe("findHistoryForCustomer — tenant guard", () => {
    it("throws CUSTOMER_NOT_FOUND when the customer doesn't exist in this tenant", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CustomerEntity: { findOne: jest.fn().mockResolvedValue(null) } });

      let caught: unknown;
      try {
        await service.findHistoryForCustomer(qr, TENANT, CUSTOMER_ID, 1, 20);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotFoundException);
      expect((caught as { response?: unknown }).response).toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
    });

    it("scopes both the customer lookup and the history query by tenantId", async () => {
      const { service } = makeService();
      const customerFindOne = jest.fn().mockResolvedValue(makeCustomer());
      const historyFindAndCount = jest.fn().mockResolvedValue([[], 0]);
      const qr = makeQueryRunner({
        CustomerEntity: { findOne: customerFindOne },
        RiskScoreHistoryEntity: { findAndCount: historyFindAndCount },
      });

      await service.findHistoryForCustomer(qr, TENANT, CUSTOMER_ID, 2, 10);

      expect(customerFindOne).toHaveBeenCalledWith({ where: { tenantId: TENANT, id: CUSTOMER_ID } });
      expect(historyFindAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: TENANT, customerId: CUSTOMER_ID }, skip: 10, take: 10 }),
      );
    });
  });
});
