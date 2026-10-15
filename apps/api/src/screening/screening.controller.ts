import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { QueryRunner } from "typeorm";
import { CustomerEntity, TenantEntity } from "@regops/db";
import { AuthUserContext, ScreeningCheckStatus, ScreeningCheckType, ScreeningResultType, UserRole } from "@regops/shared";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { TenantGuard } from "../auth/guards/tenant.guard";
import { CurrentQueryRunner } from "../common/decorators/current-query-runner.decorator";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { ScreeningService } from "./screening.service";
import { ScreeningProviderConfigService } from "./providers/screening-provider-config.service";
import { ListScreeningChecksDto } from "./dto/screening-result.dto";
import { ManualScreenDto } from "./dto/manual-screen.dto";
import { ConfigureProvidersDto } from "./dto/configure-providers.dto";

const COMPLIANCE_OFFICER_PLUS = [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER];

@ApiTags("screening")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@Controller("screening")
export class ScreeningController {
  constructor(
    private readonly screeningService: ScreeningService,
    private readonly providerConfigService: ScreeningProviderConfigService,
  ) {}

  /** Section 6: synchronous sanctions re-check on an EXISTING customer — the
   * mandatory blocking pre-screen at onboarding (Section 5.1) is wired
   * directly into CustomersService.create(), not this endpoint. */
  @Post("customers/:id/sanctions")
  @Roles(UserRole.TENANT_ADMIN, UserRole.COMPLIANCE_OFFICER)
  async sanctionsCheck(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @CurrentUser() currentUser: AuthUserContext,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const customer = await queryRunner.manager.getRepository(CustomerEntity).findOne({ where: { tenantId, id } });
    if (!customer) {
      throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });
    }

    const tenant = await queryRunner.manager.getRepository(TenantEntity).findOneOrFail({ where: { id: tenantId } });
    const outcome = await this.screeningService.screenExistingCustomerSanctions(queryRunner, tenant, customer, currentUser.sub);

    return {
      check: this.screeningService.toCheckDto(outcome.check),
      // Every match in outcome.matches belongs to outcome.check (this
      // endpoint only ever runs a single SANCTIONS check per call).
      matches: outcome.matches.map((m) => this.screeningService.toMatchDto(m, outcome.check.checkType)),
    };
  }

  @Post("customers/:id/screen")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async manualScreen(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ManualScreenDto,
  ) {
    const customer = await queryRunner.manager.getRepository(CustomerEntity).findOne({ where: { tenantId, id } });
    if (!customer) {
      throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "Customer not found." });
    }

    const checkTypes = dto.checkTypes?.length ? dto.checkTypes : [ScreeningCheckType.PEP, ScreeningCheckType.ADVERSE_MEDIA];
    return this.screeningService.manualScreen(tenantId, customer.id, checkTypes);
  }

  @Get("checks")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async listChecks(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Query() query: ListScreeningChecksDto,
  ) {
    return this.screeningService.findChecks(
      queryRunner,
      tenantId,
      {
        customerId: query.customer_id,
        checkTypes: query.check_type?.split(",") as ScreeningCheckType[] | undefined,
        statuses: query.status?.split(",") as ScreeningCheckStatus[] | undefined,
        results: query.result?.split(",") as ScreeningResultType[] | undefined,
      },
      query.page,
      query.limit,
    );
  }

  @Get("checks/:id")
  @Roles(...COMPLIANCE_OFFICER_PLUS)
  async checkDetail(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner, @Param("id", ParseUUIDPipe) id: string) {
    return this.screeningService.findCheckById(queryRunner, tenantId, id);
  }

  @Get("providers")
  @Roles(UserRole.TENANT_ADMIN)
  async listProviders(@CurrentTenant() tenantId: string, @CurrentQueryRunner() queryRunner: QueryRunner) {
    const configs = await this.providerConfigService.findAllForTenant(queryRunner, tenantId);
    return configs.map((c) => this.providerConfigService.toDto(c));
  }

  @Put("providers")
  @Roles(UserRole.TENANT_ADMIN)
  async configureProviders(
    @CurrentTenant() tenantId: string,
    @CurrentQueryRunner() queryRunner: QueryRunner,
    @Body() dto: ConfigureProvidersDto,
  ) {
    const saved = await this.providerConfigService.replaceForTenant(queryRunner, tenantId, dto.providers);
    return saved.map((c) => this.providerConfigService.toDto(c));
  }
}
