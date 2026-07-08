/**
 * BullMQ queue name constants — both the producer (apps/api, which enqueues)
 * and the consumer (apps/worker, which registers a Worker under the same
 * name) must reference the exact same string. Centralized here so neither
 * side can drift.
 */
export const MAINTENANCE_QUEUE = "maintenance";
export const CUSTOMER_INGESTION_QUEUE = "customer-ingestion";
