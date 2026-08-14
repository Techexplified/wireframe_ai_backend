// ─── modules/ai/ai.router.ts — Model & Provider Routing Policy ────────────────
//
// Selects the OpenRouter model based on plan tier and prompt complexity.
//
// Routing logic:
//   Free plan  → always DEFAULT_MODEL (openai/gpt-5.6-luna) — 1 credit, great quality for trial
//   Pro plan   → user's selected model, no downgrade
//              (complexity scoring only gates token budget, not model choice)

import { MODEL_PRICING, DEFAULT_MODEL } from '../../config/constants';

// Fix C-02: was a hardcoded duplicate of DEFAULT_MODEL — now always in sync with constants.ts
const FREE_MODEL = DEFAULT_MODEL;

/**
 * Resolves the actual OpenRouter model to use.
 *
 * @param requestedModel - Full OpenRouter model string (e.g. 'openai/gpt-4o')
 * @param complexityScore - 1-10 score from scoreComplexity() (used for budget only)
 * @param plan - User's plan: 'free' | 'pro'
 */
export function resolveModel(
  requestedModel: string,
  complexityScore: number,
  plan: string
): string {
  // Free plan: always route to DEFAULT_MODEL (trial experience stays consistent)
  if (plan === 'free') return FREE_MODEL;

  // Pro plan: always respect the user's model selection — they paid for it
  // The credit cost system (MODEL_CREDIT_COST) already incentivises cheaper models
  return requestedModel;
}

/**
 * Estimates the USD cost of a single request BEFORE calling OpenRouter.
 * Used by aiBudgetMiddleware to reject requests that would exceed the plan cap.
 *
 * @param model         - OpenRouter model string
 * @param promptTokens  - Estimated input token count (conservative estimate)
 * @param maxTokens     - The token budget (worst-case output)
 */
export function estimateRequestCostUSD(
  model: string,
  promptTokens: number,
  maxTokens: number
): number {
  const pricing = MODEL_PRICING[model] ?? { inputPer1M: 5, outputPer1M: 20 };
  return (
    (promptTokens / 1_000_000) * pricing.inputPer1M +
    (maxTokens    / 1_000_000) * pricing.outputPer1M
  );
}
