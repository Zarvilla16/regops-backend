import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { AuthUserContext, CasePriority, CaseStatus, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { CaseEvidenceService } from "./case-evidence.service";
import { CaseNotesService } from "./case-notes.service";
import { CasesService } from "./cases.service";
import { AddNoteDto } from "./dto/add-note.dto";
import { CloseCaseDto } from "./dto/close-case.dto";
import { CreateCaseDto } from "./dto/create-case.dto";
import { LinkAlertDto } from "./dto/link-alert.dto";
import { ListCasesDto } from "./dto/list-cases.dto";
import { RejectCaseDto } from "./dto/reject-case.dto";
import { SubmitCaseDto } from "./dto/submit-case.dto";

export const ANY_AUTHENTICATED = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR, UserRole.VIEWER];
export const CREATE_ROLES = [UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR];
export const NOTES_EVIDENCE_LINK_ROLES = [UserRole.COMPLIANCE_OFFICER, UserRole.INVESTIGATOR];
export const COMPLIANCE_OFFICER_ONLY = [UserRole.COMPLIANCE_OFFICER];

export function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

@ApiTags("cases")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("cases")
export class CasesController {
  constructor(
    private readonly casesService: CasesService,
    private readonly caseNotesService: CaseNotesService,
    private readonly caseEvidenceService: CaseEvidenceService,
  ) {}

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

  @Get(":id/checklist")
  @Roles(...ANY_AUTHENTICATED)
  async checklist(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id") id: string) {
    return this.casesService.computeChecklist(qr, tenantId, id);
  }

  @Post(":id/alerts")
  @Roles(...NOTES_EVIDENCE_LINK_ROLES)
  async linkAlert(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: LinkAlertDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.linkAlert(qr, tenantId, id, dto.alertId, currentUser, requestMeta(req));
  }

  @Post(":id/notes")
  @Roles(...NOTES_EVIDENCE_LINK_ROLES)
  async addNote(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.caseNotesService.addNote(qr, tenantId, id, dto.content, currentUser, requestMeta(req));
  }

  // No multer `limits.fileSize` here — see CaseEvidenceService.upload's docblock.
  @Post(":id/evidence")
  @Roles(...NOTES_EVIDENCE_LINK_ROLES)
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage() }))
  async uploadEvidence(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    if (!file) {
      throw new BadRequestException({ code: "FILE_REQUIRED", message: "An evidence file ('file' field) is required." });
    }
    return this.caseEvidenceService.upload(qr, tenantId, id, file, currentUser, requestMeta(req));
  }

  @Get(":id/evidence/:evidenceId")
  @Roles(...ANY_AUTHENTICATED)
  async downloadEvidence(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Param("evidenceId") evidenceId: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { stream, contentType, fileName } = await this.caseEvidenceService.getStream(qr, tenantId, id, evidenceId, currentUser, requestMeta(req));
    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    stream.pipe(res);
  }

  @Patch(":id/close")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async close(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: CloseCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.close(qr, tenantId, id, dto.closureReason, currentUser, requestMeta(req));
  }

  @Patch(":id/submit")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async submit(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: SubmitCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.submit(qr, tenantId, id, dto.escalationRationale, currentUser, requestMeta(req));
  }

  @Patch(":id/approve")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async approve(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.approve(qr, tenantId, id, currentUser, requestMeta(req));
  }

  @Patch(":id/reject")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async reject(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id") id: string,
    @Body() dto: RejectCaseDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.casesService.reject(qr, tenantId, id, dto.reason, currentUser, requestMeta(req));
  }
}
