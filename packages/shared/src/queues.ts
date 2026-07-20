/**
 * BullMQ queue name constants — both the producer (apps/api, which enqueues)
 * and the consumer (apps/worker, which registers a Worker under the same
 * name) must reference the exact same string. Centralized here so neither
 * side can drift.
 */
export const MAINTENANCE_QUEUE = "maintenance";
export const CUSTOMER_INGESTION_QUEUE = "customer-ingestion";
export const ASYNC_SCREENING_QUEUE = "async-screening";
export const RESCREEN_QUEUE = "rescreen";
/** One queue for both ingestion paths (Backend Prompt 4) — the SFTP poller
 * and the webhook controller both enqueue "ingest-transactions" jobs here;
 * the shared IngestionService processor doesn't care which producer added
 * the job, only the IngestionBatch row referenced by jobData.batchId. */
export const TRANSACTION_INGESTION_QUEUE = "transaction-ingestion";
/** Consumed in-process by apps/api itself (RuleEvaluationConsumerService),
 * not apps/worker — see packages/rules-engine's docblock / HANDOFF.md
 * Prompt 5 deviations for why: the HIGH_RISK_COUNTERPARTY evaluator needs
 * ScreeningService (Prompt 3's provider-strategy screening engine), which
 * only exists inside apps/api's NestJS DI container. Still a real,
 * independent BullMQ Queue/Worker — genuinely decoupled and asynchronous
 * from the ingestion request/response cycle, just not a second OS process. */
export const RULE_EVALUATION_QUEUE = "rule-evaluation";
