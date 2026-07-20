import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { RulesService } from "./rules.service";
import { RuleReplayService } from "./replay/rule-replay.service";
import { UpdateRuleDto } from "./dto/update-rule.dto";
import { TestRuleDto } from "./dto/test-rule.dto";

const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

@ApiTags("rules")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("rules")
export class RulesController {
  constructor(
    private readonly rulesService: RulesService,
    private readonly ruleReplayService: RuleReplayService,
  ) {}

  @Get()
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner) {
    return this.rulesService.findAll(qr, tenantId);
  }

  // Registered before GET ":id" — "replays" would otherwise be swallowed as
  // an :id param value by the more general route (same route-ordering trap
  // documented on TransactionsModule's BatchesController).
  @Get("replays/:replayId")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async replayStatus(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("replayId") replayId: string) {
    return this.ruleReplayService.findById(qr, tenantId, replayId);
  }

  @Get(":id")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.rulesService.findOne(qr, tenantId, id);
  }

  @Patch(":id")
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: UpdateRuleDto,
    @Headers("x-confirm-loosening") confirmLoosening: string | undefined,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.rulesService.update(qr, tenantId, id, dto, confirmLoosening === "true", currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }

  @Post(":id/test")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async test(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: TestRuleDto,
  ) {
    return this.rulesService.testRule(qr, tenantId, id, dto.transactionId);
  }
}
