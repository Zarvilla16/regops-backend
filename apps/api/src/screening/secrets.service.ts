import { Injectable } from "@nestjs/common";

/**
 * Resolves a ScreeningProviderConfig.credentials_ref into the actual secret
 * value at call time (Section 7.4). v1 ships with the env:// scheme working;
 * vault:// is a stub that throws "not implemented" — this lets the schema be
 * production-shaped now (credentials_ref itself is never plaintext, however
 * it resolves) without a real HashiCorp Vault integration being a
 * prerequisite for this prompt.
 */
@Injectable()
export class SecretsService {
  async resolve(ref: string): Promise<string> {
    if (ref.startsWith("env://")) {
      return process.env[ref.slice(6)] ?? "";
    }
    if (ref.startsWith("vault://")) {
      throw new Error("vault:// secret resolution is not implemented in v1 — see SecretsService docblock.");
    }
    throw new Error(`Unknown secret ref scheme: ${ref}`);
  }
}
