import "reflect-metadata";
import * as dotenv from "dotenv";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Readable } from "stream";
import { DataSource } from "typeorm";
import { entities, RiskFactorConfigEntity, TenantEntity } from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import { TenantStatus, TenantType } from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processIngestionJob } from "../src/customer-ingestion/ingestion-job.processor";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const ROW_COUNT = 100_000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/**
 * Section 7.5's explicit performance target: 100,000 rows in under 10
 * minutes on a single worker/connection. Not run as part of the normal
 * `pnpm test:e2e` — set RUN_INGESTION_BENCHMARK=1 to opt in, since a 10
 * minute budget in the worst case would make every routine e2e run
 * unacceptably slow for a check that only needs to be re-verified when the
 * ingestion pipeline itself changes.
 */
const maybeDescribe = process.env.RUN_INGESTION_BENCHMARK === "1" ? describe : describe.skip;

maybeDescribe("Customer CSV ingestion — 100k row benchmark (e2e)", () => {
  let dataSource: DataSource;
  let storageDir: string;
  let tenantId: string;

  beforeAll(async () => {
    // extra.max must comfortably exceed the processor's chunk concurrency
    // (CONCURRENCY in ingestion-job.processor.ts) — each concurrently
    // processed chunk holds its own pooled connection for the duration of
    // its transaction.
    dataSource = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_ADMIN_URL,
      entities,
      extra: { max: 20 },
    });
    await dataSource.initialize();

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "regops-ingestion-benchmark-"));

    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `Benchmark Tenant ${Date.now()}`,
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
  }, 30_000);

  it(
    `processes ${ROW_COUNT.toLocaleString()} rows in under 10 minutes`,
    async () => {
      const storage = new LocalFileStorage(storageDir);
      const jobId = `benchmark-${Date.now()}`;
      const storageKey = `tenants/${tenantId}/ingestion/${jobId}.csv`;

      const header =
        "cbs_customer_id,full_name,email,phone,bvn,nin,date_of_birth,customer_type,occupation,country,nationality,kyc_tier,onboarded_at";
      const customerTypes = ["INDIVIDUAL", "SME", "CORPORATE", "NGO", "GOVERNMENT"];
      const countries = ["NG", "GH", "KE", "VE", "IR"];

      // Readable.from() streams each yielded value as a raw chunk with no
      // separator inserted — every line must carry its own trailing "\n" or
      // csv-parse sees one giant unparseable blob instead of newline-delimited rows.
      function* generateRows(): Generator<string> {
        yield header + "\n";
        for (let i = 0; i < ROW_COUNT; i += 1) {
          const type = customerTypes[i % customerTypes.length];
          const country = countries[i % countries.length];
          const kycTier = (i % 3) + 1;
          yield `BENCH-${i},Benchmark Customer ${i},,,,,,${type},Analyst,${country},,${kycTier},2024-01-01\n`;
        }
      }

      await storage.upload(storageKey, Readable.from(generateRows()));

      const start = Date.now();
      const result = await processIngestionJob(
        dataSource,
        storage,
        {
          tenantId,
          jobId,
          storageKey,
          duplicateStrategy: "skip",
          uploadedBy: "00000000-0000-0000-0000-000000000000",
        },
        async () => undefined,
      );
      const elapsedMs = Date.now() - start;

      console.log(
        `Ingested ${result.total} rows (${result.succeeded} succeeded, ${result.failed} failed) in ${(
          elapsedMs / 1000
        ).toFixed(1)}s`,
      );

      expect(result.total).toBe(ROW_COUNT);
      expect(result.succeeded).toBe(ROW_COUNT);
      expect(result.failed).toBe(0);
      expect(elapsedMs).toBeLessThan(TEN_MINUTES_MS);
    },
    TEN_MINUTES_MS + 30_000,
  );
});
