import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
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
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UsersService } from "./users.service";
import type { AuthUserContext } from "@regops/shared";

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner) {
    const users = await this.usersService.findAllForTenant(queryRunner, tenantId);
    return users.map((u) => this.usersService.toDto(u));
  }

  @Get(":id")
  async findOne(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id") id: string,
  ) {
    const user = await this.usersService.findOneForTenant(queryRunner, tenantId, id);
    if (!user) {
      throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    return this.usersService.toDto(user);
  }

  @Post()
  @Idempotent()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Body() dto: CreateUserDto,
    @Req() req: Request,
  ) {
    return this.usersService.create(queryRunner, tenantId, dto, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }

  @Patch(":id")
  @Idempotent()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    return this.usersService.update(queryRunner, tenantId, id, dto, currentUser, {
      ipAddress: req.ip ?? null,
      userAgent: req.header("user-agent") ?? null,
    });
  }
}
