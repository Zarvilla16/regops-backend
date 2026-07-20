import { Module } from "@nestjs/common";
import { TransactionsService } from "./transactions.service";
import { TransactionsController } from "./transactions.controller";
import { VelocityAdapterService } from "./velocity-adapter.service";
import { CustomerAccountsService } from "./customer-accounts/customer-accounts.service";
import { CustomerAccountsController } from "./customer-accounts/customer-accounts.controller";
import { BatchesController } from "./batches/batches.controller";
import { IngestionBatchService } from "./ingestion/ingestion-batch.service";
import { TransactionIngestionQueueService } from "./ingestion/ingestion-queue.service";
import { WebhookSignatureGuard } from "./ingestion/webhook-signature.guard";
import { WebhookController } from "./ingestion/webhook.controller";
import { SftpInboxController } from "./ingestion/sftp-inbox.controller";

/**
 * No RiskModule/AuditModule import here even though this module's stub
 * customer creation (worker-side, apps/worker/src/transactions/resolution.ts)
 * and re-score debounce conceptually relate to risk — that logic lives in
 * apps/worker (a separate process, no shared DI container) and RiskModule
 * respectively. Keeping the dependency one-directional (RiskModule imports
 * THIS module for VelocityAdapterService/TransactionIngestionQueueService,
 * never the reverse) avoids a circular module graph — see
 * RiskModule/TransactionListener's docblocks.
 */
@Module({
  // BatchesController MUST be registered before TransactionsController:
  // Nest/Express match routes in registration order, and TransactionsController's
  // `GET /transactions/:id` would otherwise swallow `GET /transactions/batches`
  // (treating "batches" as the :id param) before BatchesController's more
  // specific route ever gets a chance to match — caught live via the manual
  // Prompt 4 test guide walkthrough, not by the automated e2e suite, which
  // never happened to call GET /transactions/batches by that exact path.
  controllers: [BatchesController, TransactionsController, CustomerAccountsController, WebhookController, SftpInboxController],
  providers: [
    TransactionsService,
    VelocityAdapterService,
    CustomerAccountsService,
    IngestionBatchService,
    TransactionIngestionQueueService,
    WebhookSignatureGuard,
  ],
  exports: [VelocityAdapterService, TransactionIngestionQueueService],
})
export class TransactionsModule {}
