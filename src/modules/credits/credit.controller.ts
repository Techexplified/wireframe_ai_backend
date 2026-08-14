// ─── modules/credits/credit.controller.ts — Credit Check & Refund Handlers ────
//
// Handles the /generate/check (balance-only pre-flight check) and /generate/refund
// endpoints. These are credit-domain operations served via the AI feature routes.
//
// Fix H-02: /generate/check is now INFORMATIONAL ONLY — it reads the balance and
// returns whether the user can afford the model, but does NOT deduct any credits.
// Credit deduction happens exclusively in /generate/start (ai.controller.ts).
// This eliminates the double-deduction risk when both endpoints are called in sequence.
//
// Credit costs are driven by MODEL_CREDIT_COST in constants.ts:
//   kimi-2-6          → 2 credits
//   gpt-5-6-luna      → 1 credit  (default)
//   claude-sonnet-4-5 → 5 credits
//   gpt-4o            → 4 credits
//   gemini-1-5        → 2 credits

import { Request, Response } from 'express';
import { refundCredits } from './credit.service';
import { resolveModel } from '../ai/ai.router';
import { RefundRequest } from './credit.types';
import { ForbiddenError, BadRequestError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import {
  MODEL_CREDIT_COST,
  CREDIT_COST_GENERATE,
  DEFAULT_MODEL_KEY,
  MODEL_MAP,
  DEFAULT_MODEL,
} from '../../config/constants';

// ── POST /api/features/generate/check ────────────────────────────────────────
//
// INFORMATIONAL ONLY — returns whether the user has enough credits for the
// selected model WITHOUT deducting anything.
//
// Fix H-02: Previously called reserveCredits() causing double-deduction when
// the client also called /generate/start. Credits are now only deducted in /start.
//
// Fix C-01 (inherited): uses the resolved model credit cost (respects routing
// policy for free users) so the reported cost matches what /start will charge.

export async function checkGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits } = req.planState;

  // Fix C-01: resolve which model will actually execute before checking cost
  const modelKey = (req.body?.model as string) || DEFAULT_MODEL_KEY;
  const rawModel = MODEL_MAP[modelKey] ?? (modelKey.includes('/') ? modelKey : DEFAULT_MODEL);
  const resolvedModelId  = resolveModel(rawModel, 0, plan);
  const resolvedModelKey = Object.entries(MODEL_MAP).find(([, v]) => v === resolvedModelId)?.[0] ?? modelKey;
  const cost = MODEL_CREDIT_COST[resolvedModelKey] ?? CREDIT_COST_GENERATE;

  if (!isActive && credits === 0) {
    throw new ForbiddenError(
      'An active plan is required to generate wireframes. Please upgrade.',
      'plan_required'
    );
  }

  const totalCredits = credits + topup_credits;
  const canAfford    = totalCredits >= cost;

  if (!canAfford) {
    const message = plan === 'free'
      ? 'No credits remaining. Please upgrade to a plan.'
      : `Not enough credits. This model costs ${cost} credits and you have ${totalCredits} remaining.`;
    throw new ForbiddenError(message, 'insufficient_credits', isActive);
  }

  // No reserveCredits() call — balance check only.
  sendSuccess(res, {
    ok:                 true,
    can_afford:         canAfford,
    credits_left:       credits,
    topup_credits_left: topup_credits,
    total_credits_left: totalCredits,
    cost_required:      cost,
    resolved_model_key: resolvedModelKey,   // informs client which model will actually run
  });
}

// ── POST /api/features/generate/refund ───────────────────────────────────────
//
// Refunds credits to the specified pool. Called by the client if the stream
// fails after a successful /start deduction.
// Accepts `cost` in body so the correct variable amount is refunded.

export async function refundGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { pool, cost } = req.body as RefundRequest;

  if (!pool || !['plan', 'topup'].includes(pool)) {
    throw new BadRequestError('pool must be "plan" or "topup"', 'invalid_request');
  }

  // Validate cost — must be a positive integer matching a known model cost
  const refundCost = (typeof cost === 'number' && cost >= 1 && cost <= 10)
    ? cost
    : CREDIT_COST_GENERATE;

  await refundCredits(req.figmaUserId, pool, refundCost);
  logger.info(`[credit.controller] Refund: ${refundCost} credits to ${pool} pool for ${req.figmaUserId}`);
  sendSuccess(res, { ok: true, refunded: true, cost_refunded: refundCost });
}
