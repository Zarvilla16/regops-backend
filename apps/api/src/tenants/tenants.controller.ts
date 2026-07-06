import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { Idempotent } from "../common/decorators/idempotent.decorator";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { TenantsService } from "./tenants.service";
import type { AuthUserContext } from "@regops/shared";

@ApiTags("tenants")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller("tenants")
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  async list() {
    const tenants = await this.tenantsService.findAll();
    return tenants.map((t) => this.tenantsService.toDto(t));
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    const tenant = await this.tenantsService.findOne(id);
    if (!tenant) {
      throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found." });
    }
    return this.tenantsService.toDto(tenant);
  }

  @Post()
  @Idempotent()
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
