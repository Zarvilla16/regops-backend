import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CasesModule } from "../cases/cases.module";
import { CtrGenerationListener } from "./listeners/ctr-generation.listener";
import { ReportExportService } from "./report-export.service";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

/** Depends one-way on CasesModule (derived transactions/customer summary); CasesModule does NOT import this
 * module — Cases.approve() creates the SAR draft row itself using report-drafting.ts's pure helpers. */
@Module({
  imports: [AuditModule, CasesModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportExportService, CtrGenerationListener],
  exports: [ReportsService],
})
export class ReportsModule {}
