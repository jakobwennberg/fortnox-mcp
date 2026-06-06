import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { getTokenProvider } from "../auth/index.js";
import { getCurrentUserId } from "../auth/context.js";
import {
  FORTNOX_API_BASE_URL,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  MIN_REQUEST_SPACING_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  MAX_FETCH_ALL_RESULTS,
  MAX_FETCH_ALL_PAGES,
  FETCH_ALL_PAGE_SIZE,
  FETCH_ALL_DELAY_MS
} from "../constants.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Rate limiting state
let requestTimestamps: number[] = [];
// Serialization gate so concurrent callers queue through the limiter one at a time,
// turning a parallel burst into an evenly paced stream.
let rateLimitGate: Promise<void> = Promise.resolve();

/**
 * Simple rate limiter for Fortnox API (25 requests per 5 seconds)
 */
async function waitForRateLimit(): Promise<void> {
  // Serialize concurrent callers: each waits for the previous one to finish pacing
  // before computing its own delay. Without this, N parallel requests all read the same
  // window state and fire at once (the burst that triggers Fortnox 429s).
  const prior = rateLimitGate;
  let release!: () => void;
  rateLimitGate = new Promise<void>((resolve) => { release = resolve; });
  await prior;

  try {
    let now = Date.now();

    // Remove timestamps outside the sliding window
    requestTimestamps = requestTimestamps.filter(
      (ts) => now - ts < RATE_LIMIT_WINDOW_MS
    );

    // Sliding-window cap: if at limit, wait for the oldest request to expire
    if (requestTimestamps.length >= RATE_LIMIT_REQUESTS) {
      const oldestTimestamp = requestTimestamps[0];
      const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestTimestamp) + 50; // +50ms buffer
      if (waitTime > 0) {
        await sleep(waitTime);
      }
      now = Date.now();
      requestTimestamps = requestTimestamps.filter(
        (ts) => now - ts < RATE_LIMIT_WINDOW_MS
      );
    }

    // Minimum spacing between request starts: smooths the allowed burst into a steady
    // stream so we don't trip Fortnox's per-second enforcement.
    const lastTimestamp = requestTimestamps[requestTimestamps.length - 1];
    if (lastTimestamp !== undefined) {
      const sinceLast = Date.now() - lastTimestamp;
      if (sinceLast < MIN_REQUEST_SPACING_MS) {
        await sleep(MIN_REQUEST_SPACING_MS - sinceLast);
      }
    }

    requestTimestamps.push(Date.now());
  } finally {
    // Let the next queued caller proceed.
    release();
  }
}

/** Status codes worth retrying: rate limiting and transient server errors. */
function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

/**
 * How long to wait before the next retry. Honors a Retry-After header (seconds or HTTP
 * date) when Fortnox sends one; otherwise exponential backoff with jitter, capped.
 */
function computeRetryDelayMs(error: unknown, attempt: number): number {
  const header = axios.isAxiosError(error)
    ? error.response?.headers?.["retry-after"]
    : undefined;
  if (header !== undefined) {
    const asSeconds = Number(header);
    if (!Number.isNaN(asSeconds)) {
      return Math.min(asSeconds * 1000, RETRY_MAX_DELAY_MS);
    }
    const asDate = Date.parse(String(header));
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), RETRY_MAX_DELAY_MS);
    }
  }
  const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jitter = backoff * 0.25 * (((attempt * 2654435761) % 1000) / 1000); // deterministic jitter
  return backoff + jitter;
}

/**
 * Make an authenticated request to the Fortnox API
 * Automatically uses the current user context in remote mode
 */
export async function fortnoxRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  data?: unknown,
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  // Get access token using the token provider
  // In local mode, userId is undefined and ignored
  // In remote mode, userId comes from the request context
  const tokenProvider = getTokenProvider();
  const userId = getCurrentUserId();
  const accessToken = await tokenProvider.getAccessToken(userId);

  // Clean undefined params
  const cleanParams: Record<string, string | number | boolean> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        cleanParams[key] = value;
      }
    }
  }

  const config: AxiosRequestConfig = {
    method,
    url: `${FORTNOX_API_BASE_URL}${endpoint}`,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    timeout: 30000,
    params: Object.keys(cleanParams).length > 0 ? cleanParams : undefined,
    data
  };

  // Retry loop: transient failures (429 / 5xx) back off and retry instead of being
  // surfaced as a hard error that silently drops the caller's data.
  let attempt = 0;
  for (;;) {
    await waitForRateLimit();
    try {
      const response = await axios(config);
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (isRetryableStatus(status) && attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(computeRetryDelayMs(error, attempt));
        attempt++;
        continue;
      }
      throw handleApiError(error, endpoint);
    }
  }
}

/**
 * Handle API errors with descriptive messages
 */
