import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { DataSource } from "typeorm";
import { CustomerEntity } from "@regops/db";
import { ScreeningCheckType, ScreeningTrigger } from "@regops/shared";
import { AsyncScreeningQueueService } from "../async-screening-queue.service";

/** Fields that affect screening (Section 9) — matches
 * CustomersService.SCORING_RELEVANT_FIELDS' spirit but is its own list, since
 * "affects screening" and "affects risk score" aren't the same set (e.g.
 * kycTier affects risk but not screening; fullName affects screening but
 * only risk indirectly via the PEP/sanctioned flags screening itself sets). */
const SCREENING_RELEVANT_FIELDS = ["fullName", "dateOfBirth", "country", "nationality"];

interface CustomerUpdatedEventPayload {
  tenantId: string;
  customerId: string;
  changedFields: string[];
}

/**
 * Section 9: "Also subscribe to customer.updated. If fields that affect
 * screening change (full_name, date_of_birth, country, nationality), trigger
 * an async re-screen with trigger = 'UPDATE'." Listens via EventEmitter2
 * (not inline in CustomersService, unlike the sync sanctions pre-screen at
 * creation — Section 9 explicitly allows either choice for the async
 * enqueue and asks that the choice be documented: this one is event-driven
 * because customer.updated already exists as a stable public event
 * CustomersService emits regardless of screening, so subscribing to it here
 * keeps CustomersService itself screening-agnostic for the update path,
 * unlike creation where the synchronous block is unavoidably inline).
 */
@Injectable()
export class CustomerListener {
  private readonly logger = new Logger(CustomerListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly asyncScreeningQueue: AsyncScreeningQueueService,
  ) {}

  @OnEvent("customer.updated")
  async onCustomerUpdated(event: CustomerUpdatedEventPayload): Promise<void> {
    const screeningRelevant = event.changedFields.some((f) => SCREENING_RELEVANT_FIELDS.includes(f));
    if (!screeningRelevant) return;

    try {
      // A lightweight existence check on the platform's regular pooled
      // connection is fine here — this only reads, and the queue payload
      // itself carries tenantId/customerId for the worker to re-verify
      // tenant-scoped ownership against its own connection.
      const exists = await this.dataSource.getRepository(CustomerEntity).exists({ where: { id: event.customerId, tenantId: event.tenantId } });
      if (!exists) return;

      await this.asyncScreeningQueue.enqueue({
        tenantId: event.tenantId,
        customerId: event.customerId,
        checkTypes: [ScreeningCheckType.SANCTIONS, ScreeningCheckType.PEP],
        trigger: ScreeningTrigger.UPDATE,
      });
    } catch (err) {
      this.logger.error(`Failed to enqueue UPDATE re-screen for customer ${event.customerId}`, err as Error);
    }
  }
}
