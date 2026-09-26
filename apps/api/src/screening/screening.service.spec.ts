import { ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CustomerEntity, ScreeningCheckEntity, TenantEntity } from "@regops/db";
import { ScoreTrigger, ScreeningCheckStatus, ScreeningCheckType, ScreeningProviderName, ScreeningResultType, ScreeningTrigger } from "@regops/shared";
import { ProviderTransientError, ScreeningInput, ScreeningResult } from "@regops/screening-engine";
import { AuditService } from "../audit/audit.service";
import { RiskService } from "../risk/risk.service";
import { AsyncScreeningQueueService } from "./async-screening-queue.service";
import { InternalBlacklistProvider } from "./providers/internal-blacklist.provider";
import { ProviderRegistry } from "./providers/provider.registry";
import { ScreeningService } from "./screening.service";

// --- Fake QueryRunner -------------------------------------------------------
// Same hand-built double as CasesService/AlertsService/RulesService's specs.
// ScreeningService also uses a SECOND, dedicated QueryRunner (its own
// `dataSource.createQueryRunner()`, not the caller's) for the sync sanctions
// path (`withDedicatedTenantContext`) — `dataSource` itself is mocked to hand
// back the same kind of fake QueryRunner double, with `connect`/`startTransaction`/
// `commitTransaction`/`rollbackTransaction`/`release`/`query` all present so
// that private method runs against it without touching a real DB.

interface RepoDouble {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneOrFail: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
}

/** where/andWhere/orderBy all return `this`, terminated by getOne(). Used by
 * findRecentCompletedCheck's dedup lookup. */
function makeQueryBuilder(getOneResult: unknown = null) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ["where", "andWhere", "orderBy"]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getOne = jest.fn().mockResolvedValue(getOneResult);
  return qb;
}

function makeRepo(overrides: Partial<RepoDouble> = {}): RepoDouble {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findOneOrFail: jest.fn(),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: unknown) => x),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    // Defaults to "no cached check found" so tests that don't care about dedup
    // (most of them — only the ScreeningCheckEntity dedup tests override this)
    // don't need to stub it themselves.
    createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(null)),
    ...overrides,
  };
}

function makeQueryRunner(repos: Record<string, Partial<RepoDouble>> = {}): QueryRunner {
  const cache = new Map<string, RepoDouble>();
  const getRepository = jest.fn((entity: { name: string }) => {
    if (!cache.has(entity.name)) cache.set(entity.name, makeRepo(repos[entity.name]));
    return cache.get(entity.name);
  });
  return {
    manager: { getRepository, query: jest.fn() },
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    isTransactionActive: true,
  } as unknown as QueryRunner;
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
const CUSTOMER_ID = "customer-1";

const INPUT: ScreeningInput = { fullName: "Jane Doe", dateOfBirth: null, bvn: null, nin: null, country: "NG", nationality: "NG" };

function makeTenant(overrides: Partial<TenantEntity> = {}): TenantEntity {
  return Object.assign(new TenantEntity(), { id: TENANT, config: {}, ...overrides });
}

function makeCustomer(overrides: Partial<CustomerEntity> = {}): CustomerEntity {
  return Object.assign(new CustomerEntity(), {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    fullName: "Jane Doe",
    dateOfBirth: null,
    bvn: null,
    nin: null,
    country: "NG",
    nationality: "NG",
    isSanctioned: false,
    ...overrides,
  });
}

function makeCleanResult(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    status: ScreeningResultType.CLEAN,
    highestMatchScore: 0,
    matches: [],
    providerReference: "ref-1",
    rawResponse: {},
    latencyMs: 100,
    ...overrides,
  };
}

function makeConfirmedResult(overrides: Partial<ScreeningResult> = {}): ScreeningResult {
  return {
    status: ScreeningResultType.CONFIRMED_MATCH,
    highestMatchScore: 95,
    matches: [{ listSource: "OFAC", matchName: "Jane Doe", matchScore: 95, matchData: {} }],
    providerReference: "ref-2",
    rawResponse: {},
    latencyMs: 100,
    ...overrides,
  };
}

function makeResolvedPrimary(screenImpl: jest.Mock) {
  return {
    primary: { provider: { name: ScreeningProviderName.MOCK, screen: screenImpl }, config: {} },
    fallback: undefined,
  };
}

