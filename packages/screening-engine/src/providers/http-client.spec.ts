import { fetchProviderJson } from "./http-client";
import { ProviderBadRequestError, ProviderTransientError } from "../types";

describe("fetchProviderJson", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns parsed JSON and latency on a 2xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    }) as unknown as typeof fetch;

    const { data } = await fetchProviderJson<{ ok: boolean }>({ url: "https://example.test", timeoutMs: 1000 });
    expect(data).toEqual({ ok: true });
  });

  it("throws ProviderTransientError on a 5xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 502, text: async () => "bad gateway" }) as unknown as typeof fetch;

    await expect(fetchProviderJson({ url: "https://example.test", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it("throws ProviderBadRequestError on a 4xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 422, text: async () => "invalid" }) as unknown as typeof fetch;

    await expect(fetchProviderJson({ url: "https://example.test", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      ProviderBadRequestError,
    );
  });

  it("throws ProviderTransientError when AbortController fires (timeout)", async () => {
    global.fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    await expect(fetchProviderJson({ url: "https://example.test", timeoutMs: 5 })).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });

  it("throws ProviderTransientError on a network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(fetchProviderJson({ url: "https://example.test", timeoutMs: 1000 })).rejects.toBeInstanceOf(
      ProviderTransientError,
    );
  });
});
