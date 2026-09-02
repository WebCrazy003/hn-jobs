import type { HnItem } from "./types.ts";

export function parseHnThreadUrl(value: string): { id: number; url: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Hacker News item URL.");
  }
  const rawIds = url.searchParams.getAll("id");
  const id = Number(rawIds[0]);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "news.ycombinator.com" ||
    url.pathname !== "/item" ||
    rawIds.length !== 1 ||
    !Number.isSafeInteger(id) ||
    id <= 0
  ) {
    throw new Error("Use an HTTPS Hacker News item URL such as https://news.ycombinator.com/item?id=123.");
  }
  return { id, url: `https://news.ycombinator.com/item?id=${id}` };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

class RetryableHnError extends Error {}

export class HnClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    baseUrl: string,
    timeoutMs: number,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = fetchImplementation;
  }

  async fetchItem(id: number, signal?: AbortSignal): Promise<HnItem | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const response = await this.fetchImplementation(`${this.baseUrl}/item/${id}.json`, {
          headers: { accept: "application/json" },
          signal: combinedSignal,
        });
        if (!response.ok) {
          if (response.status >= 500) throw new RetryableHnError(`HN API returned ${response.status}`);
          throw new Error(`HN API request failed with ${response.status}`);
        }
        return (await response.json()) as HnItem | null;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        lastError = error;
        if (
          attempt === 2 ||
          (!isAbortError(error) && !(error instanceof TypeError) && !(error instanceof RetryableHnError))
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  async validateThreadUrl(value: string): Promise<{ id: number; url: string; title: string }> {
    const parsed = parseHnThreadUrl(value);
    const item = await this.fetchItem(parsed.id);
    if (
      !item ||
      item.type !== "story" ||
      item.deleted ||
      item.dead ||
      !item.title ||
      !/who is hiring\?/i.test(item.title)
    ) {
      throw new Error("This item is not a live Hacker News “Who is hiring?” story.");
    }
    return { ...parsed, title: item.title };
  }
}
