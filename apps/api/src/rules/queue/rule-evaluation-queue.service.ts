import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Queue, QueueEvents } from "bullmq";
import { AlertSeverity, RULE_EVALUATION_QUEUE, RuleEvaluationJobData, RuleEvaluationJobResult } from "@regops/shared";
import { ALERT_EVENTS } from "../rules.events";

/** Duplicated from TransactionIngestionQueueService/AsyncScreeningQueueService
 * rather than shared — see those files' docblocks (bundled-vs-standalone
 * ioredis version conflict). */
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
 * Producer + QueueEvents bridge for RULE_EVALUATION_QUEUE. The job actually
 * runs in apps/worker (evaluate-rules.processor.ts) — a separate OS process
 * — so in-process EventEmitter2 alone can't see it complete; QueueEvents
 * listens on Redis pub/sub for lifecycle events from ANY process's Worker on
 * this queue, letting us re-emit alert.created / alert.critical_fired /
 * alert.escalated in-process once the real work is done, from the job's
 * returned RuleEvaluationJobResult. Exact mirror of
 * AsyncScreeningQueueService's pattern (apps/api/src/screening/) — see
 * HANDOFF.md's Prompt 5 deviations for why this queue originally shipped
 * with no bridge here (its consumer ran in this same process at the time).
 *
 * Also the one place CounterpartyScreeningService borrows a Redis connection
 * from (via getClient()) for its cross-invocation cache — same "borrow an
 * existing BullMQ connection rather than open a second ioredis client"
 * rationale as TransactionIngestionQueueService.acquireLock.
 */
@Injectable()
export class RuleEvaluationQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(RuleEvaluationQueueService.name);
  private readonly queue: Queue<RuleEvaluationJobData, RuleEvaluationJobResult>;
  private readonly queueEvents: QueueEvents;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://localhost:6379";
    const connection = parseRedisUrl(redisUrl);
    this.queue = new Queue(RULE_EVALUATION_QUEUE, { connection });

    this.queueEvents = new QueueEvents(RULE_EVALUATION_QUEUE, { connection });
    this.queueEvents.on("completed", ({ jobId }) => {
      void this.onJobCompleted(jobId);
    });
  }

  private async onJobCompleted(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job || !job.returnvalue) return;
      const result = job.returnvalue;

      for (const outcome of result.alerts) {
        if (outcome.wasInserted) {
          this.eventEmitter.emit(ALERT_EVENTS.CREATED, {
            tenantId: result.tenantId,
            alertId: outcome.alertId,
            ruleId: outcome.ruleId,
            customerId: outcome.customerId,
            scenarioType: outcome.scenarioType,
            severity: outcome.severity,
          });
          if (outcome.severity === AlertSeverity.CRITICAL) {
            this.eventEmitter.emit(ALERT_EVENTS.CRITICAL_FIRED, {
              tenantId: result.tenantId,
              alertId: outcome.alertId,
              ruleId: outcome.ruleId,
              customerId: outcome.customerId,
              scenarioType: outcome.scenarioType,
            });
          }
        } else {
          this.eventEmitter.emit(ALERT_EVENTS.ESCALATED, {
            tenantId: result.tenantId,
            alertId: outcome.alertId,
            ruleId: outcome.ruleId,
            customerId: outcome.customerId,
            fireCount: outcome.fireCount,
          });
        }
      }
    } catch (err) {
      this.logger.error(`Failed to process completion of rule-evaluation job ${jobId}`, err as Error);
    }
  }

  async enqueue(data: RuleEvaluationJobData): Promise<string> {
    const job = await this.queue.add("evaluate-rules", data);
    return job.id as string;
  }

  async getClient() {
    return this.queue.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents.close();
    await this.queue.close();
  }
}
