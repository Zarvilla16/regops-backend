import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import * as os from "os";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { AuthUserContext, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { TenantGuard } from "../../auth/guards/tenant.guard";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CustomerIngestionService } from "./customer-ingestion.service";
import { BatchUploadDto } from "./dto/batch-upload.dto";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

@ApiTags("customers")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("customers/batch")
export class CustomerIngestionController {
  constructor(private readonly ingestionService: CustomerIngestionService) {}

  @Post()
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  @UseInterceptors(
    FileInterceptor("file", {
      // diskStorage so the 100MB upload isn't held in the API process's memory —
      // the file is streamed straight to a temp path, then handed to FileStorage.
      storage: diskStorage({ destination: os.tmpdir() }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  async upload(
    @CurrentTenant() tenantId: string,
    @CurrentUser() currentUser: AuthUserContext,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: BatchUploadDto,
  ) {
    if (!file) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "A CSV file ('file' field) is required." });
    }
    return this.ingestionService.uploadAndEnqueue(
      tenantId,
      currentUser.sub,
      file.path,
      dto.duplicate_strategy ?? "skip",
    );
  }

  @Get(":jobId")
  async status(@CurrentTenant() tenantId: string, @Param("jobId", ParseUUIDPipe) jobId: string) {
    return this.ingestionService.getStatus(tenantId, jobId);
  }

  @Get(":jobId/error-report")
  async errorReport(@CurrentTenant() tenantId: string, @Param("jobId", ParseUUIDPipe) jobId: string, @Res() res: Response) {
    const stream = await this.ingestionService.getErrorReportStream(tenantId, jobId);
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", `attachment; filename="ingestion-${jobId}-errors.csv"`);
    stream.pipe(res);
  }
}
