import "reflect-metadata";
import * as dotenv from "dotenv";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Readable } from "stream";
import { DataSource } from "typeorm";
import {
  entities,
  CustomerEntity,
  RiskFactorConfigEntity,
  TenantEntity,
} from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import { CustomerStatus, CustomerType, TenantStatus, TenantType } from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processIngestionJob } from "../src/customer-ingestion/ingestion-job.processor";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

describe("Customer CSV ingestion (e2e)", () => {
  let dataSource: DataSource;
  let storage: LocalFileStorage;
  let storageDir: string;
  let tenantId: string;

  beforeAll(async () => {
    dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_ADMIN_URL, entities });
    await dataSource.initialize();

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "regops-ingestion-test-"));
    storage = new LocalFileStorage(storageDir);

    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `Ingestion Test Tenant ${Date.now()}`,
        type: TenantType.MFB,
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    const configRepo = dataSource.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      await configRepo.save(
        configRepo.create({
          tenantId,
          factorType: defaults.factorType,
          weight: defaults.weight,
          config: defaults.config,
          isActive: true,
        }),
      );
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function uploadCsv(key: string, rows: string[]): Promise<void> {
    const header =
      "cbs_customer_id,full_name,email,phone,bvn,nin,date_of_birth,customer_type,occupation,country,nationality,kyc_tier,onboarded_at";
    await storage.upload(key, Readable.from([[header, ...rows].join("\n")]));
  }

  it("processes valid rows, creates customers with an initial risk score, and captures invalid rows in an error report", async () => {
    const jobId = `job-${Date.now()}-1`;
    const storageKey = `tenants/${tenantId}/ingestion/${jobId}.csv`;
    await uploadCsv(storageKey, [
      "CUST-E2E-001,Valid Customer One,v1@test.dev,,,,,INDIVIDUAL,Teacher,NG,,2,2024-01-01",
      "CUST-E2E-002,Valid Customer Two,,,,,,SME,Trader,NG,,1,2024-01-02",
      "CUST-E2E-003,Bad Row,,,,,,NOT_A_REAL_TYPE,,NG,,2,2024-01-03",
    ]);

    const progressUpdates: number[] = [];
    const result = await processIngestionJob(
      dataSource,
      storage,
      { tenantId, jobId, storageKey, duplicateStrategy: "skip", uploadedBy: "00000000-0000-0000-0000-000000000000" },
      async (percent) => {
        progressUpdates.push(percent);
      },
    );

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errorReportKey).not.toBeNull();
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);

    const created = await dataSource
      .getRepository(CustomerEntity)
      .find({ where: { tenantId }, order: { cbsCustomerId: "ASC" } });
    const createdIds = created.map((c) => c.cbsCustomerId);
    expect(createdIds).toContain("CUST-E2E-001");
    expect(createdIds).toContain("CUST-E2E-002");
    expect(createdIds).not.toContain("CUST-E2E-003");

    const customerOne = created.find((c) => c.cbsCustomerId === "CUST-E2E-001")!;
    expect(customerOne.riskScore).toBeGreaterThan(0);
    expect(customerOne.lastRiskCalculatedAt).not.toBeNull();

    const errorReport = await storage.getReadStream(result.errorReportKey!);
    const chunks: Buffer[] = [];
    for await (const chunk of errorReport) chunks.push(chunk as Buffer);
    const errorCsv = Buffer.concat(chunks).toString("utf-8");
    expect(errorCsv).toContain("CUST-E2E-003");
    expect(errorCsv).toContain("INVALID_CUSTOMER_TYPE");
  });

  it("duplicate_strategy 'skip' leaves an existing customer unchanged", async () => {
    const existing = await dataSource.getRepository(CustomerEntity).save(
      dataSource.getRepository(CustomerEntity).create({
        tenantId,
        cbsCustomerId: "CUST-E2E-SKIP",
        fullName: "Original Name",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 1,
        status: CustomerStatus.ACTIVE,
        onboardedAt: new Date("2024-01-01"),
      }),
    );

    const jobId = `job-${Date.now()}-skip`;
    const storageKey = `tenants/${tenantId}/ingestion/${jobId}.csv`;
    await uploadCsv(storageKey, ["CUST-E2E-SKIP,Changed Name,,,,,,CORPORATE,,NG,,3,2024-02-01"]);

    const result = await processIngestionJob(
      dataSource,
      storage,
      { tenantId, jobId, storageKey, duplicateStrategy: "skip", uploadedBy: "00000000-0000-0000-0000-000000000000" },
      async () => undefined,
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const unchanged = await dataSource.getRepository(CustomerEntity).findOne({ where: { id: existing.id } });
    expect(unchanged?.fullName).toBe("Original Name");
    expect(unchanged?.customerType).toBe(CustomerType.INDIVIDUAL);
  });

  it("duplicate_strategy 'update' updates the existing customer and re-scores when scoring-relevant fields changed", async () => {
    const existing = await dataSource.getRepository(CustomerEntity).save(
      dataSource.getRepository(CustomerEntity).create({
        tenantId,
        cbsCustomerId: "CUST-E2E-UPDATE",
        fullName: "Before Update",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 3,
        status: CustomerStatus.ACTIVE,
        onboardedAt: new Date("2024-01-01"),
      }),
    );
    const scoreBefore = existing.riskScore;

    const jobId = `job-${Date.now()}-update`;
    const storageKey = `tenants/${tenantId}/ingestion/${jobId}.csv`;
    await uploadCsv(storageKey, ["CUST-E2E-UPDATE,After Update,,,,,,PEP,,IR,,1,2024-01-01"]);

    const result = await processIngestionJob(
      dataSource,
      storage,
      { tenantId, jobId, storageKey, duplicateStrategy: "update", uploadedBy: "00000000-0000-0000-0000-000000000000" },
      async () => undefined,
    );

    expect(result.succeeded).toBe(1);

    const updated = await dataSource.getRepository(CustomerEntity).findOne({ where: { id: existing.id } });
    expect(updated?.fullName).toBe("After Update");
    expect(updated?.customerType).toBe(CustomerType.PEP);
    expect(updated?.riskScore).toBeGreaterThan(scoreBefore);
    expect(updated?.riskLevel).toBe("CRITICAL");
  });
});
