import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { Queue, QueueEvents, Worker } from "bullmq";
import { DataSource } from "typeorm";
import { CustomerEntity, IngestionBatchEntity, RiskFactorConfigEntity, TenantEntity, entities } from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import {
  CustomerStatus,
  CustomerType,
  IngestionBatchStatus,
  TenantStatus,
  TenantType,
  TransactionIngestionJobData,
  TransactionIngestionJobResult,
} from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processTransactionIngestionJob } from "../src/transactions/ingestion-processor";
import { pollSftpInboxes } from "../src/transactions/sftp-polling";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined, maxRetriesPerRequest: null as null };
}

describe("SFTP-emulated inbox polling (e2e)", () => {
  let dataSource: DataSource;
  let storage: LocalFileStorage;
  let storageDir: string;
  let queue: Queue<TransactionIngestionJobData, TransactionIngestionJobResult>;
  let queueEvents: QueueEvents;
  let worker: Worker<TransactionIngestionJobData, TransactionIngestionJobResult>;
  const queueName = `sftp-polling-test-${Date.now()}`;

  beforeAll(async () => {
    dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_ADMIN_URL, entities });
    await dataSource.initialize();

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "regops-sftp-poll-test-"));
    storage = new LocalFileStorage(storageDir);

    const connection = parseRedisUrl(process.env.REDIS_URL ?? "redis://localhost:6379");
    queue = new Queue(queueName, { connection });
    queueEvents = new QueueEvents(queueName, { connection });
    worker = new Worker(
      queueName,
      async (job) => processTransactionIngestionJob(dataSource, storage, job.data),
      { connection },
    );
    await worker.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    await worker.close();
    await queueEvents.close();
    await queue.close();
    await dataSource.destroy();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function newTenant(): Promise<string> {
    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `SFTP Poll Test Tenant ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: TenantType.MFB,
        status: TenantStatus.ACTIVE,
      }),
    );
    const configRepo = dataSource.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      await configRepo.save(configRepo.create({ tenantId: tenant.id, factorType: defaults.factorType, weight: defaults.weight, config: defaults.config, isActive: true }));
    }
    return tenant.id;
  }

  async function newCustomer(tid: string, cbsCustomerId: string): Promise<CustomerEntity> {
    return dataSource.getRepository(CustomerEntity).save(
      dataSource.getRepository(CustomerEntity).create({
        tenantId: tid,
        cbsCustomerId,
        fullName: "SFTP Test Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        status: CustomerStatus.ACTIVE,
        onboardedAt: new Date("2024-01-01"),
      }),
    );
  }

  function csvFor(customer: CustomerEntity): string {
    const header = "cbs_transaction_id,customer_cbs_id,account_number,amount,currency,type,channel,occurred_at";
    const row = [
      `TXN-SFTP-${Date.now()}`,
      customer.cbsCustomerId,
      "0555555555",
      "42000.00",
      "NGN",
      "CREDIT",
      "AGENT",
      new Date().toISOString(),
    ].join(",");
    return [header, row].join("\n");
  }

  it("a correctly-named file is discovered, processed, and moved to sftp-processed/", async () => {
    const tenantId = await newTenant();
    const customer = await newCustomer(tenantId, `CUST-SFTP-OK-${Date.now()}`);
    const filename = "transactions-20260615-001.csv";
    await storage.upload(`tenants/${tenantId}/sftp-inbox/${filename}`, (await import("stream")).Readable.from([csvFor(customer)]));

    await pollSftpInboxes(dataSource, storage, queue, queueEvents);

    const inboxFiles = await storage.list(`tenants/${tenantId}/sftp-inbox/`);
    expect(inboxFiles).toHaveLength(0);
    const processedFiles = await storage.list(`tenants/${tenantId}/sftp-processed/`);
    expect(processedFiles.some((f) => f.endsWith(filename))).toBe(true);

    const batch = await dataSource.getRepository(IngestionBatchEntity).findOne({ where: { tenantId, sourceReference: filename } });
    expect(batch?.status).toBe(IngestionBatchStatus.COMPLETED);
    expect(batch?.succeededRows).toBe(1);
  }, 20000);

  it("a misnamed file is quarantined immediately, with no IngestionBatch created", async () => {
    const tenantId = await newTenant();
    const filename = "not-the-right-name.csv";
    await storage.upload(`tenants/${tenantId}/sftp-inbox/${filename}`, (await import("stream")).Readable.from(["garbage"]));

    const batchesBefore = await dataSource.getRepository(IngestionBatchEntity).count({ where: { tenantId } });
    await pollSftpInboxes(dataSource, storage, queue, queueEvents);
    const batchesAfter = await dataSource.getRepository(IngestionBatchEntity).count({ where: { tenantId } });

    expect(batchesAfter).toBe(batchesBefore);
    const inboxFiles = await storage.list(`tenants/${tenantId}/sftp-inbox/`);
    expect(inboxFiles).toHaveLength(0);
    const quarantineFiles = await storage.list(`tenants/${tenantId}/sftp-quarantine/`);
    expect(quarantineFiles.some((f) => f.endsWith(filename))).toBe(true);
  }, 20000);

  it("the per-file lock prevents a second concurrent poll from double-processing the same file", async () => {
    const tenantId = await newTenant();
    const customer = await newCustomer(tenantId, `CUST-SFTP-LOCK-${Date.now()}`);
    const filename = "transactions-20260616-001.csv";
    await storage.upload(`tenants/${tenantId}/sftp-inbox/${filename}`, (await import("stream")).Readable.from([csvFor(customer)]));

    // Two concurrent polls racing for the same file — only one should win the lock and process it.
    await Promise.all([
      pollSftpInboxes(dataSource, storage, queue, queueEvents),
      pollSftpInboxes(dataSource, storage, queue, queueEvents),
    ]);

    const batchCount = await dataSource.getRepository(IngestionBatchEntity).count({ where: { tenantId, sourceReference: filename } });
    expect(batchCount).toBe(1);
  }, 20000);
});
