import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RiskModule } from "../risk/risk.module";
import { ScreeningModule } from "../screening/screening.module";
import { RulesModule } from "../rules/rules.module";
import { TenantsController } from "./tenants.controller";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [AuditModule, RiskModule, ScreeningModule, RulesModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
