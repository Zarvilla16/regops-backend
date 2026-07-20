import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { RiskFactorConfigService } from "./config/risk-factor-config.service";
import { RiskService } from "./risk.service";
import { RiskController } from "./risk.controller";
import { RescoreSchedulerService } from "./scheduler/rescore-scheduler.service";
import { TransactionListener } from "./listeners/transaction.listener";

@Module({
  imports: [AuditModule, TransactionsModule],
  controllers: [RiskController],
  providers: [RiskFactorConfigService, RiskService, RescoreSchedulerService, TransactionListener],
  exports: [RiskFactorConfigService, RiskService],
})
export class RiskModule {}
