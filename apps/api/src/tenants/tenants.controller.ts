import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { Idempotent } from "../common/decorators/idempotent.decorator";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { SwitchTenantDto } from "./dto/switch-tenant.dto";
import { UpdateCurrentTenantDto } from "./dto/update-current-tenant.dto";
import { TenantsService } from "./tenants.service";
import type { AuthUserContext } from "@regops/shared";

@ApiTags("tenants")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("tenants")
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN)
  async list() {
    const tenants = await this.tenantsService.findAll();
    return tenants.map((t) => this.tenantsService.toDto(t));
  }

  // Declared before ":id" so "current" is never parsed as a tenant id.
  /** The tenant the request is scoped to: the caller's own, or the X-Tenant-Override one for a Super Admin. */
  @Get("current")
  @UseGuards(TenantGuard)
  async current(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner) {
    const tenant = await this.tenantsService.findCurrent(queryRunner, tenantId);
    if (!tenant) {
      throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found." });
    }
    return this.tenantsService.toDto(tenant);
  }

  @Patch("current")
  @Idempotent()
  @UseGuards(TenantGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  async updateCurrent(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Body() dto: UpdateCurrentTenantDto,
    @Req() req: Request,
  ) {
    return this.tenantsService.updateCurrent(queryRunner, tenantId, dto, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }

  /**
   * Validates a tenant a Super Admin wants to act as. The server keeps no "current tenant" state: the
   * client sends the returned id as the X-Tenant-Override header on every later request, and
   * TenantContextMiddleware applies it. Passing tenantId null clears it (the client drops the header).
   */
  @Post("switch")
  @Roles(UserRole.SUPER_ADMIN)
  async switchTenant(@CurrentUser() currentUser: AuthUserContext, @Body() dto: SwitchTenantDto, @Req() req: Request) {
    return this.tenantsService.switchTo(dto.tenantId, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }

  @Get(":id")
  @Roles(UserRole.SUPER_ADMIN)
  async findOne(@Param("id", ParseUUIDPipe) id: string) {
    const tenant = await this.tenantsService.findOne(id);
    if (!tenant) {
      throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found." });
    }
    return this.tenantsService.toDto(tenant);
  }

  @Post()
  @Idempotent()
  @Roles(UserRole.SUPER_ADMIN)
  async create(
    @CurrentUser() currentUser: AuthUserContext,
    @Body() dto: CreateTenantDto,
    @Req() req: Request,
  ) {
    return this.tenantsService.create(dto, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }
}
