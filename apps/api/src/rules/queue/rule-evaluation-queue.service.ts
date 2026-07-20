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

  /**
   * `jobId: data.transactionId` makes this call idempotent across
   * `apps/api` replicas — deliberately, not incidentally. `transaction.
   * ingested` is itself raised by `TransactionIngestionQueueService`'s own
   * `QueueEvents` bridge, which every live `apps/api` instance runs a copy
   * of; Redis pub/sub fans that bridge's "completed" notification out to
   * every subscriber, so N running instances each independently observe the
   * same completion and each call `TransactionListener.onTransactionIngested`
   * → this method, once per instance, for the same transaction. Without a
   * deterministic jobId, BullMQ's `Queue.add` treats each of those N calls
   * as a distinct job (auto-generated id), so the transaction gets evaluated
   * N times — wasted evaluation work, not a correctness bug (the alert-layer
   * dedup-key UPSERT already collapses any resulting duplicate fires into
   * one `Alert` row), but real, growing CPU/DB cost as replica count grows.
   * `transactionId` is a UUID, globally unique on its own (no tenantId
   * prefix needed), and this is the method's only call site with no
   * legitimate case for two independent concurrent jobs over the same
   * transaction — so `Queue.add` silently returning the already-enqueued
   * job's reference on the 2nd..Nth call (BullMQ's documented behavior for
   * a jobId still present in the queue) is exactly the desired outcome:
   * exactly one job actually runs, whichever instance's `.add()` call
   * reaches Redis first. This does not change retry/failure handling at
   * all — that's entirely a Worker-side concern (`apps/worker`'s stalled-job
   * detection and any configured `attempts`), orthogonal to how the job was
   * created. Same "deterministic jobId so multiple producers collapse to one
   * job" idiom `TransactionIngestionQueueService.enqueue` already uses
   * (`jobId: data.batchId`), applied here for the same reason it matters —
   * multiple things able to independently produce the same logical unit of
   * work.
   */
  async enqueue(data: RuleEvaluationJobData): Promise<string> {
    const job = await this.queue.add("evaluate-rules", data, { jobId: data.transactionId });
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
