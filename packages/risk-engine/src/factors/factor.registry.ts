import { RiskFactor } from "../types";
import { CustomerTypeFactor } from "./customer-type.factor";
import { OccupationFactor } from "./occupation.factor";
import { CountryFactor } from "./country.factor";
import { ProductMixFactor } from "./product-mix.factor";
import { KycTierFactor } from "./kyc-tier.factor";
import { TransactionVelocityAdapter, TransactionVelocityFactor } from "./transaction-velocity.factor";

/**
 * The full set of factors the engine runs for every score calculation.
 * Adding a factor is adding a class here — the orchestrator (RiskService)
 * just iterates whatever this returns, it doesn't know about individual
 * factor types.
 */
export function createFactorRegistry(transactionAdapter?: TransactionVelocityAdapter): RiskFactor[] {
  return [
    new CustomerTypeFactor(),
    new OccupationFactor(),
    new CountryFactor(),
    new ProductMixFactor(),
    new KycTierFactor(),
    new TransactionVelocityFactor(transactionAdapter),
  ];
}
