import { RiskLevel, ScreeningCheckType, ScreeningResultType, ScreeningTrigger } from "./enums";

/**
 * Shapes shared between the producer (apps/api, which enqueues and later
 * reads job.returnvalue via a QueueEvents bridge — see
 * AsyncScreeningQueueService/RescreenQueueService) and the consumer
 * (apps/worker's async-screening.processor.ts / rescreen-job.processor.ts,
 * which do the real work) — same cross-app-boundary reasoning as
 * IngestionJobData/IngestionJobResult above.
 */
export interface AsyncScreeningJobData {
  tenantId: string;
  customerId: string;
  /** Always PEP and/or ADVERSE_MEDIA — SANCTIONS is never async (Section 2.1). */
  checkTypes: ScreeningCheckType[];
  trigger: ScreeningTrigger;
}

export interface AsyncScreeningCheckOutcome {
  checkType: ScreeningCheckType;
  checkId: string;
  result: ScreeningResultType;
  matchIds: string[];
  /** True only when this outcome is what flipped customer.is_pep to true. */
  pepFlagged: boolean;
}

export interface AsyncScreeningJobResult {
  tenantId: string;
  customerId: string;
  outcomes: AsyncScreeningCheckOutcome[];
}

export type RescreenScheduleLabel = "DAILY_HIGH_RISK" | "WEEKLY_MEDIUM_RISK" | "MONTHLY_LOW_RISK";

export interface RescreenJobData {
  tenantId: string;
  scheduleLabel: RescreenScheduleLabel;
  riskLevels: RiskLevel[];
  checkTypes: ScreeningCheckType[];
}

export interface RescreenCustomerOutcome {
  customerId: string;
  checkType: ScreeningCheckType;
  checkId: string;
  result: ScreeningResultType;
  matchIds: string[];
  pepFlagged: boolean;
  /** True only when this outcome is what flipped customer.is_sanctioned to
   * true — always via customer.sanctions_flagged, never sanctions_confirmed
   * (that event name is reserved for the manual match-review path). */
  sanctionsFlagged: boolean;
}

export interface RescreenJobResult {
  tenantId: string;
  scheduleLabel: RescreenScheduleLabel;
  processed: number;
  outcomes: RescreenCustomerOutcome[];
}
