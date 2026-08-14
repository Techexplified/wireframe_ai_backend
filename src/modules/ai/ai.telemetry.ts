// ─── modules/ai/ai.telemetry.ts — AI Request Telemetry Logger ─────────────────
//
// Records one document per OpenRouter request to the `ai_requests_log` collection.
// Logs: model, exact token counts, estimated USD cost, finish_reason, duration,
// and complexity score. Used for cost analysis and optimization iteration.

import { getAiRequestsLogCollection, AiRequestLogDoc } from '../../config/database';
import { MODEL_PRICING } from '../../config/constants';
import { logger } from '../../utils/logger';

export { AiRequestLogDoc };

// ─── Cost Calculator ──────────────────────────────────────────────────────────

/**
 * Computes the estimated USD cost of an OpenRouter request using
 * the pricing table in constants.ts. Falls back to a conservative
 * premium estimate if the model is not in the table.
 *
 * Fix C-04: reasoningTokens are billed at the output token rate by most
 * providers (including Anthropic). They are now included in the cost formula.
 */
export function computeCostUSD(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reasoningTokens: number = 0    // Fix C-04: was silently excluded, causing underreporting
): number {
  const pricing = MODEL_PRICING[model] ?? { inputPer1M: 5, outputPer1M: 20 };
  return (
    (promptTokens                        / 1_000_000) * pricing.inputPer1M +
    ((completionTokens + reasoningTokens) / 1_000_000) * pricing.outputPer1M
  );
}

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Inserts one AI request telemetry row into `ai_requests_log`.
 * Non-blocking — errors here never affect the user response.
 */
export async function logAiRequest(doc: AiRequestLogDoc): Promise<void> {
  try {
    const col = await getAiRequestsLogCollection();
    await col.insertOne(doc);
  } catch (err) {
    logger.warn('[ai.telemetry] Failed to log AI request:', err);
  }
}
