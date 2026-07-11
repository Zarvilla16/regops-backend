import { ProviderBadRequestError, ProviderTransientError } from "../types";

export interface FetchJsonOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/**
 * Native fetch + AbortController — no HTTP client dependency needed, and
 * Section 10.1's unit tests explicitly describe "AbortController fires at
 * configured ms" as the timeout mechanism to test, which native fetch
 * supports directly. Maps the real provider's response into the same two
 * error classes both SmileIdProvider and PremblyProvider throw:
 * ProviderTransientError for timeout/network/5xx (retry-eligible),
 * ProviderBadRequestError for 4xx (never retried).
 */
export async function fetchProviderJson<T>(options: FetchJsonOptions): Promise<{ data: T; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(options.url, {
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    if (response.status >= 500) {
      throw new ProviderTransientError(`Provider returned ${response.status}`);
    }
    if (response.status >= 400) {
      const detail = await response.text().catch(() => "");
      throw new ProviderBadRequestError(`Provider rejected request with ${response.status}: ${detail}`);
    }

    const data = (await response.json()) as T;
    return { data, latencyMs };
  } catch (err) {
    if (err instanceof ProviderBadRequestError || err instanceof ProviderTransientError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderTransientError(`Provider call timed out after ${options.timeoutMs}ms`, err);
    }
    // Network failure (DNS, connection refused, etc.) — same transient class as a 5xx.
    throw new ProviderTransientError("Provider call failed", err);
  } finally {
    clearTimeout(timer);
  }
}
