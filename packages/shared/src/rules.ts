/**
 * Job payload for RULE_EVALUATION_QUEUE — deliberately just the two ids, not
 * a denormalized transaction snapshot. Unlike TransactionIngestionJobData
 * (cross-process, apps/api -> apps/worker), this job is consumed in the same
 * process that produced it (RuleEvaluationConsumerService, apps/api), so the
 * consumer re-fetches the transaction/customer rows itself on its own
 * QueryRunner rather than trusting a payload that could go stale between
 * enqueue and processing.
 */
export interface RuleEvaluationJobData {
  tenantId: string;
  transactionId: string;
}
