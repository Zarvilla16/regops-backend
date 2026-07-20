import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AlertSeverity, AlertStatus, AuthUserContext, RuleScenarioType, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { TenantGuard } from "../../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { AlertsService } from "./alerts.service";
import { ListAlertsDto } from "./dto/list-alerts.dto";
import { AssignAlertDto } from "./dto/assign-alert.dto";
import { CloseAlertDto } from "./dto/close-alert.dto";

const ANY_AUTHENTICATED = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR, UserRole.VIEWER];
const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

@ApiTags("alerts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Query() query: ListAlertsDto) {
    return this.alertsService.findAll(
      qr,
      tenantId,
      {
        statuses: query.status?.split(",") as AlertStatus[] | undefined,
        severities: query.severity?.split(",") as AlertSeverity[] | undefined,
        scenarioTypes: query.scenario_type?.split(",") as RuleScenarioType[] | undefined,
        ruleId: query.rule_id,
        customerId: query.customer_id,
        assignedTo: query.assigned_to,
        firstFiredFrom: query.first_fired_from,
        firstFiredTo: query.first_fired_to,
        minFireCount: query.min_fire_count,
      },
      query.page ?? 1,
      query.limit ?? 50,
    );
  }

  @Get(":id")
  @Roles(...ANY_AUTHENTICATED)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.alertsService.toDto(await this.alertsService.findOne(qr, tenantId, id));
  }

  @Get(":id/related-transactions")
  @Roles(...ANY_AUTHENTICATED)
  async relatedTransactions(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.alertsService.relatedTransactions(qr, tenantId, id);
  }

  @Post(":id/assign")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async assign(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: AssignAlertDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.alertsService.assign(qr, tenantId, id, dto.assignedTo, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }

  @Post(":id/close")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async close(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: CloseAlertDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.alertsService.close(qr, tenantId, id, dto.category, dto.reason, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }
}
