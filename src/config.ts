import dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: ".env.local" });

// Configuration interfaces
export interface TimeoutConfig {
    API_REQUEST: number;
    WEB_REQUEST: number;
    COMMAND_EXECUTION: number;
    IMAGE_ANALYSIS: number;
}

export interface RetryConfig {
    MAX_ATTEMPTS: number;
    BASE_DELAY: number;
    MAX_DELAY: number;
    BACKOFF_MULTIPLIER: number;
}

export interface AzureConfig {
    API_VERSION: string | undefined;
    GPT_API_KEY: string | undefined;
    GPT_ENDPOINT: string | undefined;
}

export interface Config {
    TIMEOUTS: TimeoutConfig;
    RETRY: RetryConfig;
    AZURE: AzureConfig;
}

export interface RetryOptions {
    maxAttempts?: number;
    baseDelay?: number;
    multiplier?: number;
    maxDelay?: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number) => void;
}

// Configuration constants
export const CONFIG: Config = {
  // Timeout settings (in milliseconds)
  TIMEOUTS: {
    API_REQUEST: parseInt(process.env.API_TIMEOUT ?? "60000"), // 60 seconds
    WEB_REQUEST: parseInt(process.env.WEB_TIMEOUT ?? "30000"), // 30 seconds
    COMMAND_EXECUTION: parseInt(process.env.COMMAND_TIMEOUT ?? "120000"), // 2 minutes
    IMAGE_ANALYSIS: parseInt(process.env.IMAGE_TIMEOUT ?? "90000") // 90 seconds
  },

  // Retry settings
  RETRY: {
    MAX_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS ?? "3"),
    BASE_DELAY: parseInt(process.env.RETRY_BASE_DELAY ?? "1000"), // 1 second
    MAX_DELAY: parseInt(process.env.RETRY_MAX_DELAY ?? "30000"), // 30 seconds
    BACKOFF_MULTIPLIER: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER ?? "2")
  },

  // Azure settings
  AZURE: {
    API_VERSION: process.env.AZURE_API_VERSION,
    GPT_API_KEY: process.env.AZURE_GPT_API_KEY,
    GPT_ENDPOINT: process.env.AZURE_GPT_ENDPOINT
  }
};
