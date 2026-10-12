import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue, QueueEvents } from "bullmq";
import { ASYNC_SCREENING_QUEUE, AsyncScreeningJobData, AsyncScreeningJobResult } from "@regops/shared";
import { SCREENING_EVENTS } from "./screening.events";

/** Same host:port:password shape BullMQ wants — duplicated from
 * apps/worker/customers/ingestion's identical helper rather than shared; see
 * that file's docblock for why (bundled-vs-standalone ioredis version
 * conflict). */
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    // family 0 = dual-stack lookup; Railway's private network (*.railway.internal) is IPv6-only.
    family: 0,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as null,
  };
}

/**
 * Producer + QueueEvents bridge for the async PEP/adverse-media flow
 * (Section 5.2). The job actually runs in apps/worker — a separate OS
 * process — so in-process EventEmitter2 alone can't see it complete;
 * QueueEvents listens on Redis pub/sub for lifecycle events from ANY
 * process's Worker on this queue, letting us re-emit
 * customer.pep_flagged/screening.check.completed/screening.match.found
 * in-process once the real work is done. Exact mirror of
 * CustomerIngestionService's pattern (apps/api/src/customers/ingestion/).
 */
@Injectable()
export class AsyncScreeningQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(AsyncScreeningQueueService.name);
  private readonly queue: Queue<AsyncScreeningJobData, AsyncScreeningJobResult>;
  private readonly queueEvents: QueueEvents;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://127.0.0.1:6379";
    const connection = parseRedisUrl(redisUrl);
    this.queue = new Queue(ASYNC_SCREENING_QUEUE, { connection });

    this.queueEvents = new QueueEvents(ASYNC_SCREENING_QUEUE, { connection });
    this.queueEvents.on("completed", ({ jobId }) => {
      void this.onJobCompleted(jobId);
    });
  }

  private async onJobCompleted(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job || !job.returnvalue) return;
      const result = job.returnvalue;

      for (const outcome of result.outcomes) {
        this.eventEmitter.emit(SCREENING_EVENTS.CHECK_COMPLETED, {
          tenantId: result.tenantId,
          checkId: outcome.checkId,
          customerId: result.customerId,
          checkType: outcome.checkType,
          result: outcome.result,
        });
        for (const matchId of outcome.matchIds) {
          this.eventEmitter.emit(SCREENING_EVENTS.MATCH_FOUND, {
            tenantId: result.tenantId,
            matchId,
            checkId: outcome.checkId,
            customerId: result.customerId,
          });
        }
        if (outcome.pepFlagged) {
          this.eventEmitter.emit(SCREENING_EVENTS.PEP_FLAGGED, {
            tenantId: result.tenantId,
            customerId: result.customerId,
            checkId: outcome.checkId,
            matchId: outcome.matchIds[0] ?? null,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Failed to process completion of async-screening job ${jobId}`, err as Error);
    }
  }

  async enqueue(data: AsyncScreeningJobData): Promise<void> {
    await this.queue.add("async-screen-customer", data);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents.close();
    await this.queue.close();
  }
}
