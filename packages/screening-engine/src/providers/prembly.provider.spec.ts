import { ScreeningCheckType, ScreeningResultType } from "@regops/shared";
import { PremblyProvider } from "./prembly.provider";

describe("PremblyProvider", () => {
  const originalFetch = global.fetch;
  const provider = new PremblyProvider();
  const config = { apiKey: "key", appId: "app-1" };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("maps watchlist_hits into ProviderMatch[] and bands the result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        reference: "ref-789",
        data: { watchlist_hits: [{ source: "domestic pep", matched_name: "Jane PEP", score: 88 }] },
      }),
    }) as unknown as typeof fetch;

    const result = await provider.screen(ScreeningCheckType.PEP, { fullName: "Jane PEP" }, config);

    expect(result.providerReference).toBe("ref-789");
    expect(result.highestMatchScore).toBe(88);
    expect(result.status).toBe(ScreeningResultType.CONFIRMED_MATCH);
    expect(result.matches[0].listSource).toBe("DOMESTIC_PEP");
  });

  it("returns CLEAN when there are no watchlist hits", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ reference: "ref-000", data: {} }),
    }) as unknown as typeof fetch;

    const result = await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "Clean Person" }, config);
    expect(result.status).toBe(ScreeningResultType.CLEAN);
  });

  it("sends x-api-key / app-id headers from the resolved config", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ reference: "r", data: {} }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await provider.screen(ScreeningCheckType.SANCTIONS, { fullName: "Test" }, config);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-api-key"]).toBe("key");
    expect(init.headers["app-id"]).toBe("app-1");
  });

  it("healthCheck reports ok", async () => {
    await expect(provider.healthCheck()).resolves.toMatchObject({ ok: true });
  });
});
