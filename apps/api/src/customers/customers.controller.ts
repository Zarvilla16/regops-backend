import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
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
import type { AuthUserContext } from "@regops/shared";
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

@ApiTags("customers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("customers")
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  async list(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Query() query: ListCustomersDto,
  ) {
    return this.customersService.list(queryRunner, tenantId, query);
  }

  @Get(":id")
  async findOne(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id") id: string,
  ) {
    return this.customersService.findOne(queryRunner, tenantId, id);
  }

  @Get(":id/pii")
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async findOnePii(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @Query("reason") reason: string | undefined,
    @Req() req: Request,
  ) {
    if (!reason) {
      throw new BadRequestException({ code: "REASON_REQUIRED", message: "A 'reason' query param is required." });
    }
    return this.customersService.findOnePii(queryRunner, tenantId, id, currentUser, reason, requestMeta(req));
  }

  @Post()
  @Idempotent()
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async create(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Body() dto: CreateCustomerDto,
    @Req() req: Request,
  ) {
    return this.customersService.create(queryRunner, tenantId, dto, currentUser, requestMeta(req));
  }

  @Patch(":id")
  @Idempotent()
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @Body() dto: UpdateCustomerDto,
    @Req() req: Request,
  ) {
    return this.customersService.update(queryRunner, tenantId, id, dto, currentUser, requestMeta(req));
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.TENANT_ADMIN)
  async remove(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @Query("reason") reason: string | undefined,
    @Req() req: Request,
  ) {
    if (!reason) {
      throw new BadRequestException({ code: "REASON_REQUIRED", message: "A 'reason' query param is required." });
    }
    await this.customersService.softDelete(queryRunner, tenantId, id, reason, currentUser, requestMeta(req));
  }
}
