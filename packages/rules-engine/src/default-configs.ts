import { AlertSeverity, RuleAction, RuleScenarioType } from "@regops/shared";

export interface DefaultRuleConfig {
  scenarioType: RuleScenarioType;
  name: string;
  description: string;
  severity: AlertSeverity;
  action: RuleAction;
  config: Record<string, unknown>;
}

/**
 * Seeded into `rule` for every new tenant (packages/db's seed script and
 * RulesService.seedDefaultsForTenant, called from TenantsService.create —
 * same pattern as DEFAULT_RISK_FACTOR_CONFIGS). A TENANT_ADMIN can tune
 * config afterward via PATCH /rules/:id without any code change.
 */
export const DEFAULT_RULE_CONFIGS: DefaultRuleConfig[] = [
  {
    scenarioType: RuleScenarioType.LARGE_CASH,
    name: "Large Cash Threshold",
    description: "Single cash transaction above the CBN Currency Transaction Report (CTR) threshold.",
    severity: AlertSeverity.MEDIUM,
    action: RuleAction.FLAG,
    config: {
      thresholdIndividual: 5_000_000,
      thresholdCorporate: 10_000_000,
      applyToCredit: true,
      applyToDebit: true,
      excludedChannels: [],
    },
  },
  {
    scenarioType: RuleScenarioType.STRUCTURING,
    name: "Structuring / Smurfing",
    description: "Multiple cash transactions, each below the reporting threshold, cumulatively above it within a short window.",
    severity: AlertSeverity.HIGH,
    action: RuleAction.REVIEW,
    config: {
      windowHours: 24,
      minCount: 3,
      cumulativeThreshold: 5_000_000,
      sameDirectionOnly: false,
      largeCashThresholdIndividual: 5_000_000,
      largeCashThresholdCorporate: 10_000_000,
    },
  },
  {
    scenarioType: RuleScenarioType.RAPID_INFLOW_OUTFLOW,
    name: "Rapid Inflow-Outflow",
    description: "Inbound transfer followed by a large outbound transfer within a short window (layering).",
    severity: AlertSeverity.HIGH,
    action: RuleAction.REVIEW,
    config: {
      windowMinutes: 60,
      outflowRatio: 0.8,
      minInboundAmount: 500_000,
      excludeInternal: true,
    },
  },
  {
    scenarioType: RuleScenarioType.HIGH_RISK_COUNTERPARTY,
    name: "High-Risk Counterparty",
    description: "Transaction counterparty matches a sanctions list, PEP database, or internal blacklist.",
    severity: AlertSeverity.CRITICAL,
    action: RuleAction.REVIEW,
    config: {
      checkSanctions: true,
      checkPep: true,
      checkInternalBlacklist: true,
      externalScreeningCacheHours: 168,
      skipBelowAmount: 10_000,
      pepSeverity: AlertSeverity.MEDIUM,
      sanctionsSeverity: AlertSeverity.CRITICAL,
    },
  },
  {
    scenarioType: RuleScenarioType.VELOCITY_SPIKE,
    name: "Velocity Spike",
    description: "Customer's daily transaction volume suddenly exceeds their historical baseline.",
    severity: AlertSeverity.MEDIUM,
    action: RuleAction.FLAG,
    config: {
      minSpikeRatio: 5.0,
      minAbsoluteAmount: 1_000_000,
      historyDays: 30,
      excludeNewCustomersDays: 30,
      minHistoricalDays: 5,
      dormancyReactivationMinDays: 30,
    },
  },
];
