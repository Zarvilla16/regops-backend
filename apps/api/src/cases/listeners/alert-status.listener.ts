import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { DataSource, QueryRunner } from "typeorm";
import { CaseAlertEntity } from "@regops/db";
import { AlertStatus } from "@regops/shared";
import { AlertClosedEvent, AlertStatusChangedEvent } from "../../rules/rules.events";
import { CasesService } from "../cases.service";

/**
 * Section 3.2: "a linked alert's own status changes away from NEW ... this
 * module needs to react to that, not just to actions taken within Cases
 * itself. Implement as a listener/subscriber on whatever event the Alerts
 * module already emits" — same event-driven cross-module pattern as
 * RiskModule's TransactionListener (@OnEvent("transaction.ingested")).
 * Listens to BOTH alert.status_changed (Task 10 addition, emitted by
 * AlertsService.assign) and alert.closed (existing since Prompt 5, now
 * carrying previousStatus) since either event can be the transition that
 * moved a linked alert off NEW.
 */
@Injectable()
export class AlertStatusListener {
  private readonly logger = new Logger(AlertStatusListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly casesService: CasesService,
  ) {}

  @OnEvent("alert.status_changed")
  async onAlertStatusChanged(event: AlertStatusChangedEvent): Promise<void> {
    await this.handle(event.tenantId, event.alertId, event.previousStatus);
  }

  @OnEvent("alert.closed")
  async onAlertClosed(event: AlertClosedEvent): Promise<void> {
    await this.handle(event.tenantId, event.alertId, event.previousStatus);
  }

  private async handle(tenantId: string, alertId: string, previousStatus: AlertStatus): Promise<void> {
    if (previousStatus !== AlertStatus.NEW) return; // only a move OFF NEW is investigative activity

    try {
      await this.withTenantContext(tenantId, async (qr) => {
        const link = await qr.manager.getRepository(CaseAlertEntity).findOne({ where: { tenantId, alertId } });
        if (!link) return; // this alert isn't linked to any case — nothing to transition
        await this.casesService.maybeStartInvestigation(qr, tenantId, link.caseId, null, null);
      });
    } catch (err) {
      this.logger.error(`Failed to process alert status change for case auto-transition (alert ${alertId})`, err as Error);
    }
  }

  /** Same shape as RiskModule's TransactionListener.withTenantContext — never
   * app.bypass_rls, confined to exactly the tenant this event names. */
  private async withTenantContext<T>(tenantId: string, fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'false', true)`, [tenantId]);
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (err) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }
}
