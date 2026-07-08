import "reflect-metadata";
import * as dotenv from "dotenv";
import * as http from "http";
import * as path from "path";
import { Queue, Worker } from "bullmq";
import { DataSource } from "typeorm";
import { entities } from "@regops/db";
import { CUSTOMER_INGESTION_QUEUE, IngestionJobData, IngestionJobResult, MAINTENANCE_QUEUE } from "@regops/shared";
import { LocalFileStorage } from "@regops/file-storage";
import { processIngestionJob } from "./customer-ingestion/ingestion-job.processor";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
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

  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
  await maintenanceQueue.add(
    "create-audit-log-partitions",
    {},
    { repeat: { pattern: "0 3 1 * *" }, jobId: "create-audit-log-partitions" }, // monthly, 03:00 UTC on the 1st
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

  for (const worker of [maintenanceWorker, ingestionWorker]) {
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
    res.end(JSON.stringify({ status: "ok", queues: [MAINTENANCE_QUEUE, CUSTOMER_INGESTION_QUEUE] }));
  });
  healthServer.listen(PORT);

  console.log(
    `RegOps worker listening on queues "${MAINTENANCE_QUEUE}", "${CUSTOMER_INGESTION_QUEUE}", health check on :${PORT}`,
  );

  const shutdown = async () => {
    await ingestionWorker.close();
    await maintenanceWorker.close();
    await maintenanceQueue.close();
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
