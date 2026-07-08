import { Injectable, Logger, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue, QueueEvents } from "bullmq";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  BatchIngestJobStatusDto,
  CUSTOMER_INGESTION_QUEUE,
  DuplicateStrategy,
  IngestionJobData,
  IngestionJobResult,
} from "@regops/shared";
import { FileStorage, LocalFileStorage } from "@regops/file-storage";
import { CUSTOMER_EVENTS } from "../customers.events";

/** Same host:port:password shape BullMQ wants — duplicated from apps/worker rather than shared;
 * see that file's docblock for why (bundled-vs-standalone ioredis version conflict). */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

@Injectable()
export class CustomerIngestionService implements OnModuleDestroy {
  private readonly logger = new Logger(CustomerIngestionService.name);
  private readonly queue: Queue<IngestionJobData, IngestionJobResult>;
  private readonly queueEvents: QueueEvents;
  private readonly storage: FileStorage;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://localhost:6379";
    const connection = parseRedisUrl(redisUrl);
    this.queue = new Queue(CUSTOMER_INGESTION_QUEUE, { connection });

    // The job actually runs in apps/worker — a separate OS process — so
    // in-process EventEmitter2 alone can't see it complete. QueueEvents
    // listens on Redis pub/sub for lifecycle events from ANY process's
    // Worker on this queue, letting us re-emit customer.batch_ingest_completed
    // in-process once the real work (wherever it ran) is done.
    this.queueEvents = new QueueEvents(CUSTOMER_INGESTION_QUEUE, { connection });
    this.queueEvents.on("completed", ({ jobId }) => {
      void this.onJobCompleted(jobId);
    });

    const localStorageDir =
      process.env.LOCAL_STORAGE_DIR ?? path.resolve(__dirname, "../../../../../.local-storage");
    this.storage = new LocalFileStorage(localStorageDir);
  }

  private async onJobCompleted(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job || !job.returnvalue) return;

      const result = job.returnvalue;
      this.eventEmitter.emit(CUSTOMER_EVENTS.BATCH_INGEST_COMPLETED, {
        tenantId: job.data.tenantId,
        jobId,
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed,
      });
    } catch (err) {
      this.logger.error(`Failed to process completion of ingestion job ${jobId}`, err as Error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents.close();
    await this.queue.close();
  }

  async uploadAndEnqueue(
    tenantId: string,
    uploadedBy: string,
    tempFilePath: string,
    duplicateStrategy: DuplicateStrategy = "skip",
  ): Promise<{ jobId: string; status: "queued" }> {
    const jobId = crypto.randomUUID();
    const storageKey = `tenants/${tenantId}/ingestion/${jobId}.csv`;

    await this.storage.upload(storageKey, fs.createReadStream(tempFilePath));
    await fs.promises.unlink(tempFilePath).catch(() => undefined);

    await this.queue.add(
      "ingest-customers",
      { tenantId, jobId, storageKey, duplicateStrategy, uploadedBy },
      { jobId },
    );

    return { jobId, status: "queued" };
  }

  async getStatus(tenantId: string, jobId: string): Promise<BatchIngestJobStatusDto> {
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.tenantId !== tenantId) {
      throw new NotFoundException({ code: "INGESTION_JOB_NOT_FOUND", message: "Ingestion job not found." });
    }

    const state = await job.getState();
    const status: BatchIngestJobStatusDto["status"] =
      state === "completed" ? "completed" : state === "failed" ? "failed" : state === "active" ? "active" : "queued";

    const result = job.returnvalue as IngestionJobResult | undefined;

    return {
      jobId,
      status,
      progress: typeof job.progress === "number" ? job.progress : 0,
      total: result?.total ?? null,
      succeeded: result?.succeeded ?? null,
      failed: result?.failed ?? null,
      errorReportUrl: result?.errorReportKey ? `/customers/batch/${jobId}/error-report` : null,
    };
  }

  async getErrorReportStream(tenantId: string, jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.tenantId !== tenantId) {
      throw new NotFoundException({ code: "INGESTION_JOB_NOT_FOUND", message: "Ingestion job not found." });
    }
    const result = job.returnvalue as IngestionJobResult | undefined;
    if (!result?.errorReportKey) {
      throw new NotFoundException({ code: "ERROR_REPORT_NOT_FOUND", message: "No error report for this job." });
    }
    return this.storage.getReadStream(result.errorReportKey);
  }
}