export function handleApiError(error: unknown, context?: string): Error {
  const prefix = context ? `[${context}] ` : "";

  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const data = error.response?.data;

    // Extract Fortnox-specific error message
    const fortnoxError = data?.ErrorInformation?.message ||
      data?.ErrorInformation?.Message ||
      data?.message ||
      data?.error;

    switch (status) {
      case 400:
        return new Error(
          `${prefix}Bad request: ${fortnoxError || "Invalid parameters"}. ` +
          `Check that all required fields are provided and values are valid.`
        );
      case 401:
        return new Error(
          `${prefix}Authentication failed. The access token may be expired or invalid. ` +
          `Try refreshing authentication.`
        );
      case 403:
        return new Error(
          `${prefix}Permission denied. Your API credentials don't have access to this resource. ` +
          `Check your Fortnox app scopes.`
        );
      case 404:
        return new Error(
          `${prefix}Resource not found. The requested item does not exist or has been deleted.`
        );
      case 429:
        return new Error(
          `${prefix}Rate limit exceeded. Fortnox allows 25 requests per 5 seconds. ` +
          `Please wait before retrying.`
        );
      case 500:
      case 502:
      case 503:
        return new Error(
          `${prefix}Fortnox server error (${status}). The service may be temporarily unavailable. ` +
          `Please try again later.`
        );
      default:
        return new Error(
          `${prefix}API error ${status}: ${fortnoxError || JSON.stringify(data)}`
        );
    }
  }

  if (error instanceof Error) {
    if (error.message.includes("ECONNABORTED") || error.message.includes("timeout")) {
      return new Error(
        `${prefix}Request timed out. The Fortnox API is not responding. Please try again.`
      );
    }
    if (error.message.includes("ENOTFOUND") || error.message.includes("ECONNREFUSED")) {
      return new Error(
        `${prefix}Cannot connect to Fortnox API. Check your internet connection.`
      );
    }
    return new Error(`${prefix}${error.message}`);
  }

  return new Error(`${prefix}Unexpected error: ${String(error)}`);
}

/**
 * Format a date for Fortnox API (YYYY-MM-DD)
 */
export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Parse a Fortnox date string to Date object
 */
export function parseDate(dateStr: string): Date {
  return new Date(dateStr);
}

/**
 * Configuration for fetchAllPages
 */
export interface FetchAllConfig {
  /** Maximum total results to fetch (default: MAX_FETCH_ALL_RESULTS) */
  maxResults?: number;
  /** Maximum pages to fetch (default: MAX_FETCH_ALL_PAGES) */
  maxPages?: number;
  /** Page size for each request (default: FETCH_ALL_PAGE_SIZE) */
  pageSize?: number;
  /** Delay between page requests in ms (default: FETCH_ALL_DELAY_MS) */
  delayBetweenPages?: number;
}

/**
 * Result from fetchAllPages
 */
export interface FetchAllResult<T> {
  /** All items fetched */
  items: T[];
  /** Total count from API (may be higher than items.length if truncated) */
  total: number;
  /** Number of pages fetched */
  pagesFetched: number;
  /** Whether results were truncated due to limits */
  truncated: boolean;
  /** Reason for truncation if truncated is true */
  truncationReason?: string;
}

/**
 * Delay execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch all pages of a paginated Fortnox API endpoint
 *
 * This function automatically paginates through all results from a Fortnox endpoint.
 * It includes safety limits to prevent runaway queries and respects rate limits.
 *
 * @param endpoint - API endpoint (e.g., "/3/invoices")
 * @param params - Query parameters to pass to each request
 * @param extractItems - Function to extract items array from response
 * @param extractTotal - Function to extract total count from response
 * @param config - Optional configuration for limits and delays
 * @returns All items fetched with metadata about the fetch operation
 *
 * @example
 * const result = await fetchAllPages<Invoice, InvoiceListResponse>(
 *   "/3/invoices",
 *   { filter: "unpaid" },
 *   (r) => r.Invoices || [],
 *   (r) => r.MetaInformation?.["@TotalResources"] || 0
 * );
 */
export async function fetchAllPages<T, R>(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>,
  extractItems: (response: R) => T[],
  extractTotal: (response: R) => number,
  config?: FetchAllConfig
): Promise<FetchAllResult<T>> {
  const maxResults = config?.maxResults ?? MAX_FETCH_ALL_RESULTS;
  const maxPages = config?.maxPages ?? MAX_FETCH_ALL_PAGES;
  const pageSize = config?.pageSize ?? FETCH_ALL_PAGE_SIZE;
  const delayMs = config?.delayBetweenPages ?? FETCH_ALL_DELAY_MS;

  const allItems: T[] = [];
  let page = 1;
  let total = 0;
  let hasMore = true;
  let truncated = false;
  let truncationReason: string | undefined;

  while (hasMore) {
    // Check page limit
    if (page > maxPages) {
      truncated = true;
      truncationReason = `Reached maximum page limit (${maxPages} pages). Use filters to narrow results.`;
      break;
    }

    // Check result limit
    if (allItems.length >= maxResults) {
      truncated = true;
      truncationReason = `Reached maximum result limit (${maxResults} items). Use filters to narrow results.`;
      break;
    }

    // Make request
    const response = await fortnoxRequest<R>(endpoint, "GET", undefined, {
      ...params,
      limit: pageSize,
      page
    });

    const items = extractItems(response);
    total = extractTotal(response);

    if (items.length === 0) {
      hasMore = false;
    } else {
      allItems.push(...items);

      // Check if we've fetched all available items
      if (allItems.length >= total) {
        hasMore = false;
      } else {
        page++;
        // Delay to respect rate limits (except on last page)
        if (hasMore) {
          await delay(delayMs);
        }
      }
    }
  }

  return {
    items: allItems,
    total,
    pagesFetched: page,
    truncated,
    truncationReason
  };
}
