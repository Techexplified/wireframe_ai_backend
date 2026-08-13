// ─── modules/ai/middleware/ai.budget.middleware.ts ────────────────────────────
//
// Pre-request cost ceiling guard. Scores prompt complexity, routes the model,
// estimates the worst-case USD cost, and rejects if it exceeds the plan's
// per-request cap. This runs BEFORE OpenRouter is touched.
//
// Per-request cost caps:
//   Free:    $0.03
//   Starter: $0.20
//   Pro:     $0.45
//
// Also attaches `req._aiComplexity` for downstream reuse (avoids double-scoring).

import { Request, Response, NextFunction } from 'express';
import { scoreComplexity } from '../ai.complexity';
import { resolveModel, estimateRequestCostUSD } from '../ai.router';
import {
  PER_REQUEST_COST_CAP_USD,
  MODEL_MAP,
  DEFAULT_MODEL,
} from '../../../config/constants';
import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { GenerateOptions } from '../ai.types';

// Conservative estimate of system + user prompt tokens before calling the API.
// (Real count unknown pre-call; this guards against worst-case output cost.)
const ESTIMATED_PROMPT_TOKENS = 3_000;

export async function aiBudgetMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const plan = req.planState.plan;
    const body = req.body as Partial<GenerateOptions>;

    // Skip if prompt is missing (will be caught later by controller validation)
    if (!body.prompt) {
      next();
      return;
    }

    const device     = body.device ?? 'desktop';
    const complexity = scoreComplexity(body.prompt, device);

    // Resolve which model will actually be used
    const modelKey  = body.model ?? 'kimi-2-6';
    const rawModel  = MODEL_MAP[modelKey] ?? (modelKey.includes('/') ? modelKey : DEFAULT_MODEL);
    const routedModel = resolveModel(rawModel, complexity.score, plan);

    // Estimate worst-case cost (prompt tokens + full token budget output)
    const estimatedCost = estimateRequestCostUSD(
      routedModel,
      ESTIMATED_PROMPT_TOKENS,
      complexity.tokenBudget
    );

    const cap = PER_REQUEST_COST_CAP_USD[plan];

    if (estimatedCost > cap) {
      const userId = req.figmaUserId ?? 'unknown';
      logger.warn(
        `[ai.budget] Request rejected — est. $${estimatedCost.toFixed(4)} > cap $${cap.toFixed(2)} for ${userId} (${plan})`,
        { complexityScore: complexity.score, model: routedModel }
      );
      throw new AppError(
        `This request's estimated cost ($${estimatedCost.toFixed(3)}) exceeds your plan's per-request limit ($${cap.toFixed(2)}). Simplify your prompt or upgrade your plan.`,
        402,
        'budget_exceeded'
      );
    }

    // Attach complexity to request so ai.service.ts doesn't re-score
    req._aiComplexity = complexity;

    next();
  } catch (err) {
    next(err);
  }
}
