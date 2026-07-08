import { CustomerType, RiskFactorType } from "@regops/shared";

/**
 * Deliberately NOT the full CustomerEntity from @regops/db — this package
 * must stay dependency-free of @regops/db (which itself needs this
 * package's default configs to seed new tenants; depending on @regops/db
 * here would create a circular workspace dependency). A real CustomerEntity
 * instance structurally satisfies this shape, so callers pass it straight
 * through with no adapter needed.
 */
export interface RiskFactorCustomer {
  customerType: CustomerType;
  occupation: string | null;
  country: string;
  nationality: string | null;
  kycTier: number;
  isPep: boolean;
  isSanctioned: boolean;
}

export interface RiskFactorTenant {
  id: string;
}

export interface RiskFactorConfigInput {
  factorType: RiskFactorType;
  weight: number;
  config: Record<string, unknown>;
  isActive: boolean;
}

export interface RiskFactorContext {
  customerId: string;
  customer: RiskFactorCustomer;
  tenant: RiskFactorTenant;
  config: RiskFactorConfigInput;
  now: Date;
}

export interface RiskFactorResult {
  factorType: RiskFactorType;
  /** Before weight, 0-100. */
  rawValue: number;
  /** From config — the tenant's tuned multiplier for this factor. */
  weight: number;
  /** rawValue * weight, capped at 100. */
  contributedScore: number;
  /** For audit/explanation — persisted verbatim into RiskScoreHistory.factors. */
  detail: Record<string, unknown>;
}

export interface RiskFactor {
  readonly type: RiskFactorType;
  calculate(ctx: RiskFactorContext): Promise<RiskFactorResult>;
}

function capScore(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

export function contribute(factorType: RiskFactorType, rawValue: number, weight: number, detail: Record<string, unknown>): RiskFactorResult {
  return { factorType, rawValue, weight, contributedScore: capScore(rawValue * weight), detail };
}
