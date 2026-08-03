import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CasesController } from "./cases.controller";
import { CasesService } from "./cases.service";

/** Deliberately imports only AuditModule — every Customer/Alert/Transaction/
 * User row this module reads is accessed directly via @regops/db entities on
 * the request's own QueryRunner (same pattern AlertsService already uses for
 * TransactionEntity), so no CustomersModule/RulesModule/TransactionsModule
 * import is needed and the existing one-directional dependency rule
 * (nothing imports this module back) stays trivially true. */
@Module({
  imports: [AuditModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
