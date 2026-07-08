import { RiskFactorType } from "@regops/shared";

export interface DefaultRiskFactorConfig {
  factorType: RiskFactorType;
  weight: number;
  config: Record<string, unknown>;
}

/**
 * Seeded into risk_factor_config for every new tenant (see packages/db's
 * seed script and TenantsService.create) — this is the algorithm. A tenant
 * admin can tune weight/config afterward without any code change.
 */
export const DEFAULT_RISK_FACTOR_CONFIGS: DefaultRiskFactorConfig[] = [
  {
    factorType: RiskFactorType.CUSTOMER_TYPE,
    weight: 1.0,
    config: {
      scores: {
        GOVERNMENT: 10,
        INDIVIDUAL: 20,
        SME: 30,
        CORPORATE: 40,
        NGO: 60,
        PEP: 80,
      },
    },
  },
  {
    factorType: RiskFactorType.OCCUPATION,
    weight: 1.0,
    config: {
      highRiskKeywords: ["cash-intensive", "politically connected", "gambling", "crypto", "jewelry", "dealer"],
      highRiskScore: 60,
      mediumRiskKeywords: ["trader", "importer", "exporter", "contractor"],
      mediumRiskScore: 30,
      defaultScore: 10,
    },
  },
  {
    factorType: RiskFactorType.COUNTRY,
    weight: 1.0,
    config: {
      fatfBlacklist: ["IR", "KP", "MM"],
      fatfGreylist: ["AF", "SY", "YE", "LY"],
      highRisk: ["VE", "IQ", "LB", "SO"],
      default: 0,
    },
  },
  {
    factorType: RiskFactorType.PRODUCT_MIX,
    weight: 1.0,
    config: {},
  },
  {
    factorType: RiskFactorType.KYC_TIER,
    weight: 1.0,
    config: {
      scores: { "1": 30, "2": 15, "3": 0 },
    },
  },
  {
    factorType: RiskFactorType.TRANSACTION_VELOCITY,
    weight: 1.0,
    config: {
      spikeMultiplier: 5,
      spikeMinAmount: 1_000_000,
      dormancyDays: 90,
      maxScore: 50,
    },
  },
];
