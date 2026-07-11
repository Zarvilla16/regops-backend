import { ScreeningCheckType, ScreeningResultType } from "@regops/shared";
import { SmileIdProvider } from "./smile-id.provider";

describe("SmileIdProvider", () => {
  const originalFetch = global.fetch;
  const provider = new SmileIdProvider();
  const config = { apiKey: "key", apiSecret: "secret" };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("maps match_categories/confidence_value into ProviderMatch[] and bands the result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        job_id: "job-123",
        result: {
          matches: [
            { list_category: "OFAC_SDN", full_name: "John Doe", confidence_value: 90 },
            { list_category: "un consolidated", full_name: "John D.", confidence_value: 40 },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "John Doe" }, config);

    expect(result.providerReference).toBe("job-123");
    expect(result.highestMatchScore).toBe(90);
    expect(result.status).toBe(ScreeningResultType.CONFIRMED_MATCH);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].listSource).toBe("OFAC_SDN");
    expect(result.matches[1].listSource).toBe("UN_CONSOLIDATED");
  });

  it("returns CLEAN with no matches when the provider finds nothing", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ job_id: "job-456", result: {} }),
    }) as unknown as typeof fetch;

    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "Clean Person" }, config);
    expect(result.status).toBe(ScreeningResultType.CLEAN);
    expect(result.matches).toHaveLength(0);
  });

  it("sends signature-based auth headers derived from the resolved config", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ job_id: "j", result: {} }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await provider.screen(ScreeningCheckType.PEP, { fullName: "Test" }, config);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["smileid-partner-id"]).toBe("key");
    expect(init.headers["smileid-signature"]).toEqual(expect.any(String));
  });

  it("healthCheck reports ok", async () => {
    await expect(provider.healthCheck()).resolves.toMatchObject({ ok: true });
  });
});
