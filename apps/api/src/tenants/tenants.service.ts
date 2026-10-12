import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, QueryRunner } from "typeorm";
import { TenantEntity } from "@regops/db";
import { AuthUserContext, TenantStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskFactorConfigService } from "../risk/config/risk-factor-config.service";
import { ScreeningProviderConfigService } from "../screening/providers/screening-provider-config.service";
import { RulesService } from "../rules/rules.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateCurrentTenantDto } from "./dto/update-current-tenant.dto";
import { RequestMeta } from "../users/users.service";

@Injectable()
export class TenantsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly riskFactorConfigService: RiskFactorConfigService,
    private readonly screeningProviderConfigService: ScreeningProviderConfigService,
    private readonly rulesService: RulesService,
    private readonly configService: ConfigService,
  ) {}

  toDto(tenant: TenantEntity) {
    return {
      id: tenant.id,
      name: tenant.name,
      type: tenant.type,
      cbnLicenseNumber: tenant.cbnLicenseNumber,
      status: tenant.status,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    };
  }

  async findAll(): Promise<TenantEntity[]> {
    return this.dataSource.getRepository(TenantEntity).find();
  }

  async findOne(id: string): Promise<TenantEntity | null> {
    return this.dataSource.getRepository(TenantEntity).findOne({ where: { id } });
  }

  /** Reads through the request's tenant-scoped connection, so RLS applies. */
  async findCurrent(queryRunner: QueryRunner, tenantId: string): Promise<TenantEntity | null> {
    return queryRunner.manager.getRepository(TenantEntity).findOne({ where: { id: tenantId } });
  }

  async updateCurrent(
    queryRunner: QueryRunner,
    tenantId: string,
    dto: UpdateCurrentTenantDto,
    currentUser: AuthUserContext,
    meta: RequestMeta,
  ) {
    const repo = queryRunner.manager.getRepository(TenantEntity);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found." });
    }

    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException({ code: "TENANT_NAME_REQUIRED", message: "Tenant name cannot be blank." });
    }
    if (name === tenant.name) {
      return this.toDto(tenant);
    }

    await queryRunner.startTransaction();
    try {
      const before = { name: tenant.name };
      tenant.name = name;
      const saved = await repo.save(tenant);
      await this.auditService.record(queryRunner, {
        tenantId,
        userId: currentUser.sub,
        action: "tenant.update",
        entityType: "tenant",
        entityId: tenantId,
        beforeState: before,
        afterState: { name: saved.name },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      await queryRunner.commitTransaction();
      return this.toDto(saved);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    }
  }

  /** null means "back to my own tenant" and needs no lookup. */
  async validateSwitch(tenantId: string | null) {
    if (tenantId === null) {
      return { tenantId: null, tenant: null };
    }
    const tenant = await this.findOne(tenantId);
    if (!tenant) {
      throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Tenant not found." });
    }
    return { tenantId: tenant.id, tenant: this.toDto(tenant) };
  }

  /**
   * Tenant creation happens before the tenant itself exists, so there is no
   * pre-established per-request tenant context to reuse (unlike users,
   * which are created within their own tenant's RLS context). This method
   * opens its own QueryRunner and explicitly sets app.bypass_rls so the
   * resulting audit_log row can be scoped to the brand-new tenant's id — the
   * caller already passed RolesGuard(SUPER_ADMIN) to reach here.
   */
  async create(dto: CreateTenantDto, currentUser: AuthUserContext, meta: RequestMeta) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.startTransaction();

      const tenant = await queryRunner.manager.save(
        queryRunner.manager.create(TenantEntity, {
          name: dto.name,
          type: dto.type,
          cbnLicenseNumber: dto.cbnLicenseNumber ?? null,
          status: TenantStatus.PENDING,
        }),
      );

      await queryRunner.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'true', true)`,
        [tenant.id],
      );

      // Every new tenant gets the default risk-scoring algorithm (section
      // 5.5) — a tenant admin can tune weight/config afterward without any
      // code change.
      await this.riskFactorConfigService.seedDefaultsForTenant(queryRunner, tenant.id);

      // Section 11's Definition of Done: "Default ScreeningProviderConfig
      // seeded for every new tenant — MockProvider as primary in non-prod
      // env; SmileId primary + Prembly fallback in prod env."
      const isProd = this.configService.get<string>("nodeEnv") === "production";
      await this.screeningProviderConfigService.seedDefaultsForTenant(queryRunner, tenant.id, isProd);

      // Section 5.4: every new tenant gets the five default Rule rows
      // (LARGE_CASH/STRUCTURING/RAPID_INFLOW_OUTFLOW/HIGH_RISK_COUNTERPARTY/
      // VELOCITY_SPIKE) — a TENANT_ADMIN can tune config afterward via
      // PATCH /rules/:id without any code change.
      await this.rulesService.seedDefaultsForTenant(queryRunner, tenant.id);

      await this.auditService.record(queryRunner, {
        tenantId: tenant.id,
        userId: currentUser.sub,
        action: "tenant.create",
        entityType: "tenant",
        entityId: tenant.id,
        afterState: { ...tenant },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      await queryRunner.commitTransaction();
      return this.toDto(tenant);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
