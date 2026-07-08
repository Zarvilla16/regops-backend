import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, In, QueryRunner } from "typeorm";
import { CustomerEntity, TenantEntity } from "@regops/db";
import { CustomerStatus, RiskLevel, TenantStatus } from "@regops/shared";
import { RiskService } from "../risk.service";

const TENANT_CONCURRENCY = 5;

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Schedules are global (not per-tenant), but each tenant's customers are
 * processed independently under that tenant's own RLS context — see
 * withTenantContext. Re-scoring itself (RiskService.rescoreScheduled) writes
 * `user_id = NULL` / `action = 'risk.rescore.scheduled'` to the audit log.
 */
@Injectable()
export class RescoreSchedulerService {
  private readonly logger = new Logger(RescoreSchedulerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly riskService: RiskService,
  ) {}

  /**
   * Opens a dedicated connection and stamps `app.current_tenant_id` for
   * this one tenant (never `app.bypass_rls` — a scheduled job should still
   * be confined to exactly the tenant it's processing, same as any other
   * tenant-scoped request). Must be a real transaction: `set_config(...,
   * true)` is transaction-local and silently no-ops outside of one — see
   * TenantContextMiddleware's docblock for the full explanation of that bug
   * class.
   */
  private async withTenantContext<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`,
        [tenantId],
      );
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) {
        await qr.rollbackTransaction();
      }
      throw err;
    } finally {
      await qr.release();
    }
  }

  private async rescoreTenantCustomers(tenantId: string, riskLevels: RiskLevel[]): Promise<void> {
    await this.withTenantContext(tenantId, async (qr) => {
      const customers = await qr.manager
        .getRepository(CustomerEntity)
        .find({ where: { riskLevel: In(riskLevels), status: CustomerStatus.ACTIVE } });

      for (const customer of customers) {
        await this.riskService.rescoreScheduled(qr, customer);
      }
    });
  }

  private async rescoreAllTenants(riskLevels: RiskLevel[]): Promise<void> {
    const tenants = await this.dataSource
      .getRepository(TenantEntity)
      .find({ where: { status: TenantStatus.ACTIVE } });

    await mapWithConcurrency(tenants, TENANT_CONCURRENCY, async (tenant) => {
      try {
        await this.rescoreTenantCustomers(tenant.id, riskLevels);
      } catch (err) {
        this.logger.error(`Scheduled rescore failed for tenant ${tenant.id}`, err as Error);
      }
    });
  }

  @Cron("0 2 * * *")
  async dailyRescoreHighRisk(): Promise<void> {
    await this.rescoreAllTenants([RiskLevel.HIGH, RiskLevel.CRITICAL]);
  }

  @Cron("0 3 * * 1")
  async weeklyRescoreMediumRisk(): Promise<void> {
    await this.rescoreAllTenants([RiskLevel.MEDIUM]);
  }

  @Cron("0 4 1 * *")
  async monthlyRescoreLowRisk(): Promise<void> {
    await this.rescoreAllTenants([RiskLevel.LOW]);
  }
}
