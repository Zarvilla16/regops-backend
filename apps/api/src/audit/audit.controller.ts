import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { QueryRunner } from "typeorm";
import { UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { AuditService } from "./audit.service";
import { ListAuditLogsDto } from "./dto/list-audit-logs.dto";

@ApiTags("audit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
// The audit trail records who did what to whom (including failed logins and PII reveals), so it is limited to
// the roles that supervise the platform. Investigators and viewers do not need it.
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
@Controller("audit-logs")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  async list(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Query() query: ListAuditLogsDto,
  ) {
    return this.auditService.findPage(
      queryRunner,
      tenantId,
      {
        userId: query.user_id,
        entityTypes: query.entity_type?.split(",").map((v) => v.trim()).filter(Boolean),
        entityId: query.entity_id,
        action: query.action,
        dateFrom: query.date_from,
        dateTo: query.date_to,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );
  }
}
