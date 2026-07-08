import { CustomerType, RiskFactorType } from "@regops/shared";
import { RiskFactorContext } from "./types";

/** Shared test fixture builder — not a .spec.ts, so jest's testRegex won't pick it up as a suite. */
export function buildContext(
  factorType: RiskFactorType,
  config: Record<string, unknown>,
  overrides: {
    weight?: number;
    customer?: Partial<RiskFactorContext["customer"]>;
  } = {},
): RiskFactorContext {
  return {
    customerId: "customer-1",
    customer: {
      customerType: CustomerType.INDIVIDUAL,
      occupation: null,
      country: "NG",
      nationality: null,
      kycTier: 1,
      isPep: false,
      isSanctioned: false,
      ...overrides.customer,
    },
    tenant: { id: "tenant-1" },
    config: {
      factorType,
      weight: overrides.weight ?? 1.0,
      config,
      isActive: true,
    },
    now: new Date("2024-01-01T00:00:00.000Z"),
  };
}
