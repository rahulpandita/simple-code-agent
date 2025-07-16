import OpenAI from "openai";
import { CONFIG } from "../config.js";

// Create and export the OpenAI client
export const openai = new OpenAI({
  apiKey: CONFIG.AZURE.GPT_API_KEY,
  baseURL: CONFIG.AZURE.GPT_ENDPOINT,
  defaultQuery: CONFIG.AZURE.GPT_ENDPOINT ? { "api-version": CONFIG.AZURE.API_VERSION } : undefined,
  defaultHeaders: CONFIG.AZURE.GPT_ENDPOINT ? { "api-key": CONFIG.AZURE.GPT_API_KEY } : undefined
});

// Utility function for exponential backoff delay
export function calculateDelay(
  attempt: number,
  baseDelay: number = CONFIG.RETRY.BASE_DELAY,
  multiplier: number = CONFIG.RETRY.BACKOFF_MULTIPLIER,
  maxDelay: number = CONFIG.RETRY.MAX_DELAY
): number {
  const delay = baseDelay * Math.pow(multiplier, attempt - 1);
  return Math.min(delay, maxDelay);
}

// Generic retry wrapper with exponential backoff
export function withRetry<T>(
  operation: () => Promise<T>,
  options: import("../config.js").RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = CONFIG.RETRY.MAX_ATTEMPTS,
    baseDelay = CONFIG.RETRY.BASE_DELAY,
    multiplier = CONFIG.RETRY.BACKOFF_MULTIPLIER,
    maxDelay = CONFIG.RETRY.MAX_DELAY,
    shouldRetry = (_error: unknown) => true, // Default: retry on any error
    onRetry = (error: unknown, attempt: number) =>
      console.log(`Retry attempt ${attempt} after error: ${(error as Error).message}`)
  } = options;

  return new Promise((resolve, reject) => {
    const attemptOperation = async (attempt: number): Promise<void> => {
      try {
        const result = await operation();
        resolve(result);
      } catch (error) {
        // Don't retry on the last attempt or if shouldRetry returns false
        if (attempt === maxAttempts || !shouldRetry(error)) {
          reject(error);
          return;
        }

        const delay = calculateDelay(attempt, baseDelay, multiplier, maxDelay);
        onRetry(error, attempt);
        setTimeout(() => {
          void attemptOperation(attempt + 1);
        }, delay);
      }
    };

    void attemptOperation(1);
  });
}

// Enhanced OpenAI API call with retry
export function openaiWithRetry<T>(
  operation: () => Promise<T>,
  options: import("../config.js").RetryOptions = {}
): Promise<T> {
  return withRetry(operation, {
    ...options,
    shouldRetry: (error: unknown) => {
      const err = error as { status?: number; code?: string; message?: string };
      // Retry on rate limits, network errors, and 5xx status codes
      return Boolean(
        err.status === 429 || // Rate limit
        (err.status !== undefined && err.status >= 500) || // Server errors
        err.code === "ECONNRESET" ||
        err.code === "ENOTFOUND" ||
        (err.message?.includes("timeout"))
      );
    },
    onRetry: (error: unknown, attempt: number) => {
      const err = error as { status?: number; message?: string };
      if (err.status === 429) {
        console.log(`Rate limited, retry attempt ${attempt} after backoff`);
      } else {
        console.log(`API error, retry attempt ${attempt}: ${err.message ?? "Unknown error"}`);
      }
    }
  });
}

// Enhanced fetch with timeout and retry
export function fetchWithRetry(
  url: string,
  options: import("../types.js").FetchOptions = {}
): Promise<import("node-fetch").Response> {
  const { timeout = CONFIG.TIMEOUTS.WEB_REQUEST, retryOptions = {}, ...fetchOptions } = options;

  return withRetry(
    async () => {
      const fetch = (await import("node-fetch")).default;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal
        } as import("node-fetch").RequestInit);

        clearTimeout(timeoutId);

        // Check if response is ok, throw error for bad status codes that should be retried
        if (!response.ok && response.status >= 500) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response;
      } catch (error: unknown) {
        clearTimeout(timeoutId);

        // Transform abort error to timeout error
        if ((error as Error).name === "AbortError") {
          throw new Error(`Request timeout after ${timeout}ms`);
        }

        throw error;
      }
    },
    {
      ...retryOptions,
      shouldRetry: (error: unknown) => {
        const errorMessage = (error as Error).message;
        // Retry on network errors, timeouts, and 5xx status codes
        return (
          errorMessage.includes("timeout") ||
          errorMessage.includes("ECONNRESET") ||
          errorMessage.includes("ENOTFOUND") ||
          errorMessage.includes("ECONNREFUSED") ||
          errorMessage.includes("HTTP 5")
        );
      }
    }
  );
}
