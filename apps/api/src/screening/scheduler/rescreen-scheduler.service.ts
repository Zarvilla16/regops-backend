import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { TenantEntity } from "@regops/db";
import { RiskLevel, ScreeningCheckType, TenantStatus } from "@regops/shared";
import { RescreenQueueService } from "../rescreen-queue.service";

/**
 * Section 5.3's three schedules. Unlike RescoreSchedulerService (which does
 * the re-scoring work directly, in-process, per tenant), this only enqueues
 * one RescreenJobData job per active tenant onto RESCREEN_QUEUE — the actual
 * customer selection + screening work happens in apps/worker's
 * rescreen-job.processor.ts, same producer/consumer split as the async PEP
 * flow. Scheduled re-screening NEVER blocks (Section 5.3) — enqueuing is the
 * only synchronous part of this.
 */
@Injectable()
export class RescreenSchedulerService {
  private readonly logger = new Logger(RescreenSchedulerService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly rescreenQueue: RescreenQueueService,
  ) {}

  private async enqueueForAllTenants(
    scheduleLabel: "DAILY_HIGH_RISK" | "WEEKLY_MEDIUM_RISK" | "MONTHLY_LOW_RISK",
    riskLevels: RiskLevel[],
    checkTypes: ScreeningCheckType[],
  ): Promise<void> {
    const tenants = await this.dataSource.getRepository(TenantEntity).find({ where: { status: TenantStatus.ACTIVE } });

    for (const tenant of tenants) {
      try {
        await this.rescreenQueue.enqueue({ tenantId: tenant.id, scheduleLabel, riskLevels, checkTypes });
      } catch (err) {
        this.logger.error(`Failed to enqueue ${scheduleLabel} re-screen for tenant ${tenant.id}`, err as Error);
      }
    }
  }

  @Cron("0 1 * * *")
  async dailyRescreenHighRisk(): Promise<void> {
    await this.enqueueForAllTenants(
      "DAILY_HIGH_RISK",
      [RiskLevel.HIGH, RiskLevel.CRITICAL],
      [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP],
    );
  }

  @Cron("0 1 * * 1")
  async weeklyRescreenMediumRisk(): Promise<void> {
    await this.enqueueForAllTenants("WEEKLY_MEDIUM_RISK", [RiskLevel.MEDIUM], [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP]);
  }

  @Cron("0 1 1 * *")
  async monthlyRescreenLowRisk(): Promise<void> {
    await this.enqueueForAllTenants("MONTHLY_LOW_RISK", [RiskLevel.LOW], [ScreeningCheckType.SANCTIONS]);
  }
}
