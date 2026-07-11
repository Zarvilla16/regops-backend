import { ScreeningCheckType, ScreeningResultType } from "@regops/shared";
import { MockProvider } from "./mock.provider";
import { ProviderTransientError } from "../types";

describe("MockProvider", () => {
  const provider = new MockProvider();

  it("returns CONFIRMED_MATCH score 95 on OFAC_SDN for a name containing SANCTIONED", async () => {
    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "John SANCTIONED Doe" }, {});
    expect(result.status).toBe(ScreeningResultType.CONFIRMED_MATCH);
    expect(result.highestMatchScore).toBe(95);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].listSource).toBe("OFAC_SDN");
  });

  it("returns POTENTIAL_MATCH score 72 on UN_CONSOLIDATED for a name containing POSSIBLY_SANCTIONED", async () => {
    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "Jane POSSIBLY_SANCTIONED Doe" }, {});
    expect(result.status).toBe(ScreeningResultType.POTENTIAL_MATCH);
    expect(result.highestMatchScore).toBe(72);
    expect(result.matches[0].listSource).toBe("UN_CONSOLIDATED");
  });

  it("does not fall through POSSIBLY_SANCTIONED into the plain SANCTIONED branch (substring ordering)", async () => {
    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "POSSIBLY_SANCTIONED Corp" }, {});
    expect(result.highestMatchScore).toBe(72);
    expect(result.matches[0].listSource).toBe("UN_CONSOLIDATED");
  });

  it("returns CONFIRMED_MATCH score 90 on DOMESTIC_PEP for a name containing PEP", async () => {
    const result = await provider.screen(ScreeningCheckType.PEP, { fullName: "Chinedu PEP Okafor" }, {});
    expect(result.status).toBe(ScreeningResultType.CONFIRMED_MATCH);
    expect(result.highestMatchScore).toBe(90);
    expect(result.matches[0].listSource).toBe("DOMESTIC_PEP");
  });

  it("throws ProviderTransientError for a name containing TIMEOUT_TEST", async () => {
    await expect(provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "TIMEOUT_TEST Ltd" }, {})).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it("throws an unhandled exception (not ProviderTransientError/ProviderBadRequestError) for CRASH_TEST", async () => {
    await expect(provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "CRASH_TEST Inc" }, {})).rejects.toThrow(
      /simulated unhandled crash/,
    );
  });

  it("returns CLEAN with no matches for an unrelated name", async () => {
    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "Ordinary Customer" }, {});
    expect(result.status).toBe(ScreeningResultType.CLEAN);
    expect(result.highestMatchScore).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("is case-insensitive on the trigger substrings", async () => {
    const result = await provider.screen(ScreeningCheckType.PEP, { fullName: "lowercase pep name" }, {});
    expect(result.status).toBe(ScreeningResultType.CONFIRMED_MATCH);
  });

  it("healthCheck always reports ok", async () => {
    await expect(provider.healthCheck()).resolves.toMatchObject({ ok: true });
  });
});
