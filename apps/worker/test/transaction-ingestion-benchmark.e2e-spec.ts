import "reflect-metadata";
import * as dotenv from "dotenv";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Readable } from "stream";
import { DataSource } from "typeorm";
import { CustomerAccountEntity, CustomerEntity, IngestionBatchEntity, RiskFactorConfigEntity, TenantEntity, entities } from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import { AccountType, CustomerStatus, CustomerType, IngestionBatchStatus, TenantStatus, TenantType, TransactionSource } from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processTransactionIngestionJob } from "../src/transactions/ingestion-processor";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const ROW_COUNT = 100_000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/**
 * Spec Section 2.2's explicit performance target: a 100,000-row daily SFTP
 * file processed end-to-end in under 30 minutes on a single worker. Same
 * opt-in gating as customer-ingestion-benchmark.e2e-spec.ts (not part of
 * routine `pnpm test:e2e`) — set RUN_TRANSACTION_INGESTION_BENCHMARK=1.
 *
 * Every row targets the SAME pre-existing customer/account (a realistic
 * high-frequency retail account, and it isolates the benchmark to the
 * ingestion pipeline's own throughput rather than customer/account
 * auto-creation, which the other e2e file already covers directly).
 */
const maybeDescribe = process.env.RUN_TRANSACTION_INGESTION_BENCHMARK === "1" ? describe : describe.skip;

maybeDescribe("Transaction ingestion — 100k row benchmark (e2e)", () => {
  let dataSource: DataSource;
  let storageDir: string;
  let tenantId: string;
  let customerId: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "postgres",
      url: process.env.DATABASE_ADMIN_URL,
      entities,
      extra: { max: 20 },
    });
    await dataSource.initialize();

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "regops-txn-ingestion-benchmark-"));

    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `Transaction Benchmark Tenant ${Date.now()}`,
        type: TenantType.MFB,
        status: TenantStatus.ACTIVE,
      }),
    );
    tenantId = tenant.id;

    const configRepo = dataSource.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      await configRepo.save(configRepo.create({ tenantId, factorType: defaults.factorType, weight: defaults.weight, config: defaults.config, isActive: true }));
    }

    const customer = await dataSource.getRepository(CustomerEntity).save(
      dataSource.getRepository(CustomerEntity).create({
        tenantId,
        cbsCustomerId: "BENCH-CUST-1",
        fullName: "Benchmark Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        status: CustomerStatus.ACTIVE,
        onboardedAt: new Date("2024-01-01"),
      }),
    );
    customerId = customer.id;

    await dataSource.getRepository(CustomerAccountEntity).save(
      dataSource.getRepository(CustomerAccountEntity).create({
        tenantId,
        customerId,
        accountNumber: "0100000000",
        accountType: AccountType.SAVINGS,
      }),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    fs.rmSync(storageDir, { recursive: true, force: true });
  }, 30_000);

  it(
    `processes ${ROW_COUNT.toLocaleString()} rows in under 30 minutes`,
    async () => {
      const storage = new LocalFileStorage(storageDir);
      const batch = await dataSource.getRepository(IngestionBatchEntity).save(
        dataSource.getRepository(IngestionBatchEntity).create({
          tenantId,
          source: TransactionSource.SFTP,
          sourceReference: "transactions-benchmark-001.csv",
          status: IngestionBatchStatus.QUEUED,
        }),
      );
      const storageKey = `tenants/${tenantId}/sftp-inbox/transactions-benchmark-001.csv`;

      const header = "cbs_transaction_id,customer_cbs_id,account_number,amount,currency,type,channel,occurred_at";
      const channels = ["MOBILE", "USSD", "POS", "AGENT", "TRANSFER"];
      const baseTime = Date.now();

      function* generateRows(): Generator<string> {
        yield header + "\n";
        for (let i = 0; i < ROW_COUNT; i += 1) {
          const type = i % 2 === 0 ? "CREDIT" : "DEBIT";
          const channel = channels[i % channels.length];
          const occurredAt = new Date(baseTime - i * 1000).toISOString();
          yield `BENCH-TXN-${i},BENCH-CUST-1,0100000000,${(1000 + (i % 5000)).toFixed(2)},NGN,${type},${channel},${occurredAt}\n`;
        }
      }

      await storage.upload(storageKey, Readable.from(generateRows()));

      const start = Date.now();
      const result = await processTransactionIngestionJob(dataSource, storage, {
        tenantId,
        batchId: batch.id,
        source: TransactionSource.SFTP,
        storageKey,
      });
      const elapsedMs = Date.now() - start;

      console.log(
        `Ingested ${result.total} transactions (${result.succeeded} succeeded, ${result.failed} failed) in ${(elapsedMs / 1000).toFixed(1)}s`,
      );

      expect(result.total).toBe(ROW_COUNT);
      expect(result.succeeded).toBe(ROW_COUNT);
      expect(result.failed).toBe(0);
      expect(elapsedMs).toBeLessThan(THIRTY_MINUTES_MS);
    },
    THIRTY_MINUTES_MS + 30_000,
  );
});
