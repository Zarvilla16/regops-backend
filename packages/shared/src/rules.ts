import { AlertSeverity, RuleScenarioType } from "./enums";

/**
 * Job payload for RULE_EVALUATION_QUEUE — deliberately just the two ids, not
 * a denormalized transaction snapshot. Same cross-process reasoning as
 * TransactionIngestionJobData (apps/api producer -> apps/worker consumer,
 * via RuleEvaluationQueueService / evaluate-rules.processor.ts): the
 * consumer re-fetches the transaction/customer rows itself on its own
 * QueryRunner rather than trusting a payload that could go stale between
 * enqueue and processing.
 */
export interface RuleEvaluationJobData {
  tenantId: string;
  transactionId: string;
}

/** One Alert created-or-escalated as a result of evaluating a transaction's
 * active rules. `wasInserted` distinguishes a brand-new Alert (fire_count=1)
 * from an existing one that just had its fire_count incremented — same
 * ALERT_EVENTS.CREATED/CRITICAL_FIRED vs ALERT_EVENTS.ESCALATED split
 * RuleEvaluationOrchestratorService used to make in-process (see
 * RuleEvaluationQueueService's QueueEvents bridge, which now re-derives the
 * same split from this field since the real work runs in apps/worker). */
export interface RuleEvaluationAlertOutcome {
  alertId: string;
  ruleId: string;
  customerId: string;
  scenarioType: RuleScenarioType;
  severity: AlertSeverity;
  wasInserted: boolean;
  fireCount: number;
}

export interface RuleEvaluationJobResult {
  tenantId: string;
  transactionId: string;
  alerts: RuleEvaluationAlertOutcome[];
}
