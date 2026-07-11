import { createHash } from "crypto";
import { ScreeningInput } from "./types";

/**
 * sha256 of a normalized ScreeningInput — used by the orchestrator (Section
 * 5.5) to dedup identical screening calls for the same customer within a 1
 * hour window. Normalization (lowercase name, ISO date, uppercase country
 * codes) means cosmetically different inputs that mean the same thing hash
 * identically, e.g. trailing whitespace or a differently-cased name.
 */
export function computeInputHash(input: ScreeningInput): string {
  const normalized = {
    fullName: input.fullName.trim().toLowerCase().replace(/\s+/g, " "),
    dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth).toISOString().slice(0, 10) : null,
    bvn: input.bvn ?? null,
    nin: input.nin ?? null,
    country: input.country ? input.country.toUpperCase() : null,
    nationality: input.nationality ? input.nationality.toUpperCase() : null,
    gender: input.gender ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
