import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { RULE_EVALUATION_QUEUE, RuleEvaluationJobData } from "@regops/shared";

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
 * Producer for RULE_EVALUATION_QUEUE. Unlike TransactionIngestionQueueService,
 * there is no QueueEvents completion bridge here — the consumer
 * (RuleEvaluationConsumerService) runs in this SAME process (see
 * HANDOFF.md's Prompt 5 deviations for why), so it emits the alert.created /
 * alert.escalated / etc. EventEmitter2 events directly rather than a second
 * process reading job.returnvalue back out.
 *
 * Also the one place CounterpartyScreeningService borrows a Redis connection
 * from (via getClient()) for its cross-invocation cache — same "borrow an
 * existing BullMQ connection rather than open a second ioredis client"
 * rationale as TransactionIngestionQueueService.acquireLock.
 */
@Injectable()
export class RuleEvaluationQueueService implements OnModuleDestroy {
  private readonly queue: Queue<RuleEvaluationJobData>;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://localhost:6379";
    const connection = parseRedisUrl(redisUrl);
    this.queue = new Queue(RULE_EVALUATION_QUEUE, { connection });
  }

  async enqueue(data: RuleEvaluationJobData): Promise<string> {
    const job = await this.queue.add("evaluate-rules", data);
    return job.id as string;
  }

  async getClient() {
    return this.queue.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
