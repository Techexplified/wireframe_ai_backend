// ─── modules/ai/ai.telemetry.ts — AI Request Telemetry Logger ─────────────────
//
// Records one document per OpenRouter request to the `ai_requests_log` collection.
// Logs: model, exact token counts, estimated USD cost, finish_reason, duration,
// and complexity score. Used for cost analysis and optimization iteration.

import { connectToDatabase } from '../../config/database';
import { MODEL_PRICING } from '../../config/constants';
import { logger } from '../../utils/logger';

// ─── Document Interface ───────────────────────────────────────────────────────

export interface AiRequestLogDoc {
  figmaUserId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  finishReason: string;
  durationMs: number;
  complexityScore: number;
  tokenBudget: number;
  timestamp: Date;
}

// ─── Cost Calculator ──────────────────────────────────────────────────────────

/**
 * Computes the estimated USD cost of an OpenRouter request using
 * the pricing table in constants.ts. Falls back to a conservative
 * premium estimate if the model is not in the table.
 */
export function computeCostUSD(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = MODEL_PRICING[model] ?? { inputPer1M: 5, outputPer1M: 20 };
  return (
    (promptTokens     / 1_000_000) * pricing.inputPer1M +
    (completionTokens / 1_000_000) * pricing.outputPer1M
  );
}

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Inserts one AI request telemetry row into `ai_requests_log`.
 * Non-blocking — errors here never affect the user response.
 */
export async function logAiRequest(doc: AiRequestLogDoc): Promise<void> {
  try {
    const db = await connectToDatabase();
    await db.collection<AiRequestLogDoc>('ai_requests_log').insertOne(doc);
  } catch (err) {
    logger.warn('[ai.telemetry] Failed to log AI request:', err);
  }
}

// ─── Index Bootstrap ──────────────────────────────────────────────────────────

/**
 * Creates indexes on ai_requests_log.
 * Called once from database.ts ensureIndexes().
 */
export async function ensureAiRequestLogIndexes(db: import('mongodb').Db): Promise<void> {
  // Per-user query index
  await db.collection('ai_requests_log').createIndex(
    { figmaUserId: 1, timestamp: -1 },
    { background: true }
  );
  // Global time-series query index + 90-day TTL auto-expiry
  await db.collection('ai_requests_log').createIndex(
    { timestamp: -1 },
    { background: true, expireAfterSeconds: 90 * 24 * 60 * 60 }
  );
}
