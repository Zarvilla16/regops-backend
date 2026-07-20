import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { DataSource } from "typeorm";
import {
  CustomerAccountEntity,
  CustomerEntity,
  IngestionBatchEntity,
  RiskFactorConfigEntity,
  TenantEntity,
  TransactionEntity,
  entities,
} from "@regops/db";
import { DEFAULT_RISK_FACTOR_CONFIGS } from "@regops/risk-engine";
import {
  CustomerStatus,
  CustomerType,
  IngestionBatchStatus,
  TenantStatus,
  TenantType,
  TransactionSource,
  UnknownCustomerMode,
} from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processTransactionIngestionJob } from "../src/transactions/ingestion-processor";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

describe("Transaction ingestion processor (e2e)", () => {
  let dataSource: DataSource;
  let storage: LocalFileStorage;
  let storageDir: string;
  let tenantId: string;

  beforeAll(async () => {
    dataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_ADMIN_URL, entities });
    await dataSource.initialize();

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "regops-txn-ingestion-test-"));
    storage = new LocalFileStorage(storageDir);
  });

  afterAll(async () => {
    await dataSource.destroy();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function newTenant(config: Record<string, unknown> = {}): Promise<string> {
    const tenant = await dataSource.getRepository(TenantEntity).save(
      dataSource.getRepository(TenantEntity).create({
        name: `Transaction Ingestion Test Tenant ${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: TenantType.MFB,
        status: TenantStatus.ACTIVE,
        config,
      }),
    );

    const configRepo = dataSource.getRepository(RiskFactorConfigEntity);
    for (const defaults of DEFAULT_RISK_FACTOR_CONFIGS) {
      await configRepo.save(configRepo.create({ tenantId: tenant.id, factorType: defaults.factorType, weight: defaults.weight, config: defaults.config, isActive: true }));
    }
    return tenant.id;
  }

  async function newBatch(tid: string): Promise<string> {
    const batch = await dataSource.getRepository(IngestionBatchEntity).save(
      dataSource.getRepository(IngestionBatchEntity).create({
        tenantId: tid,
        source: TransactionSource.WEBHOOK,
        status: IngestionBatchStatus.QUEUED,
      }),
    );
    return batch.id;
  }

  async function newCustomer(tid: string, cbsCustomerId: string): Promise<CustomerEntity> {
    return dataSource.getRepository(CustomerEntity).save(
      dataSource.getRepository(CustomerEntity).create({
        tenantId: tid,
        cbsCustomerId,
        fullName: "Existing Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        status: CustomerStatus.ACTIVE,
        onboardedAt: new Date("2024-01-01"),
      }),
    );
  }

  function sampleRow(overrides: Record<string, unknown> = {}) {
    return {
      cbs_transaction_id: `TXN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer_cbs_id: "CUST-UNKNOWN",
      account_number: "0111111111",
      amount: "100000.00",
      currency: "NGN",
      type: "CREDIT",
      channel: "MOBILE",
      occurred_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("happy path: valid rows for a known customer are inserted and returned as insertedTransactions", async () => {
    tenantId = await newTenant();
    const customer = await newCustomer(tenantId, `CUST-HAPPY-${Date.now()}`);
    const batchId = await newBatch(tenantId);

    const row = sampleRow({ customer_cbs_id: customer.cbsCustomerId, account_number: "0222222222" });
    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.WEBHOOK,
      rows: [row],
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.insertedTransactions).toHaveLength(1);
    expect(result.insertedTransactions[0].customerId).toBe(customer.id);
    expect(result.insertedTransactions[0].amount).toBe("100000.00");

    const batch = await dataSource.getRepository(IngestionBatchEntity).findOne({ where: { id: batchId } });
    expect(batch?.status).toBe(IngestionBatchStatus.COMPLETED);
    expect(batch?.succeededRows).toBe(1);

    const account = await dataSource.getRepository(CustomerAccountEntity).findOne({ where: { tenantId, accountNumber: "0222222222" } });
    expect(account?.customerId).toBe(customer.id);
  });

  it("reject mode: an unknown customer_cbs_id produces an UNKNOWN_CUSTOMER error and no row is inserted", async () => {
    tenantId = await newTenant({ ingestion: { unknownCustomerMode: UnknownCustomerMode.REJECT } });
    const batchId = await newBatch(tenantId);

    const row = sampleRow({ customer_cbs_id: "CUST-DOES-NOT-EXIST" });
    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.WEBHOOK,
      rows: [row],
    });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errorReportKey).not.toBeNull();

    const errorReport = await storage.getReadStream(result.errorReportKey!);
    const chunks: Buffer[] = [];
    for await (const chunk of errorReport) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf-8")).toContain("UNKNOWN_CUSTOMER");

    const txnCount = await dataSource.getRepository(TransactionEntity).count({ where: { tenantId, cbsTransactionId: row.cbs_transaction_id } });
    expect(txnCount).toBe(0);
  });

  it("auto_create_stub mode: an unknown customer_cbs_id creates a PENDING_KYC stub customer and the transaction is inserted", async () => {
    tenantId = await newTenant({ ingestion: { unknownCustomerMode: UnknownCustomerMode.AUTO_CREATE_STUB } });
    const batchId = await newBatch(tenantId);
    const cbsCustomerId = `CUST-STUB-${Date.now()}`;

    const row = sampleRow({ customer_cbs_id: cbsCustomerId });
    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.WEBHOOK,
      rows: [row],
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const stub = await dataSource.getRepository(CustomerEntity).findOne({ where: { tenantId, cbsCustomerId } });
    expect(stub).not.toBeNull();
    expect(stub?.status).toBe(CustomerStatus.PENDING_KYC);
    expect(stub?.fullName).toBe(`Unknown Customer ${cbsCustomerId}`);
    expect(stub?.kycTier).toBe(1);

    const txn = await dataSource.getRepository(TransactionEntity).findOne({ where: { tenantId, cbsTransactionId: row.cbs_transaction_id } });
    expect(txn?.customerId).toBe(stub?.id);
  });

  it("counterparty resolution: a counterparty_account matching an existing CustomerAccount populates counterpartyCustomerId", async () => {
    tenantId = await newTenant();
    const payer = await newCustomer(tenantId, `CUST-PAYER-${Date.now()}`);
    const payee = await newCustomer(tenantId, `CUST-PAYEE-${Date.now()}`);
    await dataSource.getRepository(CustomerAccountEntity).save(
      dataSource.getRepository(CustomerAccountEntity).create({ tenantId, customerId: payee.id, accountNumber: "0333333333" }),
    );
    const batchId = await newBatch(tenantId);

    const row = sampleRow({ customer_cbs_id: payer.cbsCustomerId, counterparty_account: "0333333333" });
    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.WEBHOOK,
      rows: [row],
    });

    expect(result.succeeded).toBe(1);
    expect(result.insertedTransactions[0].counterpartyCustomerId).toBe(payee.id);
  });

  it("counterparty resolution: an unmatched counterparty_account leaves counterpartyCustomerId null (external transfer)", async () => {
    tenantId = await newTenant();
    const payer = await newCustomer(tenantId, `CUST-EXT-${Date.now()}`);
    const batchId = await newBatch(tenantId);

    const row = sampleRow({ customer_cbs_id: payer.cbsCustomerId, counterparty_account: "0999999999" });
    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.WEBHOOK,
      rows: [row],
    });

    expect(result.insertedTransactions[0].counterpartyCustomerId).toBeNull();
  });

  it("duplicate detection: the same (cbs_transaction_id, occurred_at) inserted twice is reported as DUPLICATE_TRANSACTION the second time", async () => {
    tenantId = await newTenant();
    const customer = await newCustomer(tenantId, `CUST-DUP-${Date.now()}`);
    const cbsTransactionId = `TXN-DUP-${Date.now()}`;
    const occurredAt = new Date().toISOString();

    const firstBatch = await newBatch(tenantId);
    const firstResult = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId: firstBatch,
      source: TransactionSource.WEBHOOK,
      rows: [sampleRow({ customer_cbs_id: customer.cbsCustomerId, cbs_transaction_id: cbsTransactionId, occurred_at: occurredAt })],
    });
    expect(firstResult.succeeded).toBe(1);

    const secondBatch = await newBatch(tenantId);
    const secondResult = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId: secondBatch,
      source: TransactionSource.WEBHOOK,
      rows: [sampleRow({ customer_cbs_id: customer.cbsCustomerId, cbs_transaction_id: cbsTransactionId, occurred_at: occurredAt })],
    });
    expect(secondResult.succeeded).toBe(0);
    expect(secondResult.failed).toBe(1);

    const errorReport = await storage.getReadStream(secondResult.errorReportKey!);
    const chunks: Buffer[] = [];
    for await (const chunk of errorReport) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf-8")).toContain("DUPLICATE_TRANSACTION");
  });

  it("a batch with 5 valid + 5 invalid rows finishes COMPLETED_WITH_ERRORS with the right succeeded/failed split", async () => {
    tenantId = await newTenant();
    const customer = await newCustomer(tenantId, `CUST-MIXED-${Date.now()}`);
    const batchId = await newBatch(tenantId);

    const rows = [
      ...Array.from({ length: 5 }, () => sampleRow({ customer_cbs_id: customer.cbsCustomerId })),
      ...Array.from({ length: 5 }, () => sampleRow({ customer_cbs_id: customer.cbsCustomerId, amount: "-5" })), // fails zod (positive amount)
    ];

    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.WEBHOOK,
      rows,
    });

    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(5);

    const batch = await dataSource.getRepository(IngestionBatchEntity).findOne({ where: { id: batchId } });
    expect(batch?.status).toBe(IngestionBatchStatus.COMPLETED_WITH_ERRORS);
  });

  it("processes an SFTP-style CSV file streamed from FileStorage (not the in-memory rows path)", async () => {
    tenantId = await newTenant();
    const customer = await newCustomer(tenantId, `CUST-CSV-${Date.now()}`);
    const batchId = await newBatch(tenantId);

    const header = "cbs_transaction_id,customer_cbs_id,account_number,amount,currency,type,channel,occurred_at";
    const row = [
      `TXN-CSV-${Date.now()}`,
      customer.cbsCustomerId,
      "0444444444",
      "75000.00",
      "NGN",
      "DEBIT",
      "POS",
      new Date().toISOString(),
    ].join(",");
    const storageKey = `tenants/${tenantId}/sftp-inbox/transactions-csv-test.csv`;
    const { Readable } = await import("stream");
    await storage.upload(storageKey, Readable.from([[header, row].join("\n")]));

    const result = await processTransactionIngestionJob(dataSource, storage, {
      tenantId,
      batchId,
      source: TransactionSource.SFTP,
      storageKey,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });
});
