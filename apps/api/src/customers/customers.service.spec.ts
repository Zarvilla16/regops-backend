import { BadRequestException, ConflictException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { QueryRunner } from "typeorm";
import { CustomerEntity, PepDetailsEntity, ScreeningCheckEntity } from "@regops/db";
import {
  AuthUserContext,
  CustomerStatus,
  CustomerType,
  PepCategory,
  PepStatus,
  RiskLevel,
  ScoreTrigger,
  ScreeningCheckStatus,
  ScreeningCheckType,
  ScreeningResultType,
  UserRole,
} from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskService } from "../risk/risk.service";
import { ScreeningService } from "../screening/screening.service";
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

// --- Fake QueryRunner -------------------------------------------------------
// Same hand-built double as CasesService/RulesService/RiskService's specs.
// create()/update()/softDelete()/approvePep() all do `startTransaction()`
// themselves partway through (guards run BEFORE it opens), so `isTransactionActive`
// is tracked so a caught error can correctly decide whether to roll back —
// exactly CasesService's own reasoning, reused here since CustomersService has
// the identical guard-before-transaction shape.

interface RepoDouble {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneOrFail: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function makeRepo(overrides: Partial<RepoDouble> = {}): RepoDouble {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findOneOrFail: jest.fn(),
    create: jest.fn((x: unknown) => x),
    save: jest.fn(async (x: unknown) => x),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function makeQueryRunner(repos: Record<string, Partial<RepoDouble>> = {}): QueryRunner {
  const cache = new Map<string, RepoDouble>();
  const getRepository = jest.fn((entity: { name: string }) => {
    if (!cache.has(entity.name)) cache.set(entity.name, makeRepo(repos[entity.name]));
    return cache.get(entity.name);
  });
  let isTransactionActive = false;
  return {
    manager: { getRepository, query: jest.fn() },
    startTransaction: jest.fn().mockImplementation(async () => {
      isTransactionActive = true;
    }),
    commitTransaction: jest.fn().mockImplementation(async () => {
      isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn().mockImplementation(async () => {
      isTransactionActive = false;
    }),
    get isTransactionActive() {
      return isTransactionActive;
    },
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
const CURRENT_USER: AuthUserContext = { sub: "user-1", tenantId: TENANT, role: UserRole.COMPLIANCE_OFFICER, email: "officer@demomfb.dev" };
const META = { ipAddress: null, userAgent: null };

function makeCreateDto(overrides: Partial<CreateCustomerDto> = {}): CreateCustomerDto {
  return {
    cbsCustomerId: "cbs-1",
    fullName: "Jane Doe",
    customerType: CustomerType.INDIVIDUAL,
    kycTier: 1,
    onboardedAt: "2026-01-01",
    ...overrides,
  } as CreateCustomerDto;
}

function makePepDetailsDto() {
  return {
    pepCategory: PepCategory.DOMESTIC,
    pepPosition: "Senator",
    pepInstitution: "National Assembly",
    pepCountry: "NG",
    pepStatus: PepStatus.CURRENT,
    pepStartDate: "2020-01-01",
    sourceOfWealth: "Salary",
    nextReviewDate: "2027-01-01",
  };
}

function makeCustomer(overrides: Partial<CustomerEntity> = {}): CustomerEntity {
  return Object.assign(new CustomerEntity(), {
    id: CUSTOMER_ID,
    tenantId: TENANT,
    cbsCustomerId: "cbs-1",
    bvn: null,
    nin: null,
    fullName: "Jane Doe",
    email: null,
    phone: null,
    dateOfBirth: null,
    customerType: CustomerType.INDIVIDUAL,
    occupation: null,
    country: "NG",
    nationality: null,
    kycTier: 1,
    riskScore: 10,
    riskLevel: RiskLevel.LOW,
    lastRiskCalculatedAt: new Date("2026-01-01T00:00:00.000Z"),
    isPep: false,
    isSanctioned: false,
    lastScreenedAt: null,
    status: CustomerStatus.ACTIVE,
    photoUrl: null,
    onboardedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  });
}

function makeScreeningCheck(overrides: Partial<ScreeningCheckEntity> = {}): ScreeningCheckEntity {
  return Object.assign(new ScreeningCheckEntity(), {
    id: "check-1",
    tenantId: TENANT,
    customerId: null,
    checkType: ScreeningCheckType.SANCTIONS,
    status: ScreeningCheckStatus.COMPLETED,
    result: ScreeningResultType.CLEAN,
    ...overrides,
  });
}

function makeCollaborators() {
  const riskService = { calculateAndPersist: jest.fn().mockResolvedValue({ id: "history-1" }) } as unknown as jest.Mocked<RiskService>;
  const auditService = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  const eventEmitter = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
  const screeningService = {
    screenSync: jest.fn().mockResolvedValue({ check: makeScreeningCheck(), matches: [] }),
    attachCustomer: jest.fn().mockResolvedValue(undefined),
    enqueueAsync: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ScreeningService>;
  return { riskService, auditService, eventEmitter, screeningService };
}

function makeService() {
  const collaborators = makeCollaborators();
  const service = new CustomersService(collaborators.riskService, collaborators.auditService, collaborators.eventEmitter, collaborators.screeningService);
  return { service, ...collaborators };
}

describe("CustomersService", () => {
  describe("create — PEP-onboarding-requires-approval gate", () => {
    it("rejects a PEP customerType with no pepDetails, before ever calling the screening provider", async () => {
      const { service, screeningService } = makeService();
      const qr = makeQueryRunner();

      await expectRejection(
        service.create(qr, TENANT, makeCreateDto({ customerType: CustomerType.PEP }), CURRENT_USER, META),
        BadRequestException,
        "PEP_DETAILS_REQUIRED",
      );
      expect(screeningService.screenSync).not.toHaveBeenCalled();
    });

    it("rejects isPep:true with an otherwise non-PEP customerType and no pepDetails", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner();

      await expectRejection(
        service.create(qr, TENANT, makeCreateDto({ customerType: CustomerType.INDIVIDUAL, isPep: true }), CURRENT_USER, META),
        BadRequestException,
        "PEP_DETAILS_REQUIRED",
      );
    });

    it("routes a PEP customer (with pepDetails) to PENDING_EDD_APPROVAL, isPep true, and persists pep_details", async () => {
      const { service } = makeService();
      const pepRepo = { save: jest.fn(async (x: unknown) => x) };
      const qr = makeQueryRunner({
        CustomerEntity: { findOneOrFail: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.PENDING_EDD_APPROVAL, isPep: true })) },
        PepDetailsEntity: pepRepo,
      });

      const dto = makeCreateDto({ customerType: CustomerType.PEP, pepDetails: makePepDetailsDto() as never });
      const result = await service.create(qr, TENANT, dto, CURRENT_USER, META);

      expect(result.status).toBe(CustomerStatus.PENDING_EDD_APPROVAL);
      expect(result.isPep).toBe(true);
      expect(pepRepo.save).toHaveBeenCalledWith(expect.objectContaining({ pepCategory: PepCategory.DOMESTIC, isPepByAssociation: false }));
    });

    it("routes a non-PEP customer straight to ACTIVE", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: { findOneOrFail: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.ACTIVE, isPep: false })) },
      });

      const result = await service.create(qr, TENANT, makeCreateDto(), CURRENT_USER, META);

      expect(result.status).toBe(CustomerStatus.ACTIVE);
      expect(result.isPep).toBe(false);
    });

