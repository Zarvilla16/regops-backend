import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { ANY_AUTHENTICATED, COMPLIANCE_OFFICER_ONLY, requestMeta } from "../cases/cases.controller";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { ConfirmReportDto } from "./dto/confirm-report.dto";
import { ListReportsDto } from "./dto/list-reports.dto";
import { RejectReportDto } from "./dto/reject-report.dto";
import { UpdateReportDto } from "./dto/update-report.dto";
import { ReportExportFormat, ReportExportService } from "./report-export.service";
import { ReportsService } from "./reports.service";

const PII_ROLES = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

@ApiTags("reports")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("reports")
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly reportExportService: ReportExportService,
  ) {}

  @Get()
  @Roles(...ANY_AUTHENTICATED)
  async list(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Query() query: ListReportsDto) {
    const limit = Math.min(query.limit ?? 25, 100);
    return this.reportsService.list(
      qr,
      tenantId,
      { status: query.status, reportType: query.reportType, dateFrom: query.dateFrom, dateTo: query.dateTo },
      query.page ?? 1,
      limit,
    );
  }

  @Get(":id")
  @Roles(...ANY_AUTHENTICATED)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() qr: QueryRunner, @Param("id", ParseUUIDPipe) id: string) {
    return this.reportsService.toDetail(qr, tenantId, id);
  }

  @Patch(":id")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async update(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateReportDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.reportsService.update(qr, tenantId, id, dto, currentUser, requestMeta(req));
  }

  @Patch(":id/submit")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async submit(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.reportsService.submit(qr, tenantId, id, currentUser, requestMeta(req));
  }

  @Patch(":id/confirm")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async confirm(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ConfirmReportDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.reportsService.confirm(qr, tenantId, id, dto.nfiuReference, currentUser, requestMeta(req));
  }

  @Patch(":id/reject")
  @Roles(...COMPLIANCE_OFFICER_ONLY)
  async reject(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RejectReportDto,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
  ) {
    return this.reportsService.reject(qr, tenantId, id, dto.reason, currentUser, requestMeta(req));
  }

  // XML carries UNMASKED BVN/NIN (regulatory filing, Section 2.4), so it is gated exactly like GET /customers/:id/pii.
  // PDF/CSV mask BVN/NIN and stay open to any authenticated tenant user.
  @Get(":id/xml")
  @Roles(...PII_ROLES)
  async xml(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("reason") reason: string | undefined,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Same accountability friction and wording as GET /customers/:id/pii.
    if (!reason) {
      throw new BadRequestException({ code: "REASON_REQUIRED", message: "A 'reason' query param is required." });
    }
    await this.download(qr, tenantId, id, "xml", currentUser, req, res, reason);
  }

  @Get(":id/pdf")
  @Roles(...ANY_AUTHENTICATED)
  async pdf(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.download(qr, tenantId, id, "pdf", currentUser, req, res);
  }

  @Get(":id/csv")
  @Roles(...ANY_AUTHENTICATED)
  async csv(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() qr: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() currentUser: AuthUserContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.download(qr, tenantId, id, "csv", currentUser, req, res);
  }

  /**
   * Commits the request transaction BEFORE writing the response. With @Res()
   * the handler owns the response, and TransactionInterceptor only commits
   * after the handler returns — by which time the client could already have
   * the body while the export's audit rows (incl. the unmasked-BVN/NIN
   * reveal) were still uncommitted. Same class of race as HANDOFF bug #23
   * (evidence download). TransactionInterceptor tolerates an already-committed
   * transaction (it checks isTransactionActive).
   */
  private async download(qr: QueryRunner, tenantId: string, id: string, format: ReportExportFormat, currentUser: AuthUserContext, req: Request, res: Response, reason?: string) {
    const out = await this.reportExportService.export(qr, tenantId, id, format, currentUser, requestMeta(req), reason);
    if (qr.isTransactionActive) await qr.commitTransaction();
    res.setHeader("content-type", out.contentType);
    res.setHeader("content-disposition", `attachment; filename="${out.fileName}"`);
    res.setHeader("cache-control", "no-store");
    res.send(out.body);
  }
}
