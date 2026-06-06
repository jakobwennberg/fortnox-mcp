// Fortnox API Configuration
export const FORTNOX_API_BASE_URL = "https://api.fortnox.se";
export const FORTNOX_OAUTH_URL = "https://apps.fortnox.se/oauth-v1";

// Rate limiting: 25 requests per 5 seconds
export const RATE_LIMIT_REQUESTS = 25;
export const RATE_LIMIT_WINDOW_MS = 5000;

// Response limits
export const CHARACTER_LIMIT = 25000;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Token expiry buffer (refresh 5 minutes before expiry)
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Fetch-all safety limits for analytics queries
export const MAX_FETCH_ALL_RESULTS = 10000;
export const MAX_FETCH_ALL_PAGES = 100;
export const FETCH_ALL_PAGE_SIZE = 100;
export const FETCH_ALL_DELAY_MS = 250; // Stay under 25 req/5sec rate limit

// Minimum spacing between request *starts* so concurrent callers become a steady
// stream instead of an instant burst (25 req / 5 s = 200ms; small buffer added).
export const MIN_REQUEST_SPACING_MS = 210;

// Transient-failure retry (HTTP 429 and 5xx). Backoff honors Retry-After when present,
// otherwise exponential: RETRY_BASE_DELAY_MS * 2^attempt, capped at RETRY_MAX_DELAY_MS.
export const MAX_RETRY_ATTEMPTS = 5;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 8000;

// Response format enum
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}
