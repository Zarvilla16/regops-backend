import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue, QueueEvents } from "bullmq";
import { RESCREEN_QUEUE, RescreenJobData, RescreenJobResult } from "@regops/shared";
import { SCREENING_EVENTS } from "./screening.events";

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

/** Producer + QueueEvents bridge for Section 5.3's scheduled re-screening —
 * same pattern as AsyncScreeningQueueService, one queue per job family so
 * the two never compete for worker concurrency against each other. */
@Injectable()
export class RescreenQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(RescreenQueueService.name);
  private readonly queue: Queue<RescreenJobData, RescreenJobResult>;
  private readonly queueEvents: QueueEvents;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://127.0.0.1:6379";
    const connection = parseRedisUrl(redisUrl);
    this.queue = new Queue(RESCREEN_QUEUE, { connection });

    this.queueEvents = new QueueEvents(RESCREEN_QUEUE, { connection });
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
          customerId: outcome.customerId,
          checkType: outcome.checkType,
          result: outcome.result,
        });
        for (const matchId of outcome.matchIds) {
          this.eventEmitter.emit(SCREENING_EVENTS.MATCH_FOUND, {
            tenantId: result.tenantId,
            matchId,
            checkId: outcome.checkId,
            customerId: outcome.customerId,
          });
        }
        if (outcome.pepFlagged) {
          this.eventEmitter.emit(SCREENING_EVENTS.PEP_FLAGGED, {
            tenantId: result.tenantId,
            customerId: outcome.customerId,
            checkId: outcome.checkId,
            matchId: outcome.matchIds[0] ?? null,
          });
        }
        // Section 5.3: scheduled sanctions CONFIRMED_MATCH on an existing
        // customer is customer.sanctions_flagged, never sanctions_confirmed
        // (that name is reserved for the manual match-review TRUE_POSITIVE path).
        if (outcome.sanctionsFlagged) {
          this.eventEmitter.emit(SCREENING_EVENTS.SANCTIONS_FLAGGED, {
            tenantId: result.tenantId,
            customerId: outcome.customerId,
            checkId: outcome.checkId,
            matchId: outcome.matchIds[0] ?? null,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Failed to process completion of rescreen job ${jobId}`, err as Error);
    }
  }

  async enqueue(data: RescreenJobData): Promise<void> {
    await this.queue.add(`rescreen-${data.scheduleLabel.toLowerCase()}`, data);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents.close();
    await this.queue.close();
  }
}
