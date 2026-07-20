import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { ScreeningModule } from "../screening/screening.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { RulesController } from "./rules.controller";
import { RulesService } from "./rules.service";
import { AlertsController } from "./alerts/alerts.controller";
import { AlertsService } from "./alerts/alerts.service";
import { RuleFactsService } from "./facts/rule-facts.service";
import { EvaluatorFactsGatheringService } from "./facts/evaluator-facts-gathering.service";
import { CounterpartyScreeningService } from "./counterparty/counterparty-screening.service";
import { RuleEvaluationOrchestratorService } from "./evaluation/rule-evaluation-orchestrator.service";
import { RuleEvaluationQueueService } from "./queue/rule-evaluation-queue.service";
import { RuleEvaluationConsumerService } from "./queue/rule-evaluation-consumer.service";
import { TransactionListener } from "./listeners/transaction.listener";
import { RuleReplayService } from "./replay/rule-replay.service";

/**
 * One module for both RulesController and AlertsController (same shape as
 * ScreeningModule housing ScreeningController + MatchReviewController) —
 * Rules and Alerts are tightly coupled (rules fire alerts; alerts always
 * reference a rule) and every consumer needs both together, so a separate
 * AlertsModule would only add DI wiring with no isolation benefit.
 *
 * Imports TransactionsModule (VelocityAdapterService's sibling query
 * pattern, and the transaction.ingested event TransactionListener here
 * subscribes to) and ScreeningModule (ScreeningService, for
 * CounterpartyScreeningService) one-directionally — neither imports this
 * module back, same rule as RiskModule/ScreeningModule's own docblocks.
 */
@Module({
  imports: [AuditModule, TransactionsModule, ScreeningModule],
  controllers: [RulesController, AlertsController],
  providers: [
    RulesService,
    AlertsService,
    RuleFactsService,
    EvaluatorFactsGatheringService,
    CounterpartyScreeningService,
    RuleEvaluationOrchestratorService,
    RuleEvaluationQueueService,
    RuleEvaluationConsumerService,
    TransactionListener,
    RuleReplayService,
  ],
  exports: [RulesService],
})
export class RulesModule {}
