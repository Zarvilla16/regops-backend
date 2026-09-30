"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RULE_EVALUATION_QUEUE = exports.TRANSACTION_INGESTION_QUEUE = exports.RESCREEN_QUEUE = exports.ASYNC_SCREENING_QUEUE = exports.CUSTOMER_INGESTION_QUEUE = exports.MAINTENANCE_QUEUE = void 0;
/**
 * BullMQ queue name constants — both the producer (apps/api, which enqueues)
 * and the consumer (apps/worker, which registers a Worker under the same
 * name) must reference the exact same string. Centralized here so neither
 * side can drift.
 */
exports.MAINTENANCE_QUEUE = "maintenance";
exports.CUSTOMER_INGESTION_QUEUE = "customer-ingestion";
exports.ASYNC_SCREENING_QUEUE = "async-screening";
exports.RESCREEN_QUEUE = "rescreen";
/** One queue for both ingestion paths (Backend Prompt 4) — the SFTP poller
 * and the webhook controller both enqueue "ingest-transactions" jobs here;
 * the shared IngestionService processor doesn't care which producer added
 * the job, only the IngestionBatch row referenced by jobData.batchId. */
exports.TRANSACTION_INGESTION_QUEUE = "transaction-ingestion";
/** Producer (apps/api's RuleEvaluationQueueService, off transaction.ingested)
 * and consumer (apps/worker's evaluate-rules.processor.ts) split the same way
 * as every other cross-app queue — see HANDOFF.md's Prompt 5 deviations for
 * why this one originally shipped consumed in-process by apps/api instead,
 * and the follow-up session that moved it to match this convention. */
exports.RULE_EVALUATION_QUEUE = "rule-evaluation";
//# sourceMappingURL=queues.js.map