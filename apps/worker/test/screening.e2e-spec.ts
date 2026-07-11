import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { DataSource } from "typeorm";
import {
  entities,
  CustomerEntity,
  InternalBlacklistEntity,
  RiskFactorConfigEntity,
  RiskScoreHistoryEntity,
  ScreeningCheckEntity,
  ScreeningMatchEntity,
  ScreeningProviderConfigEntity,
  TenantEntity,
} from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import {
  CustomerStatus,
  CustomerType,
  RiskLevel,
  ScreeningCheckType,
  ScreeningProviderName,
  ScreeningTrigger,
  TenantStatus,
  TenantType,
} from "@regops/shared";
import { processAsyncScreeningJob } from "../src/screening/async-screening.processor";
import { processRescreenJob } from "../src/screening/rescreen-job.processor";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

describe("Screening worker processors (e2e)", () => {
  let dataSource: DataSource;
  let tenantId: string;

  beforeAll(async () => {
    dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_ADMIN_URL, entities });
    await dataSource.initialize();

    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `Screening Worker Test Tenant ${Date.now()}`,
        type: TenantType.MFB,
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    const riskConfigRepo = dataSource.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      await riskConfigRepo.save(
        riskConfigRepo.create({ tenantId, factorType: defaults.factorType, weight: defaults.weight, config: defaults.config, isActive: true }),
      );
    }

    const providerRepo = dataSource.getRepository(ScreeningProviderConfigEntity);
    for (const checkType of [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA]) {
      await providerRepo.save(
        providerRepo.create({
          tenantId,
          checkType,
          provider: ScreeningProviderName.MOCK,
          isPrimary: true,
          isFallback: false,
          credentialsRef: "env://MOCK_UNUSED",
          config: {},
          isActive: true,
        }),
      );
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function createCustomer(overrides: Partial<CustomerEntity> & { fullName: string }): Promise<CustomerEntity> {
    const repo = dataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId: `CUST-SCR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 1,
        riskScore: 0,
        riskLevel: RiskLevel.LOW,
        isPep: false,
        isSanctioned: false,
        status: CustomerStatus.ACTIVE,
        onboardedAt: new Date(),
        ...overrides,
      }),
    );
  }

  // --- Section 10.5: async PEP flow -----------------------------------------
  describe("processAsyncScreeningJob", () => {
    it("flags PEP, re-scores to CRITICAL, and records a pending-review match for a CONFIRMED_MATCH", async () => {
      const customer = await createCustomer({ fullName: "Jane PEP Smith" });

      const result = await processAsyncScreeningJob(dataSource, {
        tenantId,
        customerId: customer.id,
        checkTypes: [ScreeningCheckType.PEP],
        trigger: ScreeningTrigger.ONBOARDING,
      });

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].result).toBe("CONFIRMED_MATCH");
      expect(result.outcomes[0].pepFlagged).toBe(true);

      const updated = await dataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customer.id } });
      expect(updated.isPep).toBe(true);
      expect(updated.riskLevel).toBe(RiskLevel.CRITICAL);

      const matches = await dataSource.getRepository(ScreeningMatchEntity).find({ where: { customerId: customer.id } });
      expect(matches).toHaveLength(1);
      expect(matches[0].reviewStatus).toBe("PENDING_REVIEW");
      expect(matches[0].listSource).toBe("DOMESTIC_PEP");
    });

    it("does not auto-flag on a POTENTIAL_MATCH — only creates a pending review row", async () => {
      const customer = await createCustomer({ fullName: "Someone POSSIBLY_SANCTIONED Else" });

      const result = await processAsyncScreeningJob(dataSource, {
        tenantId,
        customerId: customer.id,
        checkTypes: [ScreeningCheckType.SANCTIONS],
        trigger: ScreeningTrigger.ONBOARDING,
      });

      expect(result.outcomes[0].result).toBe("POTENTIAL_MATCH");

      const updated = await dataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customer.id } });
      expect(updated.isSanctioned).toBe(false);

      const matches = await dataSource.getRepository(ScreeningMatchEntity).find({ where: { customerId: customer.id } });
      expect(matches).toHaveLength(1);
      expect(matches[0].reviewStatus).toBe("PENDING_REVIEW");
    });

    it("leaves a clean customer entirely unflagged with no match rows", async () => {
      const customer = await createCustomer({ fullName: "Ordinary Person" });

      const result = await processAsyncScreeningJob(dataSource, {
        tenantId,
        customerId: customer.id,
        checkTypes: [ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA],
        trigger: ScreeningTrigger.ONBOARDING,
      });

      expect(result.outcomes.every((o) => o.result === "CLEAN")).toBe(true);
      expect(result.outcomes.every((o) => o.matchIds.length === 0)).toBe(true);

      const updated = await dataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customer.id } });
      expect(updated.isPep).toBe(false);
      expect(updated.isSanctioned).toBe(false);
    });

    it("ADVERSE_MEDIA never auto-flags even on a CONFIRMED_MATCH-shaped name — always goes to review (Section 5.2)", async () => {
      // MockProvider's PEP trigger also fires for ADVERSE_MEDIA checks (it's
      // driven by fullName only, not checkType) — this is exactly the case
      // Section 5.2 says must still go to review with no automatic flag.
      const customer = await createCustomer({ fullName: "Adverse PEP Media" });

      const result = await processAsyncScreeningJob(dataSource, {
        tenantId,
        customerId: customer.id,
        checkTypes: [ScreeningCheckType.ADVERSE_MEDIA],
        trigger: ScreeningTrigger.ONBOARDING,
      });

      expect(result.outcomes[0].result).toBe("CONFIRMED_MATCH");
      expect(result.outcomes[0].pepFlagged).toBe(false);

      const updated = await dataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customer.id } });
      expect(updated.isPep).toBe(false);
      expect(updated.isSanctioned).toBe(false);

      const matches = await dataSource.getRepository(ScreeningMatchEntity).find({ where: { customerId: customer.id } });
      expect(matches).toHaveLength(1);
      expect(matches[0].reviewStatus).toBe("PENDING_REVIEW");
    });
  });

  // --- Section 4.4/10.2: internal blacklist always runs first ----------------
  describe("internal blacklist", () => {
    it("short-circuits the external provider on a match — a name MockProvider alone would call CLEAN", async () => {
      const blacklistRepo = dataSource.getRepository(InternalBlacklistEntity);
      const blacklistedName = `Blacklisted Individual ${Date.now()}`;
      await blacklistRepo.save(
        blacklistRepo.create({
          tenantId,
          fullName: blacklistedName,
          bvn: null,
          nin: null,
          reason: "Internal watchlist — court order.",
          addedBy: "00000000-0000-0000-0000-000000000000",
          expiresAt: null,
        }),
      );

      // This exact name contains none of MockProvider's trigger substrings
      // (SANCTIONED/PEP/etc.) — a plain MockProvider call would return CLEAN.
      // A CONFIRMED_MATCH here can only come from the internal blacklist.
      const customer = await createCustomer({ fullName: blacklistedName });

      const result = await processAsyncScreeningJob(dataSource, {
        tenantId,
        customerId: customer.id,
        checkTypes: [ScreeningCheckType.SANCTIONS],
        trigger: ScreeningTrigger.ONBOARDING,
      });

      expect(result.outcomes[0].result).toBe("CONFIRMED_MATCH");

      const check = await dataSource.getRepository(ScreeningCheckEntity).findOneOrFail({ where: { id: result.outcomes[0].checkId } });
      expect(check.highestMatchScore).toBe(100);

      const matches = await dataSource.getRepository(ScreeningMatchEntity).find({ where: { customerId: customer.id } });
      expect(matches).toHaveLength(1);
      expect(matches[0].listSource).toBe("INTERNAL_BLACKLIST");
      expect(matches[0].matchScore).toBe(100);
    });

    it("does not match an expired blacklist entry", async () => {
      const blacklistRepo = dataSource.getRepository(InternalBlacklistEntity);
      const expiredName = `Expired Blacklist Person ${Date.now()}`;
      await blacklistRepo.save(
        blacklistRepo.create({
          tenantId,
          fullName: expiredName,
          bvn: null,
          nin: null,
          reason: "No longer applicable.",
          addedBy: "00000000-0000-0000-0000-000000000000",
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // yesterday
        }),
      );

      const customer = await createCustomer({ fullName: expiredName });

      const result = await processAsyncScreeningJob(dataSource, {
        tenantId,
        customerId: customer.id,
        checkTypes: [ScreeningCheckType.SANCTIONS],
        trigger: ScreeningTrigger.ONBOARDING,
      });

      expect(result.outcomes[0].result).toBe("CLEAN");
    });
  });

  // --- Section 10.8: scheduled re-screen -------------------------------------
  describe("processRescreenJob", () => {
    it("flags PEP on a scheduled CONFIRMED_MATCH for an existing HIGH-risk customer, without deleting or blocking the record", async () => {
      const customer = await createCustomer({ fullName: "Existing PEP Customer", riskLevel: RiskLevel.HIGH });

      const result = await processRescreenJob(dataSource, {
        tenantId,
        scheduleLabel: "DAILY_HIGH_RISK",
        riskLevels: [RiskLevel.HIGH, RiskLevel.CRITICAL],
        checkTypes: [ScreeningCheckType.PEP],
      });

      expect(result.processed).toBeGreaterThanOrEqual(1);
      const outcome = result.outcomes.find((o) => o.customerId === customer.id);
      expect(outcome?.result).toBe("CONFIRMED_MATCH");
      expect(outcome?.pepFlagged).toBe(true);
      expect(outcome?.sanctionsFlagged).toBe(false);

      const updated = await dataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customer.id } });
      expect(updated.isPep).toBe(true);
      expect(updated.status).toBe(CustomerStatus.ACTIVE); // never blocked/deleted (Section 5.3)
    });

    it("flags sanctions on a scheduled CONFIRMED_MATCH for an existing customer via sanctions_flagged semantics (never sanctions_confirmed)", async () => {
      const customer = await createCustomer({ fullName: "Existing SANCTIONED Customer", riskLevel: RiskLevel.CRITICAL });

      const result = await processRescreenJob(dataSource, {
        tenantId,
        scheduleLabel: "DAILY_HIGH_RISK",
        riskLevels: [RiskLevel.HIGH, RiskLevel.CRITICAL],
        checkTypes: [ScreeningCheckType.SANCTIONS],
      });

      const outcome = result.outcomes.find((o) => o.customerId === customer.id);
      expect(outcome?.result).toBe("CONFIRMED_MATCH");
      expect(outcome?.sanctionsFlagged).toBe(true);

      const updated = await dataSource.getRepository(CustomerEntity).findOneOrFail({ where: { id: customer.id } });
      expect(updated.isSanctioned).toBe(true);
      expect(updated.status).toBe(CustomerStatus.ACTIVE);

      // Section 5.3's own required audit-adjacent evidence: a ScreeningCheck
      // row recording this happened, attributable to a SCHEDULED trigger.
      const check = await dataSource.getRepository(ScreeningCheckEntity).findOne({ where: { id: outcome!.checkId } });
      expect(check?.trigger).toBe("SCHEDULED");
    });

    it("only selects customers within the requested risk levels", async () => {
      const lowRiskCustomer = await createCustomer({ fullName: "Low Risk PEP Person", riskLevel: RiskLevel.LOW });

      const result = await processRescreenJob(dataSource, {
        tenantId,
        scheduleLabel: "DAILY_HIGH_RISK",
        riskLevels: [RiskLevel.HIGH, RiskLevel.CRITICAL],
        checkTypes: [ScreeningCheckType.PEP],
      });

      expect(result.outcomes.some((o) => o.customerId === lowRiskCustomer.id)).toBe(false);
    });

    it("dedup: an identical check within the last hour is not re-run against the provider", async () => {
      const customer = await createCustomer({ fullName: "Repeat Check Person", riskLevel: RiskLevel.HIGH });

      const first = await processRescreenJob(dataSource, {
        tenantId,
        scheduleLabel: "DAILY_HIGH_RISK",
        riskLevels: [RiskLevel.HIGH],
        checkTypes: [ScreeningCheckType.PEP],
      });
      const firstOutcome = first.outcomes.find((o) => o.customerId === customer.id)!;

      const second = await processRescreenJob(dataSource, {
        tenantId,
        scheduleLabel: "DAILY_HIGH_RISK",
        riskLevels: [RiskLevel.HIGH],
        checkTypes: [ScreeningCheckType.PEP],
      });
      const secondOutcome = second.outcomes.find((o) => o.customerId === customer.id)!;

      // Same cached ScreeningCheck row reused, not a fresh one (Section 5.5).
      expect(secondOutcome.checkId).toBe(firstOutcome.checkId);

      const checkCount = await dataSource
        .getRepository(ScreeningCheckEntity)
        .count({ where: { customerId: customer.id, checkType: ScreeningCheckType.PEP } });
      expect(checkCount).toBe(1);
    });
  });

  // Cross-check: RiskScoreHistory rows exist for every auto-flag rescore,
  // attributed to SCREENING_MATCH — same trigger the manual match-review
  // path uses, per this worker's apply-confirmed-match.ts docblock.
  it("every auto-flag rescore leaves a SCREENING_MATCH-triggered RiskScoreHistory row", async () => {
    const customer = await createCustomer({ fullName: "History Check PEP" });
    await processAsyncScreeningJob(dataSource, {
      tenantId,
      customerId: customer.id,
      checkTypes: [ScreeningCheckType.PEP],
      trigger: ScreeningTrigger.ONBOARDING,
    });

    const history = await dataSource
      .getRepository(RiskScoreHistoryEntity)
      .find({ where: { customerId: customer.id }, order: { calculatedAt: "ASC" } });
    expect(history.some((h) => h.trigger === "SCREENING_MATCH")).toBe(true);
  });
});
