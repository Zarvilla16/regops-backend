import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RiskModule } from "../risk/risk.module";
import { ScreeningModule } from "../screening/screening.module";
import { CustomersService } from "./customers.service";
import { CustomersController } from "./customers.controller";
import { CustomerIngestionService } from "./ingestion/customer-ingestion.service";
import { CustomerIngestionController } from "./ingestion/customer-ingestion.controller";

@Module({
  imports: [AuditModule, RiskModule, ScreeningModule],
  controllers: [CustomersController, CustomerIngestionController],
  providers: [CustomersService, CustomerIngestionService],
  exports: [CustomersService],
})
export class CustomersModule {}
