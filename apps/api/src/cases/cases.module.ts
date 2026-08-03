import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CaseEvidenceService } from "./case-evidence.service";
import { CaseNotesService } from "./case-notes.service";
import { CasesController } from "./cases.controller";
import { CasesService } from "./cases.service";
import { AlertStatusListener } from "./listeners/alert-status.listener";

/** Deliberately imports only AuditModule — every Customer/Alert/Transaction/
 * User row this module reads is accessed directly via @regops/db entities on
 * the request's own QueryRunner (same pattern AlertsService already uses for
 * TransactionEntity), so no CustomersModule/RulesModule/TransactionsModule
 * import is needed and the existing one-directional dependency rule
 * (nothing imports this module back) stays trivially true. */
@Module({
  imports: [AuditModule],
  controllers: [CasesController],
  providers: [CasesService, CaseNotesService, CaseEvidenceService, AlertStatusListener],
  exports: [CasesService, CaseNotesService, CaseEvidenceService],
})
export class CasesModule {}
