import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
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
import { AlertFilters, AlertsService } from "./alerts.service";
import { ListAlertsDto } from "./dto/list-alerts.dto";
import { AssignAlertDto } from "./dto/assign-alert.dto";
import { BulkAssignAlertsDto } from "./dto/bulk-assign-alerts.dto";
import { CloseAlertDto } from "./dto/close-alert.dto";

const ANY_AUTHENTICATED = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR, UserRole.VIEWER];
const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

function splitList<T extends string>(value: string | undefined): T[] | undefined {
  return value ? (value.split(",").map((v) => v.trim()).filter(Boolean) as T[]) : undefined;
}

/** Maps the query string (API names plus the console's aliases) to service filters; shared by list and export. */
function toFilters(query: ListAlertsDto): AlertFilters {
  return {
    statuses: splitList<AlertStatus>(query.status),
    severities: splitList<AlertSeverity>(query.severity),
    // `scenario` is the console's name for scenario_type; both are accepted.
    scenarioTypes: splitList<RuleScenarioType>(query.scenario_type ?? query.scenario),
    ruleId: query.rule_id,
    customerId: query.customer_id,
    unassigned: query.assigned_to === "unassigned",
    assignedTo: query.assigned_to === "unassigned" ? undefined : query.assigned_to,
    firstFiredFrom: query.first_fired_from,
    firstFiredTo: query.first_fired_to,
    minFireCount: query.min_fire_count,
    createdFrom: query.created_from,
    createdTo: query.created_to,
    customerNameQuery: query.q,
  };
}

@ApiTags("alerts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Query() query: ListAlertsDto) {
    return this.alertsService.findAll(qr, tenantId, toFilters(query), query.page ?? 1, query.limit ?? 50);
  }

  // Static routes ("export", "bulk-assign") are declared before ":id" so they are never read as an alert id.
  @Get("export")
  @Roles(...ANY_AUTHENTICATED)
  async exportCsv(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Query() query: ListAlertsDto) {
    return this.alertsService.exportCsv(qr, tenantId, toFilters(query));
  }

  @Patch("bulk-assign")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async bulkAssign(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Body() dto: BulkAssignAlertsDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.alertsService.bulkAssign(qr, tenantId, dto.ids, dto.assignedTo, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }

  @Get(":id")
  @Roles(...ANY_AUTHENTICATED)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id", ParseUUIDPipe) id: string) {
    return this.alertsService.findDetail(qr, tenantId, id);
  }

  @Get(":id/related-transactions")
  @Roles(...ANY_AUTHENTICATED)
  async relatedTransactions(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id", ParseUUIDPipe) id: string) {
    return this.alertsService.relatedTransactions(qr, tenantId, id);
  }

  @Post(":id/assign")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async assign(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
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
    @Param("id", ParseUUIDPipe) id: string,
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
