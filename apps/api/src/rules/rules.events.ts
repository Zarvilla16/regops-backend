import { AlertCloseCategory, AlertSeverity, RuleScenarioType } from "@regops/shared";

/** Dot-separated, lowercase-snake — same convention as TRANSACTION_EVENTS/SCREENING_EVENTS. */
export const ALERT_EVENTS = {
  CREATED: "alert.created",
  ESCALATED: "alert.escalated",
  CRITICAL_FIRED: "alert.critical_fired",
  CLOSED: "alert.closed",
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
 * first fire — Prompt 6's Case Management subscribes to auto-open a Case. */
export interface AlertCriticalFiredEvent {
  tenantId: string;
  alertId: string;
  ruleId: string;
  customerId: string;
  scenarioType: RuleScenarioType;
}

export interface AlertClosedEvent {
  tenantId: string;
  alertId: string;
  closedBy: string;
  closeCategory: AlertCloseCategory;
}

export interface RuleUpdatedEvent {
  tenantId: string;
  ruleId: string;
  scenarioType: RuleScenarioType;
  isLoosening: boolean;
  updatedBy: string;
}
