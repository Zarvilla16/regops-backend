import { Injectable } from "@nestjs/common";
import { QueryRunner } from "typeorm";
import { RuleEntity } from "@regops/db";
import { RuleScenarioType } from "@regops/shared";
import { EvaluationContext, EvaluatorFacts } from "@regops/rules-engine";
import { RuleFactsService } from "./rule-facts.service";
import { CounterpartyScreeningService } from "../counterparty/counterparty-screening.service";

/**
 * Single place that maps a Rule's scenario_type to the DB queries/screening
 * calls its evaluator needs, shared by RuleEvaluationOrchestratorService
 * (the real, async path off transaction.ingested) and RulesService.testRule
 * (POST /rules/:id/test's synchronous dry run) — both need byte-identical
 * fact-gathering so a dry run means what it says.
 */
@Injectable()
export class EvaluatorFactsGatheringService {
  constructor(
    private readonly ruleFactsService: RuleFactsService,
    private readonly counterpartyScreeningService: CounterpartyScreeningService,
  ) {}

  async gather(qr: QueryRunner, ctx: EvaluationContext, rule: RuleEntity): Promise<EvaluatorFacts> {
    switch (rule.scenarioType) {
      case RuleScenarioType.LARGE_CASH:
        return { scenarioType: rule.scenarioType };
      case RuleScenarioType.STRUCTURING: {
        const windowHours = Number(rule.config.windowHours ?? 24);
        const recentCashTxns = await this.ruleFactsService.fetchRecentCashTransactions(
          qr,
          ctx.tenantId,
          ctx.customer.id,
          ctx.transaction,
          windowHours,
        );
        return { scenarioType: rule.scenarioType, recentCashTxns };
      }
      case RuleScenarioType.RAPID_INFLOW_OUTFLOW: {
        const windowMinutes = Number(rule.config.windowMinutes ?? 60);
        const recentCredits = await this.ruleFactsService.fetchRecentCredits(
          qr,
          ctx.tenantId,
          ctx.customer.id,
          ctx.transaction,
          windowMinutes,
        );
        return { scenarioType: rule.scenarioType, recentCredits };
      }
      case RuleScenarioType.HIGH_RISK_COUNTERPARTY: {
        const screening = await this.counterpartyScreeningService.resolve(qr, ctx.tenantId, ctx.transaction, rule.config);
        return { scenarioType: rule.scenarioType, screening };
      }
      case RuleScenarioType.VELOCITY_SPIKE: {
        const historyDays = Number(rule.config.historyDays ?? 30);
        const stats = await this.ruleFactsService.fetchVelocityRawStats(
          qr,
          ctx.tenantId,
          ctx.customer.id,
          historyDays,
          ctx.now,
          ctx.customer.onboardedAt,
        );
        return { scenarioType: rule.scenarioType, stats };
      }
    }
  }
}
