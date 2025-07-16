import type { RequestInit } from "node-fetch";
import type { RetryOptions } from "./config.js";

// Core API types
export interface FetchOptions extends RequestInit {
  timeout?: number;
  retryOptions?: RetryOptions;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResultWithContent extends SearchResult {
  content: string;
}

export interface ImageAnalysisResult {
  imageUrl: string;
  analysis: string;
  imageNumber: number;
}

// OpenAI/Tool related types
export interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface Tool {
  type: "function";
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Tool parameter interfaces
export interface ReadFileParams {
  path: string;
}

export interface WriteFileParams {
  path: string;
  content: string;
}

export interface RunCommandParams {
  command: string;
}

export interface AnalyzeImageParams {
  path: string;
  prompt?: string;
}

export interface ImageSearchAnalysisParams {
  query: string;
  analysis_prompt?: string;
}

export interface WebresearchParams {
  query: string;
}

export interface DoneParams {
  summary: string;
}
