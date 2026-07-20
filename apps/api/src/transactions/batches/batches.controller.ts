import { Controller, Get, NotFoundException, Param, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import * as path from "path";
import { QueryRunner } from "typeorm";
import { UserRole } from "@regops/shared";
import { FileStorage, LocalFileStorage } from "@regops/file-storage";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { TenantGuard } from "../../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { IngestionBatchService } from "../ingestion/ingestion-batch.service";
import { ListBatchesDto } from "./dto/list-batches.dto";

const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

@ApiTags("transactions")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("transactions/batches")
export class BatchesController {
  private readonly storage: FileStorage;

  constructor(private readonly ingestionBatchService: IngestionBatchService) {
    // Same construction pattern as CustomersService/CustomerIngestionService — no
    // Nest DI token for FileStorage exists in this codebase (see those files).
    const localStorageDir = process.env.LOCAL_STORAGE_DIR ?? path.resolve(__dirname, "../../../../../.local-storage");
    this.storage = new LocalFileStorage(localStorageDir);
  }

  @Get()
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Query() query: ListBatchesDto) {
    return this.ingestionBatchService.findAll(queryRunner, tenantId, query.page, query.limit);
  }

  @Get(":id")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Param("id") id: string) {
    const batch = await this.ingestionBatchService.findById(queryRunner, tenantId, id);
    return this.ingestionBatchService.toDto(batch);
  }

  @Get(":id/errors")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async errors(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const batch = await this.ingestionBatchService.findById(queryRunner, tenantId, id);
    if (!batch.errorReportUrl) {
      throw new NotFoundException({ code: "ERROR_REPORT_NOT_FOUND", message: "No error report for this batch." });
    }
    const stream = await this.storage.getReadStream(batch.errorReportUrl);
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", `attachment; filename="ingestion-batch-${id}-errors.csv"`);
    stream.pipe(res);
  }
}