function makeCachedCheck(overrides: Partial<ScreeningCheckEntity> = {}): ScreeningCheckEntity {
  return Object.assign(new ScreeningCheckEntity(), {
    id: "cached-check-1",
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    checkType: ScreeningCheckType.SANCTIONS,
    provider: ScreeningProviderName.MOCK,
    inputData: {},
    inputHash: "hash",
    status: ScreeningCheckStatus.COMPLETED,
    result: ScreeningResultType.CLEAN,
    highestMatchScore: 0,
    providerReference: null,
    rawResponse: null,
    errorMessage: null,
    latencyMs: 100,
    trigger: ScreeningTrigger.ONBOARDING,
    triggeredBy: null,
    startedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  });
}

function makeCollaborators() {
  const dataSource = { createQueryRunner: jest.fn() } as unknown as jest.Mocked<Pick<DataSource, "createQueryRunner">>;
  const internalBlacklistProvider = { check: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<InternalBlacklistProvider>;
  // Resolved unconditionally before the blacklist short-circuit check (Section 4.4's
  // note in the source) — always needs a default even in blacklist-hit tests.
  const providerRegistry = {
    resolve: jest.fn().mockResolvedValue({ primary: { provider: { name: ScreeningProviderName.MOCK, screen: jest.fn() }, config: {} }, fallback: undefined }),
  } as unknown as jest.Mocked<ProviderRegistry>;
  const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
  const asyncScreeningQueue = { enqueue: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AsyncScreeningQueueService>;
  const riskService = { calculateAndPersist: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<RiskService>;
  const auditService = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  return { dataSource, internalBlacklistProvider, providerRegistry, eventEmitter, asyncScreeningQueue, riskService, auditService };
}

function makeService() {
  const collaborators = makeCollaborators();
  const service = new ScreeningService(
    collaborators.dataSource as unknown as DataSource,
    collaborators.internalBlacklistProvider,
    collaborators.providerRegistry,
    collaborators.eventEmitter,
    collaborators.asyncScreeningQueue,
    collaborators.riskService,
    collaborators.auditService,
  );
  return { service, ...collaborators };
}

describe("ScreeningService", () => {
  describe("runCheckInline — dedup within the 1-hour window", () => {
    it("returns the cached check without calling the provider registry when a recent completed check exists", async () => {
      const { service, providerRegistry, internalBlacklistProvider } = makeService();
      const cached = makeCachedCheck();
      const qr = makeQueryRunner({
        ScreeningCheckEntity: { createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(cached)) },
        ScreeningMatchEntity: { find: jest.fn().mockResolvedValue([]) },
      });

      const result = await service.runCheckInline(qr, makeTenant(), ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.MANUAL, CUSTOMER_ID, "user-1");

      expect(result.check).toBe(cached);
      expect(providerRegistry.resolve).not.toHaveBeenCalled();
      expect(internalBlacklistProvider.check).not.toHaveBeenCalled();
    });

    it("does not dedup when customerId is null (the onboarding pre-screen path)", async () => {
      const { service, providerRegistry } = makeService();
      const screen = jest.fn().mockResolvedValue(makeCleanResult());
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const checkQueryBuilder = jest.fn();
      const qr = makeQueryRunner({ ScreeningCheckEntity: { createQueryBuilder: checkQueryBuilder } });

      await service.runCheckInline(qr, makeTenant(), ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, null, null);

      expect(checkQueryBuilder).not.toHaveBeenCalled();
      expect(providerRegistry.resolve).toHaveBeenCalled();
    });

    it("does not dedup — calls the provider — when the only completed check is outside the window (query itself scopes `since`, exercised by re-querying)", async () => {
      const { service, providerRegistry } = makeService();
      const screen = jest.fn().mockResolvedValue(makeCleanResult());
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      // A stale/expired cached check is modeled by the dedup query itself returning
      // null (its `started_at >= :since` filter already excludes it) — verifying the
      // provider is invoked in that case is the behavior under test.
      const qr = makeQueryRunner({
        ScreeningCheckEntity: { createQueryBuilder: jest.fn().mockReturnValue(makeQueryBuilder(null)) },
      });

      await service.runCheckInline(qr, makeTenant(), ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.MANUAL, CUSTOMER_ID, null);

      expect(providerRegistry.resolve).toHaveBeenCalled();
      expect(screen).toHaveBeenCalled();
    });
  });

  describe("runCheckInline — internal blacklist short-circuit", () => {
    it("uses the blacklist result and never calls the external provider on a hit", async () => {
      const { service, internalBlacklistProvider, providerRegistry } = makeService();
      internalBlacklistProvider.check.mockResolvedValue(makeConfirmedResult({ providerReference: "INTERNAL_BLACKLIST" }) as never);
      const screen = jest.fn();
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const qr = makeQueryRunner();

      const result = await service.runCheckInline(qr, makeTenant(), ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, null, null);

      expect(screen).not.toHaveBeenCalled();
      expect(result.check.result).toBe(ScreeningResultType.CONFIRMED_MATCH);
      expect(result.check.status).toBe(ScreeningCheckStatus.COMPLETED);
    });

    it("falls through to the external provider when there is no blacklist hit", async () => {
      const { service, providerRegistry } = makeService();
      const screen = jest.fn().mockResolvedValue(makeCleanResult());
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const qr = makeQueryRunner();

      await service.runCheckInline(qr, makeTenant(), ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, null, null);

      expect(screen).toHaveBeenCalled();
    });
  });

  describe("runCheckInline — fail-closed on provider outage", () => {
    // runCheckInline calls the real screenWithFallback with its default retry
    // schedule (1s, then 4s) — fake timers avoid actually sleeping ~5s here.
    it("persists a FAILED/ERROR check (not a throw) when the provider (and any fallback) is exhausted", async () => {
      jest.useFakeTimers();
      try {
        const { service, providerRegistry, auditService, eventEmitter } = makeService();
        const screen = jest.fn().mockRejectedValue(new ProviderTransientError("provider down"));
        providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
        const qr = makeQueryRunner();

        const resultPromise = service.runCheckInline(qr, makeTenant(), ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, null, null);
        await jest.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.check.status).toBe(ScreeningCheckStatus.FAILED);
        expect(result.check.result).toBe(ScreeningResultType.ERROR);
        expect(result.matches).toEqual([]);
        expect(auditService.record).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ afterState: expect.objectContaining({ status: ScreeningCheckStatus.FAILED }) }),
        );
        expect(eventEmitter.emit).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("screenSync — sanctions-block guard", () => {
    it("throws SANCTIONS_MATCH_BLOCK (422) before the caller can proceed with onboarding, and records the block on the audit trail", async () => {
      const { service, dataSource, internalBlacklistProvider, auditService } = makeService();
      internalBlacklistProvider.check.mockResolvedValue(makeConfirmedResult() as never);
      const qr = makeQueryRunner({ TenantEntity: { findOneOrFail: jest.fn().mockResolvedValue(makeTenant()) } });
      dataSource.createQueryRunner.mockReturnValue(qr as never);

      await expectRejection(
        service.screenSync(TENANT, ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, "user-1"),
        UnprocessableEntityException,
        "SANCTIONS_MATCH_BLOCK",
      );

      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "customer.create.blocked" }));
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("does not throw, and does not record a block, when the result is CLEAN", async () => {
      const { service, dataSource, providerRegistry, auditService } = makeService();
      const screen = jest.fn().mockResolvedValue(makeCleanResult());
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const qr = makeQueryRunner({ TenantEntity: { findOneOrFail: jest.fn().mockResolvedValue(makeTenant()) } });
      dataSource.createQueryRunner.mockReturnValue(qr as never);

      const outcome = await service.screenSync(TENANT, ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, "user-1");

      expect(outcome.check.result).toBe(ScreeningResultType.CLEAN);
      expect(auditService.record).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "customer.create.blocked" }));
    });

    it("does not throw on a POTENTIAL_MATCH — onboarding proceeds, review happens later", async () => {
      const { service, dataSource, providerRegistry } = makeService();
      const screen = jest.fn().mockResolvedValue(makeCleanResult({ status: ScreeningResultType.POTENTIAL_MATCH, highestMatchScore: 70 }));
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const qr = makeQueryRunner({ TenantEntity: { findOneOrFail: jest.fn().mockResolvedValue(makeTenant()) } });
      dataSource.createQueryRunner.mockReturnValue(qr as never);

      await expect(service.screenSync(TENANT, ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, "user-1")).resolves.toBeDefined();
    });
  });

  describe("screenSync — fail-closed on provider outage", () => {
    // Real screenWithFallback retry schedule (1s, 4s) runs underneath — fake
    // timers avoid actually sleeping ~5s.
    it("throws SCREENING_PROVIDER_UNAVAILABLE (503) — never proceeds with onboarding when screening itself failed", async () => {
      jest.useFakeTimers();
      try {
        const { service, dataSource, providerRegistry } = makeService();
        const screen = jest.fn().mockRejectedValue(new ProviderTransientError("provider down"));
        providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
        const qr = makeQueryRunner({ TenantEntity: { findOneOrFail: jest.fn().mockResolvedValue(makeTenant()) } });
        dataSource.createQueryRunner.mockReturnValue(qr as never);

        const promise = service.screenSync(TENANT, ScreeningCheckType.SANCTIONS, INPUT, ScreeningTrigger.ONBOARDING, "user-1");
        promise.catch(() => undefined); // silence the unhandled-rejection warning while timers advance
        await jest.runAllTimersAsync();
        await expectRejection(promise, ServiceUnavailableException, "SCREENING_PROVIDER_UNAVAILABLE");

        // The failed check itself still commits on the dedicated connection —
        // fail-closed means the CALLER is blocked, not that the audit evidence is lost.
        expect(qr.commitTransaction).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("screenExistingCustomerSanctions — auto-flag on confirmed match", () => {
    it("flags an existing customer sanctioned, re-scores, and emits SANCTIONS_FLAGGED, without ever throwing", async () => {
      const { service, providerRegistry, riskService, eventEmitter, auditService } = makeService();
      const screen = jest.fn().mockResolvedValue(makeConfirmedResult());
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const customer = makeCustomer({ isSanctioned: false });
      const qr = makeQueryRunner({
        CustomerEntity: { findOneOrFail: jest.fn().mockResolvedValue({ ...customer, isSanctioned: true }) },
      });

      const outcome = await service.screenExistingCustomerSanctions(qr, makeTenant(), customer, "user-1");

      expect(outcome.check.result).toBe(ScreeningResultType.CONFIRMED_MATCH);
      expect(riskService.calculateAndPersist).toHaveBeenCalledWith(qr, expect.objectContaining({ id: CUSTOMER_ID }), ScoreTrigger.SCREENING_MATCH, null);
      expect(eventEmitter.emit).toHaveBeenCalledWith("customer.sanctions_flagged", expect.objectContaining({ customerId: CUSTOMER_ID }));
      expect(auditService.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "customer.sanctions_flagged" }));
    });

    it("does not re-flag or re-score a customer that is already marked sanctioned", async () => {
      const { service, riskService, providerRegistry, eventEmitter } = makeService();
      const screen = jest.fn().mockResolvedValue(makeConfirmedResult());
      providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
      const customer = makeCustomer({ isSanctioned: true });
      const qr = makeQueryRunner();

      await service.screenExistingCustomerSanctions(qr, makeTenant(), customer, "user-1");

      expect(riskService.calculateAndPersist).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith("customer.sanctions_flagged", expect.anything());
    });

    it("throws SCREENING_PROVIDER_UNAVAILABLE (503) on a provider outage, same as the sync onboarding path", async () => {
      jest.useFakeTimers();
      try {
        const { service, providerRegistry } = makeService();
        const screen = jest.fn().mockRejectedValue(new ProviderTransientError("provider down"));
        providerRegistry.resolve.mockResolvedValue(makeResolvedPrimary(screen) as never);
        const customer = makeCustomer({ isSanctioned: false });
        const qr = makeQueryRunner();

        const promise = service.screenExistingCustomerSanctions(qr, makeTenant(), customer, "user-1");
        promise.catch(() => undefined);
        await jest.runAllTimersAsync();
        await expectRejection(promise, ServiceUnavailableException, "SCREENING_PROVIDER_UNAVAILABLE");
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
