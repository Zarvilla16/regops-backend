import { TransactionChannel, TransactionSource, TransactionType } from "@regops/shared";

/** Dot-separated, lowercase-snake — same convention as CUSTOMER_EVENTS/SCREENING_EVENTS. */
export const TRANSACTION_EVENTS = {
  INGESTED: "transaction.ingested",
  BATCH_QUEUED: "transaction.batch.queued",
  BATCH_COMPLETED: "transaction.batch.completed",
  BATCH_FAILED: "transaction.batch.failed",
} as const;

/**
 * Emitted once per successfully ingested transaction, after the row is
 * committed (spec Section 8.1). The row insert itself happens in
 * apps/worker (a separate OS process with no EventEmitter2) — this event is
 * actually raised by TransactionIngestionQueueService's QueueEvents bridge
 * once it sees the job complete and reads these summaries back out of
 * job.returnvalue, same cross-process pattern as
 * AsyncScreeningQueueService/CustomerIngestionService.
 */
export interface TransactionIngestedEvent {
  tenantId: string;
  transactionId: string;
  customerId: string;
  amount: string;
  currency: string;
  type: TransactionType;
  channel: TransactionChannel;
  counterpartyCustomerId: string | null;
  occurredAt: string;
  ingestionBatchId: string;
  source: TransactionSource;
}

export interface TransactionBatchQueuedEvent {
  tenantId: string;
  batchId: string;
  source: TransactionSource;
}

export interface TransactionBatchCompletedEvent {
  tenantId: string;
  batchId: string;
  total: number;
  succeeded: number;
  failed: number;
}

export interface TransactionBatchFailedEvent {
  tenantId: string;
  batchId: string;
  reason: string;
}
