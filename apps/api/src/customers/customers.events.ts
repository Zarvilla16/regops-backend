/** Event name constants — subscribers (this module or others) should reference these, not string literals. */
export const CUSTOMER_EVENTS = {
  CREATED: "customer.created",
  UPDATED: "customer.updated",
  DELETED: "customer.deleted",
  RISK_CHANGED: "customer.risk_changed",
  BATCH_INGEST_COMPLETED: "customer.batch_ingest_completed",
} as const;

export interface CustomerCreatedEvent {
  tenantId: string;
  customerId: string;
  cbsCustomerId: string;
}

export interface CustomerUpdatedEvent {
  tenantId: string;
  customerId: string;
  changedFields: string[];
}

export interface CustomerDeletedEvent {
  tenantId: string;
  customerId: string;
  reason: string;
}

export interface CustomerBatchIngestCompletedEvent {
  tenantId: string;
  jobId: string;
  total: number;
  succeeded: number;
  failed: number;
}
