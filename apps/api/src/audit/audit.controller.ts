import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { AuditService } from "./audit.service";
import { QueryRunner } from "typeorm";

@ApiTags("audit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller("audit-logs")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = limit ? Math.min(Number(limit), 200) : 50;
    return this.auditService.findForTenant(queryRunner, tenantId, parsedLimit);
  }
}
