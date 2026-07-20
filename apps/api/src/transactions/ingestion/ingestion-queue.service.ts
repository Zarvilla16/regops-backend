import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue, QueueEvents } from "bullmq";
import {
  TRANSACTION_INGESTION_QUEUE,
  TransactionIngestionJobData,
  TransactionIngestionJobResult,
} from "@regops/shared";
import { TRANSACTION_EVENTS } from "../transactions.events";

/** Same host:port:password shape BullMQ wants — duplicated from
 * CustomerIngestionService/AsyncScreeningQueueService rather than shared;
 * see those files' docblocks for why (bundled-vs-standalone ioredis version
 * conflict). */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

/**
 * Producer + QueueEvents bridge for BOTH ingestion paths (SFTP-emulated poll
 * and webhook) — they enqueue the same job shape into the same queue, so one
 * service handles both. The row-processing itself runs in apps/worker (a
 * separate OS process with no EventEmitter2 of its own); this bridge listens
 * on Redis pub/sub for that job's completion and re-emits
 * transaction.ingested (once per row) plus the batch lifecycle events
 * in-process, exact mirror of AsyncScreeningQueueService/
 * CustomerIngestionService's pattern.
 */
@Injectable()
export class TransactionIngestionQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(TransactionIngestionQueueService.name);
  private readonly queue: Queue<TransactionIngestionJobData, TransactionIngestionJobResult>;
  private readonly queueEvents: QueueEvents;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://localhost:6379";
    const connection = parseRedisUrl(redisUrl);
    this.queue = new Queue(TRANSACTION_INGESTION_QUEUE, { connection });

    this.queueEvents = new QueueEvents(TRANSACTION_INGESTION_QUEUE, { connection });
    this.queueEvents.on("completed", ({ jobId }) => {
      void this.onJobCompleted(jobId);
    });
    this.queueEvents.on("failed", ({ jobId, failedReason }) => {
      void this.onJobFailed(jobId, failedReason);
    });
  }

  private async onJobCompleted(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job || !job.returnvalue) return;
      const result = job.returnvalue;
      const { tenantId, batchId } = job.data;

      for (const txn of result.insertedTransactions) {
        this.eventEmitter.emit(TRANSACTION_EVENTS.INGESTED, {
          tenantId,
          ingestionBatchId: batchId,
          ...txn,
        });
      }

      this.eventEmitter.emit(TRANSACTION_EVENTS.BATCH_COMPLETED, {
        tenantId,
        batchId,
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed,
      });
    } catch (err) {
      this.logger.error(`Failed to process completion of transaction-ingestion job ${jobId}`, err as Error);
    }
  }

  private async onJobFailed(jobId: string, failedReason: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) return;
      this.eventEmitter.emit(TRANSACTION_EVENTS.BATCH_FAILED, {
        tenantId: job.data.tenantId,
        batchId: job.data.batchId,
        reason: failedReason,
      });
    } catch (err) {
      this.logger.error(`Failed to process failure of transaction-ingestion job ${jobId}`, err as Error);
    }
  }

  async enqueue(data: TransactionIngestionJobData): Promise<string> {
    const job = await this.queue.add("ingest-transactions", data, { jobId: data.batchId });
    return job.id as string;
  }

  /** Synchronous mode (spec Section 6.4): enqueues exactly like the async
   * path (so it's still processed by the one real pipeline in apps/worker),
   * then blocks this HTTP request on the same job's completion instead of
   * returning 202 immediately. Throws if the job doesn't finish within
   * timeoutMs — caller (WebhookController) maps that to a timeout response. */
  async enqueueAndWait(data: TransactionIngestionJobData, timeoutMs: number): Promise<TransactionIngestionJobResult> {
    const job = await this.queue.add("ingest-transactions", data, { jobId: data.batchId });
    return job.waitUntilFinished(this.queueEvents, timeoutMs);
  }

  /**
   * Borrows this queue's own Redis connection (`Queue.client`) for a plain
   * SET-NX-PX lock rather than constructing a second ioredis client — no
   * distributed-lock primitive existed anywhere in this codebase before
   * Backend Prompt 4 (only BullMQ's own bundled connection), and introducing
   * a standalone ioredis instance risks the exact bundled-vs-standalone
   * version conflict documented in parseRedisUrl's docblock above. Used by
   * RiskModule's TransactionListener for the 60s re-score debounce (spec
   * Section 9.4) — unrelated to ingestion, but the same Redis instance, and
   * a distinct key prefix avoids any collision with BullMQ's own keys.
   *
   * Goes through defineCommand/runCommand (a tiny Lua script) rather than
   * client.set(key, value, "PX", ttl, "NX") directly — bullmq's IRedisClient
   * type deliberately narrows `set`'s options to `{PX, EX}` only (no NX), so
   * the conditional-set semantics a lock needs aren't expressible through
   * that interface at all, typed or not. A one-line atomic script sidesteps
   * that narrowing without reaching for the underlying adapter's real type.
   */
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const client = await this.queue.client;
    if (!(client as { regopsAcquireLock?: unknown }).regopsAcquireLock) {
      client.defineCommand("regopsAcquireLock", {
        numberOfKeys: 1,
        lua: "if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 else return 0 end",
      });
    }
    const result = await client.runCommand("regopsAcquireLock", [key, "1", String(ttlMs)]);
    return result === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents.close();
    await this.queue.close();
  }
}
