import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { TransactionIngestedEvent } from "../../transactions/transactions.events";
import { RuleEvaluationQueueService } from "../queue/rule-evaluation-queue.service";

/**
 * Section 2.1: "async evaluation via BullMQ: transaction.ingested event
 * handler enqueues an 'evaluate-rules' job." Unlike RiskModule's
 * TransactionListener, there is no debounce here — every ingested
 * transaction genuinely needs its own rule evaluation (a customer moving
 * money 10 times in a minute is exactly the pattern STRUCTURING/
 * RAPID_INFLOW_OUTFLOW/VELOCITY_SPIKE exist to catch, so collapsing those
 * events would defeat the rules).
 */
@Injectable()
export class TransactionListener {
  private readonly logger = new Logger(TransactionListener.name);

  constructor(private readonly ruleEvaluationQueueService: RuleEvaluationQueueService) {}

  @OnEvent("transaction.ingested")
  async onTransactionIngested(event: TransactionIngestedEvent): Promise<void> {
    try {
      await this.ruleEvaluationQueueService.enqueue({
        tenantId: event.tenantId,
        transactionId: event.transactionId,
      });
    } catch (err) {
      this.logger.error(`Failed to enqueue rule evaluation for transaction ${event.transactionId}`, err as Error);
    }
  }
}
