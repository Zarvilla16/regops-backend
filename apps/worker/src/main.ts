import "reflect-metadata";
import * as dotenv from "dotenv";
import * as http from "http";
import { Queue, Worker } from "bullmq";
import { DataSource } from "typeorm";

dotenv.config();

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PORT = Number(process.env.PORT ?? 4001);
const MAINTENANCE_QUEUE = "maintenance";

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
    // Partition DDL requires the schema-owning role.
    url: process.env.DATABASE_ADMIN_URL,
  });
  await adminDataSource.initialize();

  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });
  await maintenanceQueue.add(
    "create-audit-log-partitions",
    {},
    { repeat: { pattern: "0 3 1 * *" }, jobId: "create-audit-log-partitions" }, // monthly, 03:00 UTC on the 1st
  );

  const worker = new Worker(
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

  worker.on("completed", (job) => {
    console.log(`[worker] job ${job.name} completed`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.name} failed:`, err);
  });

  // Minimal health-check endpoint — this process is a BullMQ consumer, not
  // an HTTP API, but still binds a port so it's visible/probeable like the
  // other apps (`pnpm dev` runs api:4000, web:3000, worker:4001).
  const healthServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", queue: MAINTENANCE_QUEUE }));
  });
  healthServer.listen(PORT);

  console.log(`RegOps worker listening on queue "${MAINTENANCE_QUEUE}", health check on :${PORT}`);

  const shutdown = async () => {
    await worker.close();
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
