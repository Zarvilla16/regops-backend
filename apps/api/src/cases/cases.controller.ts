import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext, CasePriority, CaseStatus, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { CasesService } from "./cases.service";
import { CreateCaseDto } from "./dto/create-case.dto";
import { ListCasesDto } from "./dto/list-cases.dto";

export const ANY_AUTHENTICATED = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR, UserRole.VIEWER];
export const CREATE_ROLES = [UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR];

export function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

@ApiTags("cases")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("cases")
export class CasesController {
  constructor(private readonly casesService: CasesService) {}

  @Post()
  @Roles(...CREATE_ROLES)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Body() dto: CreateCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.create(qr, tenantId, dto, currentUser, requestMeta(req));
  }

  @Get()
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Query() query: ListCasesDto) {
    const limit = Math.min(query.limit ?? 25, 100);
    return this.casesService.list(
      qr,
      tenantId,
      {
        statuses: query.status?.split(",") as CaseStatus[] | undefined,
        priorities: query.priority?.split(",") as CasePriority[] | undefined,
        assignedTo: query.assigned_to,
        q: query.q,
      },
      query.page ?? 1,
      limit,
    );
  }

  @Get(":id")
  @Roles(...ANY_AUTHENTICATED)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.casesService.toDetail(qr, tenantId, id);
  }
}
