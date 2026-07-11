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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { memoryStorage } from "multer";
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

const MAX_PHOTO_UPLOAD_BYTES = 5 * 1024 * 1024;

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

  // Must be declared before @Get(":id") — both are exactly one path segment
  // after /customers, and Express/Nest resolves same-shape routes in
  // registration order, so ":id" would otherwise swallow "export" as an id.
  @Get("export")
  async export(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Query() query: ListCustomersDto,
    @Res() res: Response,
  ) {
    const csv = await this.customersService.exportCsv(queryRunner, tenantId, query);
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", `attachment; filename="customers-export-${Date.now()}.csv"`);
    res.send(csv);
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

  @Post(":id/approve-pep")
  @Idempotent()
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async approvePep(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    return this.customersService.approvePep(queryRunner, tenantId, id, currentUser, requestMeta(req));
  }

  // No @Idempotent() here: IdempotencyInterceptor hashes method:url:body, and
  // multer strips the file out of `body` before it ever reaches that hash —
  // two different photos uploaded with the same Idempotency-Key would
  // incorrectly replay the first response instead of actually re-executing.
  @Post(":id/photo")
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: MAX_PHOTO_UPLOAD_BYTES },
    }),
  )
  async uploadPhoto(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "A photo file ('file' field) is required." });
    }
    return this.customersService.uploadPhoto(queryRunner, tenantId, id, file, currentUser, requestMeta(req));
  }

  @Get(":id/photo")
  async getPhoto(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const { stream, contentType } = await this.customersService.getPhotoStream(queryRunner, tenantId, id);
    res.setHeader("content-type", contentType);
    stream.pipe(res);
  }

  @Delete(":id/photo")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async deletePhoto(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id") id: string,
    @Req() req: Request,
  ) {
    await this.customersService.deletePhoto(queryRunner, tenantId, id, currentUser, requestMeta(req));
  }
}
