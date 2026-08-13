// ─── modules/ai/ai.types.ts — AI Generation domain types ─────────────────────

export interface GenerateOptions {
  prompt: string;
  device: string;
  style: string;
  fidelity?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Pre-computed by aiBudgetMiddleware — avoids double-scoring in the service */
  _complexity?: ComplexityResult;
  /** Plan string passed through for model routing */
  _plan?: string;
}

// ─── Complexity Scoring ───────────────────────────────────────────────────────

export interface ComplexityResult {
  score: number;        // 1 (single component) to 10 (full multi-section layout)
  sectionCount: number;
  promptLength: number;
  device: string;
  tokenBudget: number;  // recommended max_tokens for this request
}

// ─── Stream Telemetry ─────────────────────────────────────────────────────────

export interface StreamTelemetry {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error' | 'unknown';
  durationMs: number;
  model: string;
  complexityScore: number;
  tokenBudget: number;
}

// ─── OpenRouter Stream Result ─────────────────────────────────────────────────

import { Transform } from 'stream';

export interface OpenRouterStreamResult {
  /** Telemetry-intercepting passthrough stream — pipe this to Express res */
  stream: Transform;
  /** Resolves with telemetry after the stream fully ends */
  telemetryPromise: Promise<StreamTelemetry>;
  /** Actual OpenRouter model used (may differ from user selection after routing) */
  model: string;
  complexityScore: number;
  tokenBudget: number;
}
