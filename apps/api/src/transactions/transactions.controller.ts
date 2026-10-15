import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { QueryRunner } from "typeorm";
import { TransactionChannel, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { TransactionsService } from "./transactions.service";
import { ListTransactionsDto } from "./dto/list-transactions.dto";

const ANY_AUTHENTICATED = [
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_ADMIN,
  UserRole.COMPLIANCE_OFFICER,
  UserRole.INVESTIGATOR,
  UserRole.VIEWER,
];
const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

@ApiTags("transactions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get("transactions")
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Query() query: ListTransactionsDto) {
    return this.transactionsService.findAll(
      queryRunner,
      tenantId,
      {
        customerId: query.customer_id,
        accountNumber: query.account_number,
        counterpartyAccount: query.counterparty_account,
        counterpartyCustomerId: query.counterparty_customer_id,
        type: query.type,
        channels: query.channel?.split(",") as TransactionChannel[] | undefined,
        amountMin: query.amount_min,
        amountMax: query.amount_max,
        occurredFrom: query.occurred_from,
        occurredTo: query.occurred_to,
        source: query.source,
        ingestionBatchId: query.ingestion_batch_id,
      },
      query.page,
      query.limit,
    );
  }

  // Declared before "transactions/:id" so "stats" is never read as a transaction id.
  @Get("transactions/stats")
  @Roles(...ANY_AUTHENTICATED)
  async stats(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner) {
    return this.transactionsService.getStats(queryRunner, tenantId);
  }

  @Get("transactions/:id")
  @Roles(...ANY_AUTHENTICATED)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.findById(queryRunner, tenantId, id);
  }

  @Get("customers/:id/transactions")
  @Roles(...ANY_AUTHENTICATED)
  async forCustomer(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id", ParseUUIDPipe) customerId: string,
    @Query() query: ListTransactionsDto,
  ) {
    return this.transactionsService.findAll(
      queryRunner,
      tenantId,
      { ...buildFilters(query), customerId },
      query.page,
      query.limit,
    );
  }

  @Get("customers/:id/velocity-stats")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async velocityStats(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id", ParseUUIDPipe) customerId: string,
  ) {
    return this.transactionsService.getVelocityStats(queryRunner, tenantId, customerId);
  }
}

function buildFilters(query: ListTransactionsDto) {
  return {
    accountNumber: query.account_number,
    counterpartyAccount: query.counterparty_account,
    counterpartyCustomerId: query.counterparty_customer_id,
    type: query.type,
    channels: query.channel?.split(",") as TransactionChannel[] | undefined,
    amountMin: query.amount_min,
    amountMax: query.amount_max,
    occurredFrom: query.occurred_from,
    occurredTo: query.occurred_to,
    source: query.source,
    ingestionBatchId: query.ingestion_batch_id,
  };
}