    it("still blocks onboarding on a sanctions match even for a PEP with complete pepDetails", async () => {
      const { service, screeningService } = makeService();
      screeningService.screenSync.mockRejectedValue(
        Object.assign(new Error("blocked"), { response: { code: "SANCTIONS_MATCH_BLOCK" } }),
      );
      const qr = makeQueryRunner();

      let caught: unknown;
      try {
        await service.create(qr, TENANT, makeCreateDto({ customerType: CustomerType.PEP, pepDetails: makePepDetailsDto() as never }), CURRENT_USER, META);
      } catch (err) {
        caught = err;
      }
      expect((caught as { response?: unknown }).response).toMatchObject({ code: "SANCTIONS_MATCH_BLOCK" });
      // Never opened the row-creating transaction — the sync sanctions pre-screen runs BEFORE it.
      expect(qr.startTransaction).not.toHaveBeenCalled();
    });
  });

  describe("create — duplicate guards (checked before the sanctions pre-screen)", () => {
    it("rejects a duplicate cbsCustomerId without calling the screening provider", async () => {
      const { service, screeningService } = makeService();
      const qr = makeQueryRunner({ CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer()) } });

      await expectRejection(service.create(qr, TENANT, makeCreateDto(), CURRENT_USER, META), ConflictException, "CUSTOMER_CBS_ID_TAKEN");
      expect(screeningService.screenSync).not.toHaveBeenCalled();
    });

    it("rejects a duplicate bvn", async () => {
      const { service } = makeService();
      const findOne = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(makeCustomer({ bvn: "12345678901" }));
      const qr = makeQueryRunner({ CustomerEntity: { findOne } });

      await expectRejection(service.create(qr, TENANT, makeCreateDto({ bvn: "12345678901" }), CURRENT_USER, META), ConflictException, "CUSTOMER_BVN_TAKEN");
    });
  });

  describe("create — rolls back the row-creation transaction on a later failure", () => {
    it("rolls back when calculateAndPersist throws after the customer row was already created", async () => {
      const { service, riskService } = makeService();
      riskService.calculateAndPersist.mockRejectedValue(new Error("factor blew up"));
      const qr = makeQueryRunner();

      await expect(service.create(qr, TENANT, makeCreateDto(), CURRENT_USER, META)).rejects.toThrow("factor blew up");
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe("update — PENDING_EDD_APPROVAL PATCH guards", () => {
    it("rejects PATCHing status directly to PENDING_EDD_APPROVAL", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.ACTIVE })) } });

      await expectRejection(
        service.update(qr, TENANT, CUSTOMER_ID, { status: CustomerStatus.PENDING_EDD_APPROVAL } as UpdateCustomerDto, CURRENT_USER, META),
        BadRequestException,
        "STATUS_NOT_DIRECTLY_SETTABLE",
      );
    });

    it("rejects any PATCH that touches status on a customer already pending EDD approval", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.PENDING_EDD_APPROVAL })) },
      });

      await expectRejection(
        service.update(qr, TENANT, CUSTOMER_ID, { status: CustomerStatus.ACTIVE } as UpdateCustomerDto, CURRENT_USER, META),
        ConflictException,
        "PEP_APPROVAL_REQUIRED",
      );
    });

    it("allows a PATCH that does not touch status on a customer pending EDD approval", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: {
          findOne: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.PENDING_EDD_APPROVAL })),
          findOneOrFail: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.PENDING_EDD_APPROVAL, phone: "0800000000" })),
        },
      });

      await expect(service.update(qr, TENANT, CUSTOMER_ID, { phone: "0800000000" }, CURRENT_USER, META)).resolves.toBeDefined();
    });
  });

  describe("update — re-score only on scoring-relevant field changes", () => {
    it("re-scores (CUSTOMER_UPDATED) when a scoring-relevant field changes", async () => {
      const { service, riskService } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer()), findOneOrFail: jest.fn().mockResolvedValue(makeCustomer()) },
      });

      await service.update(qr, TENANT, CUSTOMER_ID, { occupation: "Trader" }, CURRENT_USER, META);

      expect(riskService.calculateAndPersist).toHaveBeenCalledWith(qr, expect.anything(), ScoreTrigger.CUSTOMER_UPDATED, null);
    });

    it("does not re-score when only non-scoring fields change", async () => {
      const { service, riskService } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer()), findOneOrFail: jest.fn().mockResolvedValue(makeCustomer()) },
      });

      await service.update(qr, TENANT, CUSTOMER_ID, { email: "new@demomfb.dev", phone: "0800000000" }, CURRENT_USER, META);

      expect(riskService.calculateAndPersist).not.toHaveBeenCalled();
    });

    it.each(["customerType", "country", "nationality", "kycTier", "isPep", "isSanctioned"] as const)(
      "treats %s as scoring-relevant",
      async (field) => {
        const { service, riskService } = makeService();
        const qr = makeQueryRunner({
          CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer()), findOneOrFail: jest.fn().mockResolvedValue(makeCustomer()) },
        });
        const patch = { [field]: field === "kycTier" ? 2 : field === "isPep" || field === "isSanctioned" ? true : "XX" } as UpdateCustomerDto;

        await service.update(qr, TENANT, CUSTOMER_ID, patch, CURRENT_USER, META);

        expect(riskService.calculateAndPersist).toHaveBeenCalled();
      },
    );
  });

  describe("approvePep — transition guard", () => {
    it("rejects approving a customer that isn't pending EDD approval", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.ACTIVE })) },
        PepDetailsEntity: { findOneOrFail: jest.fn().mockResolvedValue(Object.assign(new PepDetailsEntity(), { id: "pep-1", customerId: CUSTOMER_ID })) },
      });

      await expectRejection(service.approvePep(qr, TENANT, CUSTOMER_ID, CURRENT_USER, META), ConflictException, "CUSTOMER_NOT_PENDING_EDD_APPROVAL");
    });

    it("approves a pending customer, setting status ACTIVE and stamping edd approval fields", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({
        CustomerEntity: {
          findOne: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.PENDING_EDD_APPROVAL })),
          findOneOrFail: jest.fn().mockResolvedValue(makeCustomer({ status: CustomerStatus.ACTIVE })),
        },
        PepDetailsEntity: { findOneOrFail: jest.fn().mockResolvedValue(Object.assign(new PepDetailsEntity(), { id: "pep-1", customerId: CUSTOMER_ID })) },
      });

      const result = await service.approvePep(qr, TENANT, CUSTOMER_ID, CURRENT_USER, META);

      expect(result.status).toBe(CustomerStatus.ACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "customer.pep_approved", afterState: expect.objectContaining({ eddApprovedBy: CURRENT_USER.sub }) }),
      );
    });
  });

  describe("PII reveal — masked by default, unmasked (with audit) via findOnePii", () => {
    it("findOne masks bvn/nin", async () => {
      const { service } = makeService();
      const qr = makeQueryRunner({ CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ bvn: "12345678901", nin: "98765432109" })) } });

      const result = await service.findOne(qr, TENANT, CUSTOMER_ID);

      expect(result.bvn).toBe("*******8901");
      expect(result.nin).toBe("*******2109");
    });

    it("findOnePii returns unmasked bvn/nin and records the reveal reason on the audit trail", async () => {
      const { service, auditService } = makeService();
      const qr = makeQueryRunner({ CustomerEntity: { findOne: jest.fn().mockResolvedValue(makeCustomer({ bvn: "12345678901", nin: "98765432109" })) } });

      const result = await service.findOnePii(qr, TENANT, CUSTOMER_ID, CURRENT_USER, "KYC review", META);

      expect(result.bvn).toBe("12345678901");
      expect(result.nin).toBe("98765432109");
      expect(auditService.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "customer.pii.view", afterState: { reason: "KYC review" } }),
      );
    });
  });
});
