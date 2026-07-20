import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { QueryRunner } from "typeorm";
import { UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { TenantGuard } from "../../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CustomerAccountsService } from "./customer-accounts.service";
import { CreateCustomerAccountDto } from "./dto/create-customer-account.dto";

const ANY_AUTHENTICATED = [
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_ADMIN,
  UserRole.COMPLIANCE_OFFICER,
  UserRole.INVESTIGATOR,
  UserRole.VIEWER,
];

@ApiTags("customer-accounts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("customer-accounts")
export class CustomerAccountsController {
  constructor(private readonly customerAccountsService: CustomerAccountsService) {}

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async create(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Body() dto: CreateCustomerAccountDto) {
    const account = await this.customerAccountsService.create(queryRunner, tenantId, {
      customerId: dto.customer_id,
      accountNumber: dto.account_number,
      accountType: dto.account_type,
      accountName: dto.account_name,
    });
    return this.customerAccountsService.toDto(account);
  }

  @Get()
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Query("customer_id") customerId?: string) {
    const accounts = await this.customerAccountsService.findByCustomer(queryRunner, tenantId, customerId);
    return accounts.map((a) => this.customerAccountsService.toDto(a));
  }
}
