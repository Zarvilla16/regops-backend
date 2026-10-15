import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { QueryRunner } from "typeorm";
import { AuthUserContext, MatchReviewStatus, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { MatchReviewService } from "./match-review.service";
import { ListScreeningMatchesDto } from "./dto/screening-result.dto";
import { ReviewMatchDto } from "./dto/review-match.dto";

const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

@ApiTags("screening")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("screening/matches")
export class MatchReviewController {
  constructor(private readonly matchReviewService: MatchReviewService) {}

  @Get()
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async list(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Query() query: ListScreeningMatchesDto,
  ) {
    return this.matchReviewService.findMatches(
      queryRunner,
      tenantId,
      { customerId: query.customer_id, reviewStatus: query.review_status as MatchReviewStatus | undefined },
      query.page,
      query.limit,
    );
  }

  @Get(":id")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async detail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Param("id", ParseUUIDPipe) id: string) {
    return this.matchReviewService.findMatchById(queryRunner, tenantId, id);
  }

  @Post(":id/review")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async review(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviewMatchDto,
    @Req() req: Request,
  ) {
    return this.matchReviewService.reviewMatch(
      queryRunner,
      tenantId,
      id,
      dto.decision,
      dto.decisionReason,
      currentUser,
      requestMeta(req),
    );
  }
}
