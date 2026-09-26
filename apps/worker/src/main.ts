import "reflect-metadata";
import * as dotenv from "dotenv";
import * as http from "http";
import * as path from "path";
import { Queue, QueueEvents, Worker } from "bullmq";
import { DataSource } from "typeorm";
import { entities } from "@regops/db";
import {
  ASYNC_SCREENING_QUEUE,
  AsyncScreeningJobData,
  AsyncScreeningJobResult,
  CUSTOMER_INGESTION_QUEUE,
  IngestionJobData,
  IngestionJobResult,
  MAINTENANCE_QUEUE,
  RESCREEN_QUEUE,
  RescreenJobData,
  RescreenJobResult,
  RULE_EVALUATION_QUEUE,
  RuleEvaluationJobData,
  RuleEvaluationJobResult,
  TRANSACTION_INGESTION_QUEUE,
  TransactionIngestionJobData,
  TransactionIngestionJobResult,
} from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processIngestionJob } from "./customer-ingestion/ingestion-job.processor";
import { processAsyncScreeningJob } from "./screening/async-screening.processor";
import { processRescreenJob } from "./screening/rescreen-job.processor";
import { processTransactionIngestionJob } from "./transactions/ingestion-processor";
import { pollSftpInboxes } from "./transactions/sftp-polling";
import { evaluateTransaction } from "./rules/evaluate-rules.processor";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const PORT = Number(process.env.PORT ?? 4001);
// Both apps/api (producer, uploads here) and apps/worker (consumer, reads/writes here) must
// resolve to the same physical directory — see LocalFileStorage's docblock for why this is a
// dev-only substitute for Cloudflare R2. apps/api/dist and apps/worker/dist sit at the same
// depth under the repo root, so the same relative traversal lands in the same place from both.
const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR ?? path.resolve(__dirname, "../../../.local-storage");

/**
 * Phase 0 ships only the queue/worker skeleton plus the one recurring job
 * the foundation itself depends on: pre-creating future audit_log quarterly
 * partitions (see packages/db InitialSchema migration). Domain job
 * processors (screening, transaction ingestion, etc.) arrive in later
 * phases and register themselves the same way against this connection.
 *
 * BullMQ is handed the raw REDIS_URL string rather than an ioredis instance
 * we construct ourselves — bullmq bundles its own ioredis, and a
 * separately-installed copy in this workspace can resolve to a different
 * (structurally incompatible) version, which the TS compiler rejects even
 * though both work identically at runtime.
 */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}

