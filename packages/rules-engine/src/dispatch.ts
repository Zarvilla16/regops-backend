import { RuleScenarioType } from "@regops/shared";
import { EvaluationContext, EvaluationResult } from "./types";
import { evaluateLargeCash, LargeCashConfig } from "./evaluators/large-cash.evaluator";
import { evaluateStructuring, RecentCashTransaction, StructuringConfig } from "./evaluators/structuring.evaluator";
import {
  evaluateRapidInflowOutflow,
  RapidInflowOutflowConfig,
  RecentCredit,
} from "./evaluators/rapid-inflow-outflow.evaluator";
import {
  CounterpartyScreeningFacts,
  evaluateHighRiskCounterparty,
  HighRiskCounterpartyConfig,
} from "./evaluators/high-risk-counterparty.evaluator";
import { evaluateVelocitySpike, VelocityRawStats, VelocitySpikeConfig } from "./evaluators/velocity-spike.evaluator";

/**
 * Per-scenario pre-fetched facts — the orchestrator (apps/api's
 * RuleEvaluationOrchestratorService) gathers these via
 * packages/db/src/queries/rule-facts.ts before calling dispatchEvaluation.
 * LARGE_CASH needs nothing beyond EvaluationContext itself.
 */
export type EvaluatorFacts =
  | { scenarioType: RuleScenarioType.LARGE_CASH }
  | { scenarioType: RuleScenarioType.STRUCTURING; recentCashTxns: RecentCashTransaction[] }
  | { scenarioType: RuleScenarioType.RAPID_INFLOW_OUTFLOW; recentCredits: RecentCredit[] }
  | { scenarioType: RuleScenarioType.HIGH_RISK_COUNTERPARTY; screening: CounterpartyScreeningFacts | null }
  | { scenarioType: RuleScenarioType.VELOCITY_SPIKE; stats: VelocityRawStats };

/**
 * This IS the "evaluator registry" (spec Section 5's EvaluatorRegistry): a
 * plain, framework-free dispatch function rather than a DI-registered class
 * map, since each scenario's facts shape is different (a class-based
 * `RuleEvaluator` interface with one `evaluate(ctx)` signature, as the spec's
 * pseudocode shows, would force facts-gathering back inside the evaluator —
 * which needs a QueryRunner this package deliberately has no dependency on).
 * apps/api's orchestrator resolves `rule.scenarioType` to a config type and
 * calls this with the matching config/facts pair.
 */
export function dispatchEvaluation(
  ctx: EvaluationContext,
  config: Record<string, unknown>,
  facts: EvaluatorFacts,
): EvaluationResult {
  switch (facts.scenarioType) {
    case RuleScenarioType.LARGE_CASH:
      return evaluateLargeCash(ctx, config as LargeCashConfig);
    case RuleScenarioType.STRUCTURING:
      return evaluateStructuring(ctx, config as StructuringConfig, facts.recentCashTxns);
    case RuleScenarioType.RAPID_INFLOW_OUTFLOW:
      return evaluateRapidInflowOutflow(ctx, config as RapidInflowOutflowConfig, facts.recentCredits);
    case RuleScenarioType.HIGH_RISK_COUNTERPARTY:
      return evaluateHighRiskCounterparty(ctx, config as HighRiskCounterpartyConfig, facts.screening);
    case RuleScenarioType.VELOCITY_SPIKE:
      return evaluateVelocitySpike(ctx, config as VelocitySpikeConfig, facts.stats);
  }
}
