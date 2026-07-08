import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RiskFactorConfigService } from "./config/risk-factor-config.service";
import { RiskService } from "./risk.service";
import { RiskController } from "./risk.controller";
import { RescoreSchedulerService } from "./scheduler/rescore-scheduler.service";

@Module({
  imports: [AuditModule],
  controllers: [RiskController],
  providers: [RiskFactorConfigService, RiskService, RescoreSchedulerService],
  exports: [RiskFactorConfigService, RiskService],
})
export class RiskModule {}