async function bootstrap(): Promise<void> {
  const connection = parseRedisUrl(REDIS_URL);

  const adminDataSource = new DataSource({
    type: "postgres",
    // Partition DDL and customer ingestion both require the schema-owning role.
    url: process.env.DATABASE_ADMIN_URL,
    entities,
    // Must comfortably exceed the ingestion processor's chunk concurrency
    // (CONCURRENCY in ingestion-job.processor.ts) — each concurrently
    // processed chunk holds its own pooled connection for the duration of
    // its transaction.
    extra: { max: 20 },
  });
  await adminDataSource.initialize();

  const storage = new LocalFileStorage(LOCAL_STORAGE_DIR);

  // Backend Prompt 4's own queue+events pair — built before maintenanceWorker
  // so its job handler's poll-sftp-inboxes branch can close over both.
  const transactionIngestionQueue = new Queue<TransactionIngestionJobData, TransactionIngestionJobResult>(
    TRANSACTION_INGESTION_QUEUE,
    { connection },
  );
  const transactionIngestionQueueEvents = new QueueEvents(TRANSACTION_INGESTION_QUEUE, { connection });

  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
  await maintenanceQueue.add(
    "create-audit-log-partitions",
    {},
    { repeat: { pattern: "0 3 1 * *" }, jobId: "create-audit-log-partitions" }, // monthly, 03:00 UTC on the 1st
  );
  await maintenanceQueue.add(
    "create-transaction-partitions",
    {},
    { repeat: { pattern: "0 3 25 * *" }, jobId: "create-transaction-partitions" }, // monthly, 03:00 UTC on the 25th (spec Section 3, partitioning strategy)
  );
  // spec Section 5.3: every 5 min during business hours (07:00-22:00 Africa/Lagos),
  // every 30 min otherwise — two repeatable jobs covering disjoint cron windows
  // rather than one pattern, since cron alone can't express "else".
  await maintenanceQueue.add(
    "poll-sftp-inboxes",
    {},
    { repeat: { pattern: "*/5 7-22 * * *", tz: "Africa/Lagos" }, jobId: "poll-sftp-business-hours" },
  );
  await maintenanceQueue.add(
    "poll-sftp-inboxes",
    {},
    { repeat: { pattern: "*/30 0-6,23 * * *", tz: "Africa/Lagos" }, jobId: "poll-sftp-off-hours" },
  );

  const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === "create-audit-log-partitions") {
        for (let i = 0; i <= 3; i += 1) {
          await adminDataSource.query(
            `SELECT create_audit_log_partition((now() + ($1 || ' months')::interval)::date)`,
            [i * 3],
          );
        }
      } else if (job.name === "create-transaction-partitions") {
        // Pre-create 2 months ahead every run — comfortably covers the
        // ~monthly cadence even if a run is delayed or skipped once.
        await adminDataSource.query(`SELECT create_transaction_partition((now() + interval '2 months')::date)`);
      } else if (job.name === "poll-sftp-inboxes") {
        await pollSftpInboxes(adminDataSource, storage, transactionIngestionQueue, transactionIngestionQueueEvents);
      }
    },
    { connection },
  );

  const ingestionWorker = new Worker<IngestionJobData, IngestionJobResult>(
    CUSTOMER_INGESTION_QUEUE,
    async (job) => {
      return processIngestionJob(adminDataSource, storage, job.data, async (percent) => {
        await job.updateProgress(percent);
      });
    },
    { connection },
  );

  const asyncScreeningWorker = new Worker<AsyncScreeningJobData, AsyncScreeningJobResult>(
    ASYNC_SCREENING_QUEUE,
    async (job) => processAsyncScreeningJob(adminDataSource, job.data),
    { connection },
  );

  const rescreenWorker = new Worker<RescreenJobData, RescreenJobResult>(
    RESCREEN_QUEUE,
    async (job) => processRescreenJob(adminDataSource, job.data),
    { connection },
  );

  const transactionIngestionWorker = new Worker<TransactionIngestionJobData, TransactionIngestionJobResult>(
    TRANSACTION_INGESTION_QUEUE,
    async (job) => {
      return processTransactionIngestionJob(adminDataSource, storage, job.data, async (percent) => {
        await job.updateProgress(percent);
      });
    },
    { connection },
  );

  // Matches RuleEvaluationConsumerService's original CONCURRENCY (apps/api,
  // before this queue's consumer moved here — see HANDOFF.md's Prompt 5
  // deviations).
  const RULE_EVALUATION_CONCURRENCY = 5;
  const ruleEvaluationWorker: Worker<RuleEvaluationJobData, RuleEvaluationJobResult> = new Worker(
    RULE_EVALUATION_QUEUE,
    async (job): Promise<RuleEvaluationJobResult> => {
      // Borrows this Worker's own BullMQ connection for the
      // CounterpartyScreeningService-equivalent Redis cache rather than
      // opening a second ioredis client — same "borrow, don't open a
      // second connection" rationale as RuleEvaluationQueueService.getClient()
      // (apps/api) and TransactionIngestionQueueService.acquireLock.
      const redisClient = await ruleEvaluationWorker.client;
      return evaluateTransaction(adminDataSource, redisClient, job.data.tenantId, job.data.transactionId);
    },
    { connection, concurrency: RULE_EVALUATION_CONCURRENCY },
  );

  for (const worker of [maintenanceWorker, ingestionWorker, asyncScreeningWorker, rescreenWorker, transactionIngestionWorker, ruleEvaluationWorker]) {
    worker.on("completed", (job) => {
      console.log(`[worker] job ${job.name} completed`);
    });
    worker.on("failed", (job, err) => {
      console.error(`[worker] job ${job?.name} failed:`, err);
    });
  }

  // Minimal health-check endpoint — this process is a BullMQ consumer, not
  // an HTTP API, but still binds a port so it's visible/probeable like the
  // other apps (`pnpm dev` runs api:4000, web:3000, worker:4001).
  const healthServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        queues: [
          MAINTENANCE_QUEUE,
          CUSTOMER_INGESTION_QUEUE,
          ASYNC_SCREENING_QUEUE,
          RESCREEN_QUEUE,
          TRANSACTION_INGESTION_QUEUE,
          RULE_EVALUATION_QUEUE,
        ],
      }),
    );
  });
  healthServer.listen(PORT);

  console.log(
    `RegOps worker listening on queues "${MAINTENANCE_QUEUE}", "${CUSTOMER_INGESTION_QUEUE}", "${ASYNC_SCREENING_QUEUE}", "${RESCREEN_QUEUE}", "${TRANSACTION_INGESTION_QUEUE}", "${RULE_EVALUATION_QUEUE}", health check on :${PORT}`,
  );

  const shutdown = async () => {
    await ruleEvaluationWorker.close();
    await transactionIngestionWorker.close();
    await rescreenWorker.close();
    await asyncScreeningWorker.close();
    await ingestionWorker.close();
    await maintenanceWorker.close();
    await maintenanceQueue.close();
    await transactionIngestionQueueEvents.close();
    await transactionIngestionQueue.close();
    await adminDataSource.destroy();
    healthServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
