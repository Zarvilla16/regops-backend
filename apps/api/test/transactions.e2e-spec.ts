import request from "supertest";
import * as crypto from "crypto";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { DataSource } from "typeorm";
import { CustomerEntity, IngestionBatchEntity, RiskScoreHistoryEntity, TenantEntity, TransactionEntity } from "@regops/db";
import { CustomerType, IngestionBatchStatus, TransactionChannel, TransactionSource, TransactionType, UserRole } from "@regops/shared";
import {
  closeTestContext,
  createTenantFixture,
  createUserFixture,
  createTestContext,
  seedRiskFactorConfigsFixture,
  seedScreeningProviderConfigsFixture,
  TestContext,
} from "./utils/test-app";

const WEBHOOK_SECRET = "test-webhook-secret-do-not-use-in-prod";

function sign(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("Transactions module (e2e)", () => {
  let ctx: TestContext;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tenantAId = (await createTenantFixture(ctx.adminDataSource)).id;
    tenantBId = (await createTenantFixture(ctx.adminDataSource)).id;
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedRiskFactorConfigsFixture(ctx.adminDataSource, tenantBId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantAId);
    await seedScreeningProviderConfigsFixture(ctx.adminDataSource, tenantBId);

    await ctx.adminDataSource
      .getRepository(TenantEntity)
      .update(tenantAId, { config: { transactions: { webhookSecret: WEBHOOK_SECRET } } });
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  const http = () => request(ctx.app.getHttpServer());

  async function loginAs(email: string, password: string): Promise<string> {
    const res = await http().post("/auth/login").send({ email, password }).expect(200);
    return res.body.data.accessToken;
  }

  async function tokenFor(tenantId: string, role: UserRole, emailSuffix: string): Promise<string> {
    const { user, password } = await createUserFixture(ctx.adminDataSource, tenantId, {
      email: `txn-${emailSuffix}@test.dev`,
      role,
    });
    return loginAs(user.email, password);
  }

  async function createCustomer(tenantId: string, cbsCustomerId: string): Promise<CustomerEntity> {
    const repo = ctx.adminDataSource.getRepository(CustomerEntity);
    return repo.save(
      repo.create({
        tenantId,
        cbsCustomerId,
        fullName: "Transaction Test Customer",
        customerType: CustomerType.INDIVIDUAL,
        country: "NG",
        kycTier: 2,
        onboardedAt: new Date("2024-01-01"),
        isPep: false,
        isSanctioned: false,
      }),
    );
  }

  function webhookRequest(tenantId: string, secret: string, transactions: Record<string, unknown>[], query = "") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ transactions });
    const signature = `sha256=${sign(secret, timestamp, body)}`;
    return http()
      .post(`/transactions/ingest${query}`)
      .set("X-Tenant-Id", tenantId)
      .set("X-RegOps-Timestamp", timestamp)
      .set("X-RegOps-Signature", signature)
      .set("Content-Type", "application/json")
      .send(body);
  }

  function sampleTransaction(overrides: Record<string, unknown> = {}) {
    return {
      cbs_transaction_id: `TXN-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer_cbs_id: "CUST-DOES-NOT-EXIST",
      account_number: "0123456789",
      amount: 50000,
      currency: "NGN",
      type: "CREDIT",
      channel: "MOBILE",
      occurred_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe("webhook signature verification", () => {
    it("valid signature returns 202 with a batchId and creates a QUEUED IngestionBatch row", async () => {
      const res = await webhookRequest(tenantAId, WEBHOOK_SECRET, [sampleTransaction()]).expect(202);
      expect(res.body.data.status).toBe("queued");
      expect(typeof res.body.data.batchId).toBe("string");

      const batch = await ctx.adminDataSource
        .getRepository(IngestionBatchEntity)
        .findOne({ where: { id: res.body.data.batchId } });
      expect(batch?.status).toBe(IngestionBatchStatus.QUEUED);
      expect(batch?.tenantId).toBe(tenantAId);
    });

    it("rejects an invalid signature with 401 and creates no batch", async () => {
      const before = await ctx.adminDataSource.getRepository(IngestionBatchEntity).count({ where: { tenantId: tenantAId } });
      await webhookRequest(tenantAId, "wrong-secret", [sampleTransaction()]).expect(401);
      const after = await ctx.adminDataSource.getRepository(IngestionBatchEntity).count({ where: { tenantId: tenantAId } });
      expect(after).toBe(before);
    });

    it("rejects a stale timestamp (>5 min old) with 401", async () => {
      const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
      const body = JSON.stringify({ transactions: [sampleTransaction()] });
      const signature = `sha256=${sign(WEBHOOK_SECRET, staleTimestamp, body)}`;
      await http()
        .post("/transactions/ingest")
        .set("X-Tenant-Id", tenantAId)
        .set("X-RegOps-Timestamp", staleTimestamp)
        .set("X-RegOps-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body)
        .expect(401);
    });

    it("tenant A's signature does not validate against tenant B (tenant B has no webhook secret configured)", async () => {
      await webhookRequest(tenantBId, WEBHOOK_SECRET, [sampleTransaction()]).expect(401);
    });

    it("rejects a batch of more than 1000 transactions with 400", async () => {
      const many = Array.from({ length: 1001 }, () => sampleTransaction());
      await webhookRequest(tenantAId, WEBHOOK_SECRET, many).expect(400);
    });

    it("replaying the same Idempotency-Key returns the prior response instead of creating a second batch", async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ transactions: [sampleTransaction()] });
      const signature = `sha256=${sign(WEBHOOK_SECRET, timestamp, body)}`;
      const idempotencyKey = `idem-${Date.now()}`;

      const first = await http()
        .post("/transactions/ingest")
        .set("X-Tenant-Id", tenantAId)
        .set("X-RegOps-Timestamp", timestamp)
        .set("X-RegOps-Signature", signature)
        .set("Idempotency-Key", idempotencyKey)
        .set("Content-Type", "application/json")
        .send(body)
        .expect(202);

      const second = await http()
        .post("/transactions/ingest")
        .set("X-Tenant-Id", tenantAId)
        .set("X-RegOps-Timestamp", timestamp)
        .set("X-RegOps-Signature", signature)
        .set("Idempotency-Key", idempotencyKey)
        .set("Content-Type", "application/json")
        .send(body)
        .expect(202);

      expect(second.body.data.batchId).toBe(first.body.data.batchId);

      const batchCount = await ctx.adminDataSource
        .getRepository(IngestionBatchEntity)
        .count({ where: { tenantId: tenantAId, sourceReference: idempotencyKey } });
      expect(batchCount).toBe(1);
    });
  });

  describe("synchronous mode (?sync=true)", () => {
    it("rejects more than 50 transactions with 400", async () => {
      const many = Array.from({ length: 51 }, () => sampleTransaction());
      await webhookRequest(tenantAId, WEBHOOK_SECRET, many, "?sync=true").expect(400);
    });
  });

  describe("GET /transactions and filters", () => {
    it("lists a tenant's own transactions and supports filtering, while staying tenant-scoped", async () => {
      const customer = await createCustomer(tenantAId, `CUST-LIST-${Date.now()}`);
      const txnRepo = ctx.adminDataSource.getRepository(TransactionEntity);
      const occurredAt = new Date();
      await txnRepo.save(
        txnRepo.create({
          id: crypto.randomUUID(),
          tenantId: tenantAId,
          cbsTransactionId: `TXN-LIST-${Date.now()}`,
          customerId: customer.id,
          accountNumber: "9999999999",
          amount: "250000.00",
          currency: "NGN",
          type: TransactionType.CREDIT,
          channel: TransactionChannel.MOBILE,
          occurredAt,
          source: TransactionSource.MANUAL,
        }),
      );

      const otherTenantCustomer = await createCustomer(tenantBId, `CUST-LIST-B-${Date.now()}`);
      await txnRepo.save(
        txnRepo.create({
          id: crypto.randomUUID(),
          tenantId: tenantBId,
          cbsTransactionId: `TXN-LIST-B-${Date.now()}`,
          customerId: otherTenantCustomer.id,
          accountNumber: "8888888888",
          amount: "1.00",
          currency: "NGN",
          type: TransactionType.DEBIT,
          channel: TransactionChannel.POS,
          occurredAt,
          source: TransactionSource.MANUAL,
        }),
      );

      const token = await tokenFor(tenantAId, UserRole.VIEWER, `list-${Date.now()}`);
      const res = await http().get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);

      const accountNumbers = res.body.data.data.map((t: { accountNumber: string }) => t.accountNumber);
      expect(accountNumbers).toContain("9999999999");
      expect(accountNumbers).not.toContain("8888888888");

      const filtered = await http()
        .get(`/customers/${customer.id}/transactions`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(filtered.body.data.data.every((t: { customerId: string }) => t.customerId === customer.id)).toBe(true);
    });
  });

  describe("re-score debounce (spec Section 9.4)", () => {
    it("100 transaction.ingested events for the same customer within the debounce window trigger exactly one re-score", async () => {
      const customer = await createCustomer(tenantAId, `CUST-DEBOUNCE-${Date.now()}`);
      const eventEmitter = ctx.app.get(EventEmitter2);

      const historyCountBefore = await ctx.adminDataSource
        .getRepository(RiskScoreHistoryEntity)
        .count({ where: { customerId: customer.id } });

      for (let i = 0; i < 100; i += 1) {
        eventEmitter.emit("transaction.ingested", { tenantId: tenantAId, customerId: customer.id });
      }
      // Listener handlers are async fire-and-forget from emit()'s perspective —
      // give them a tick to actually run before asserting.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const historyCountAfter = await ctx.adminDataSource
        .getRepository(RiskScoreHistoryEntity)
        .count({ where: { customerId: customer.id } });

      expect(historyCountAfter - historyCountBefore).toBe(1);
    });
  });

  describe("RLS enforced at the partition level, not just the parent table", () => {
    it("querying a monthly partition table directly under regops_app with no tenant context returns 0 rows", async () => {
      const customer = await createCustomer(tenantAId, `CUST-RLS-${Date.now()}`);
      const txnRepo = ctx.adminDataSource.getRepository(TransactionEntity);
      const cbsTransactionId = `TXN-RLS-${Date.now()}`;
      const now = new Date();
      await txnRepo.save(
        txnRepo.create({
          id: crypto.randomUUID(),
          tenantId: tenantAId,
          cbsTransactionId,
          customerId: customer.id,
          accountNumber: "7777777777",
          amount: "1000.00",
          currency: "NGN",
          type: TransactionType.CREDIT,
          channel: TransactionChannel.MOBILE,
          occurredAt: now,
          source: TransactionSource.MANUAL,
        }),
      );

      const partitionName = `transaction_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const appDataSource = new DataSource({ type: "postgres", url: process.env.DATABASE_URL, entities: [] });
      await appDataSource.initialize();
      try {
        const queryRunner = appDataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          // No set_config at all — a request with no tenant context whatsoever.
          const rows = await queryRunner.query(`SELECT * FROM ${partitionName} WHERE cbs_transaction_id = $1`, [
            cbsTransactionId,
          ]);
          expect(rows).toHaveLength(0);
        } finally {
          await queryRunner.release();
        }
      } finally {
        await appDataSource.destroy();
      }
    });
  });

  describe("GET /transactions/batches", () => {
    it("is not swallowed by GET /transactions/:id's route (regression — found via manual test guide walkthrough)", async () => {
      // TransactionsController's GET /transactions/:id must not match before
      // BatchesController's GET /transactions/batches — a controller-array
      // ordering bug briefly made "batches" get treated as the :id param,
      // producing a 500 (invalid uuid) instead of the batch list.
      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, `batches-route-${Date.now()}`);
      const res = await http().get("/transactions/batches").set("Authorization", `Bearer ${token}`).expect(200);
      expect(Array.isArray(res.body.data.data)).toBe(true);
    });
  });

  describe("customer-accounts", () => {
    it("POST creates a mapping and GET filters by customer_id, tenant-scoped", async () => {
      const customer = await createCustomer(tenantAId, `CUST-ACCT-${Date.now()}`);
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, `acct-${Date.now()}`);

      const created = await http()
        .post("/customer-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ customer_id: customer.id, account_number: `ACC-${Date.now()}`, account_type: "SAVINGS" })
        .expect(201);
      expect(created.body.data.customerId).toBe(customer.id);

      const list = await http()
        .get(`/customer-accounts?customer_id=${customer.id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      expect(list.body.data.every((a: { customerId: string }) => a.customerId === customer.id)).toBe(true);
    });

    it("rejects a duplicate account_number within the same tenant with 409", async () => {
      const customer = await createCustomer(tenantAId, `CUST-ACCT-DUP-${Date.now()}`);
      const token = await tokenFor(tenantAId, UserRole.TENANT_ADMIN, `acct-dup-${Date.now()}`);
      const accountNumber = `ACC-DUP-${Date.now()}`;

      await http()
        .post("/customer-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ customer_id: customer.id, account_number: accountNumber })
        .expect(201);

      await http()
        .post("/customer-accounts")
        .set("Authorization", `Bearer ${token}`)
        .send({ customer_id: customer.id, account_number: accountNumber })
        .expect(409);
    });
  });

  describe("velocity stats debug endpoint", () => {
    it("reflects real transaction history for a customer", async () => {
      const customer = await createCustomer(tenantAId, `CUST-VEL-${Date.now()}`);
      const txnRepo = ctx.adminDataSource.getRepository(TransactionEntity);
      const now = new Date();

      // 10 days of a ₦50k/day baseline, then a ₦5M spike today.
      for (let i = 1; i <= 10; i += 1) {
        const occurredAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        await txnRepo.save(
          txnRepo.create({
            id: crypto.randomUUID(),
            tenantId: tenantAId,
            cbsTransactionId: `TXN-VEL-${i}-${Date.now()}`,
            customerId: customer.id,
            accountNumber: "6666666666",
            amount: "50000.00",
            currency: "NGN",
            type: TransactionType.CREDIT,
            channel: TransactionChannel.MOBILE,
            occurredAt,
            source: TransactionSource.MANUAL,
          }),
        );
      }
      await txnRepo.save(
        txnRepo.create({
          id: crypto.randomUUID(),
          tenantId: tenantAId,
          cbsTransactionId: `TXN-VEL-SPIKE-${Date.now()}`,
          customerId: customer.id,
          accountNumber: "6666666666",
          amount: "5000000.00",
          currency: "NGN",
          type: TransactionType.CREDIT,
          channel: TransactionChannel.MOBILE,
          occurredAt: now,
          source: TransactionSource.MANUAL,
        }),
      );

      const token = await tokenFor(tenantAId, UserRole.COMPLIANCE_OFFICER, `vel-${Date.now()}`);
      const res = await http().get(`/customers/${customer.id}/velocity-stats`).set("Authorization", `Bearer ${token}`).expect(200);

      expect(res.body.data.score).toBeGreaterThan(0);
      expect(res.body.data.detail.spikeDetected).toBe(true);
    });
  });
});
