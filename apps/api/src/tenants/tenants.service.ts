import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TenantEntity } from "@regops/db";
import { AuthUserContext, TenantStatus } from "@regops/shared";
import { AuditService } from "../audit/audit.service";
import { RiskFactorConfigService } from "../risk/config/risk-factor-config.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { RequestMeta } from "../users/users.service";

@Injectable()
export class TenantsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly riskFactorConfigService: RiskFactorConfigService,
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
