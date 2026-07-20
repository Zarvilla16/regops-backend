import { AlertSeverity, CustomerType, TransactionChannel, TransactionType } from "@regops/shared";

/**
 * Structural, TypeORM-free mirrors of TransactionEntity/CustomerEntity —
 * same rationale as packages/risk-engine's RiskFactorCustomer/RiskFactorTenant:
 * this package must run identically wherever a rule fires (apps/api's
 * RuleEvaluationConsumerService, and apps/api's POST /rules/:id/test dry-run
 * endpoint), and importing real entities would drag in TypeORM decorators
 * this package has no reason to depend on.
 */
export interface EvaluatorTransaction {
  id: string;
  customerId: string;
  /** Decimal string, same convention as TransactionEntity.amount — callers
   * that need arithmetic convert with Number() at the point of use, same as
   * VelocityAdapterService/velocity-scoring.ts already do. */
  amount: string;
  currency: string;
  type: TransactionType;
  channel: TransactionChannel;
  counterpartyAccount: string | null;
  counterpartyBank: string | null;
  counterpartyName: string | null;
  counterpartyCustomerId: string | null;
  occurredAt: Date;
}

export interface EvaluatorCustomer {
  id: string;
  fullName: string;
  customerType: CustomerType;
  isPep: boolean;
  isSanctioned: boolean;
  onboardedAt: Date;
}

export interface EvaluationContext {
  tenantId: string;
  transaction: EvaluatorTransaction;
  customer: EvaluatorCustomer;
  now: Date;
}

export interface Evidence {
  /** 1-line human-readable summary. */
  summary: string;
  facts: Record<string, unknown>;
  relatedTransactionIds?: string[];
}

export interface EvaluationResult {
  fired: boolean;
  /** Required when fired = true. */
  evidence?: Evidence;
  /** Overrides Rule.severity when present (Section 6.4's PEP-vs-sanctions split). */
  severity?: AlertSeverity;
  /** Overrides the scenario's default dedup-key derivation. */
  dedupKey?: string;
}
