import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { QueryRunner } from "typeorm";
import { CustomerEntity } from "@regops/db";
import { AuthUserContext, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RiskService } from "./risk.service";

@ApiTags("risk")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("customers")
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Post(":id/rescore")
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async rescore(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const customer = await queryRunner.manager.getRepository(CustomerEntity).findOne({ where: { tenantId, id } });
    if (!customer) {
      throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });
    }
    return this.riskService.rescoreManual(queryRunner, customer, currentUser);
  }

  @Get(":id/risk-history")
  async riskHistory(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedPage = Math.max(Number(page) || 1, 1);
    const parsedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    return this.riskService.findHistoryForCustomer(queryRunner, tenantId, id, parsedPage, parsedLimit);
  }
}
