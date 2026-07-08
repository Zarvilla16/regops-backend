/**
 * Shapes shared between the producer (apps/api's CustomerIngestionService,
 * which enqueues and later reads job.returnvalue) and the consumer
 * (apps/worker's ingestion-job.processor.ts, which does the real work) —
 * both must agree on this without either importing the other's source
 * across the app boundary.
 */
export type DuplicateStrategy = "skip" | "update";

export interface IngestionJobData {
  tenantId: string;
  jobId: string;
  storageKey: string;
  duplicateStrategy: DuplicateStrategy;
  /** user_id of whoever called POST /customers/batch — attributes the batch's audit log entries. */
  uploadedBy: string;
}

export interface IngestionJobResult {
  total: number;
  succeeded: number;
  failed: number;
  errorReportKey: string | null;
}
