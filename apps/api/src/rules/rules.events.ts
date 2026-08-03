import { AlertCloseCategory, AlertSeverity, AlertStatus, RuleScenarioType } from "@regops/shared";

/** Dot-separated, lowercase-snake — same convention as TRANSACTION_EVENTS/SCREENING_EVENTS. */
export const ALERT_EVENTS = {
  CREATED: "alert.created",
  ESCALATED: "alert.escalated",
  CRITICAL_FIRED: "alert.critical_fired",
  CLOSED: "alert.closed",
  /** Emitted whenever an alert's status actually changes via AlertsService.assign()
   * (NEW -> ASSIGNED) — Backend Prompt 6's Case Management module subscribes to this
   * (and to CLOSED, below) to auto-transition a linked case OPEN -> UNDER_INVESTIGATION
   * the first time a linked alert moves off NEW. */
  STATUS_CHANGED: "alert.status_changed",
} as const;

export const RULE_EVENTS = {
  UPDATED: "rule.updated",
} as const;

export interface AlertCreatedEvent {
  tenantId: string;
  alertId: string;
  ruleId: string;
  customerId: string;
  scenarioType: RuleScenarioType;
  severity: AlertSeverity;
}

/** Emitted when an existing (non-CLOSED) Alert's fire_count increments —
 * Section 7.3: v1 does not auto-escalate severity in the data, but the UI
 * can use fire_count/this event to surface priority. */
export interface AlertEscalatedEvent {
  tenantId: string;
  alertId: string;
  ruleId: string;
  customerId: string;
  fireCount: number;
}

/** Section 7.4: emitted specifically when an Alert's severity is CRITICAL on
 * first fire. NOTE: this event has no subscriber as of Backend Prompt 6 —
 * that module's actual written spec never asks for auto-case-creation from a
 * critical alert, and the frontend mock it's built from is explicit that
 * nothing auto-opens a case. Left unconsumed deliberately; see Backend Prompt
 * 6's HANDOFF.md deviations section. */
export interface AlertCriticalFiredEvent {
  tenantId: string;
  alertId: string;
  ruleId: string;
  customerId: string;
  scenarioType: RuleScenarioType;
}

export interface AlertStatusChangedEvent {
  tenantId: string;
  alertId: string;
  customerId: string;
  previousStatus: AlertStatus;
  newStatus: AlertStatus;
}

export interface AlertClosedEvent {
  tenantId: string;
  alertId: string;
  closedBy: string;
  closeCategory: AlertCloseCategory;
  /** Added for Backend Prompt 6's Case Management auto-transition trigger — the
   * case listener only cares about closures that moved an alert off NEW. */
  previousStatus: AlertStatus;
}

export interface RuleUpdatedEvent {
  tenantId: string;
  ruleId: string;
  scenarioType: RuleScenarioType;
  isLoosening: boolean;
  updatedBy: string;
}
