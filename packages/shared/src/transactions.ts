import { TransactionChannel, TransactionSource, TransactionType } from "./enums";

/**
 * Shapes shared between the producer (apps/api's ingestion controllers,
 * which enqueue and later read job.returnvalue via a QueueEvents bridge —
 * same CustomerIngestionService pattern) and the consumer (apps/worker's
 * transactions/ingestion-processor.ts, which does the real work). Both
 * ingestion paths (SFTP-poll and webhook) enqueue this same job shape —
 * only `source` and how `storageKey`/`rows` got populated differ.
 */
export interface TransactionIngestionJobData {
  tenantId: string;
  batchId: string;
  source: TransactionSource;
  /** Set when the batch came from a file (SFTP-emulated inbox) — the
   * processor streams and chunks this key via FileStorage. Mutually
   * exclusive with `rows`. */
  storageKey?: string;
  /** Set when the batch came from the webhook path — small enough
   * (<=1000 rows) to pass through the job payload directly rather than
   * round-tripping through FileStorage. Mutually exclusive with `storageKey`. */
  rows?: unknown[];
}

/**
 * One entry per row actually inserted — apps/api's
 * TransactionIngestionQueueService replays these as `transaction.ingested`
 * EventEmitter2 events once it sees the job complete (the insert itself
 * happens in this worker process, which has no EventEmitter2 of its own).
 * Fine at pilot-MFB batch sizes; replaying an entire 100k-row SFTP batch
 * this way is a known v2 scaling concern (same spirit as the spec's own
 * CustomerDailyStats v2 TODO) — see HANDOFF.md.
 */
export interface IngestedTransactionSummary {
  transactionId: string;
  customerId: string;
  amount: string;
  currency: string;
  type: TransactionType;
  channel: TransactionChannel;
  counterpartyCustomerId: string | null;
  occurredAt: string;
  source: TransactionSource;
}

export interface TransactionIngestionJobResult {
  total: number;
  succeeded: number;
  failed: number;
  errorReportKey: string | null;
  insertedTransactions: IngestedTransactionSummary[];
}
