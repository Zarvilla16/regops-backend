import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Worker } from "bullmq";
import { RULE_EVALUATION_QUEUE, RuleEvaluationJobData } from "@regops/shared";
import { RuleEvaluationOrchestratorService } from "../evaluation/rule-evaluation-orchestrator.service";

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

const CONCURRENCY = 5;

/**
 * Section 4/5.2's "evaluate-rules BullMQ processor," adapted to run inside
 * apps/api rather than apps/worker (see HANDOFF.md's Prompt 5 deviations) —
 * still a genuine, separate `bullmq` Worker consuming RULE_EVALUATION_QUEUE
 * asynchronously, just in the same OS process as the producer
 * (RuleEvaluationQueueService/TransactionListener) and the EventEmitter2
 * that the alert/rule events go through. A plain hand-rolled `Worker`, not
 * `@nestjs/bullmq`'s decorator style shown in the spec's own pseudocode —
 * this codebase has never depended on `@nestjs/bullmq`, and every other
 * queue integration (TransactionIngestionQueueService, AsyncScreeningQueueService)
 * already uses raw `bullmq` directly.
 */
@Injectable()
export class RuleEvaluationConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuleEvaluationConsumerService.name);
  private worker!: Worker<RuleEvaluationJobData>;

  constructor(
    private readonly configService: ConfigService,
    private readonly orchestrator: RuleEvaluationOrchestratorService,
  ) {}

  onModuleInit(): void {
    const redisUrl = this.configService.get<string>("redis.url") ?? "redis://localhost:6379";
    const connection = parseRedisUrl(redisUrl);
    this.worker = new Worker<RuleEvaluationJobData>(
      RULE_EVALUATION_QUEUE,
      async (job: Job<RuleEvaluationJobData>) => {
        await this.orchestrator.evaluateTransaction(job.data.tenantId, job.data.transactionId);
      },
      { connection, concurrency: CONCURRENCY },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(`rule-evaluation job ${job?.id} failed`, err as Error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }
}
