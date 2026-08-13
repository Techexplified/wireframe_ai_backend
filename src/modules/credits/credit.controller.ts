// ─── modules/credits/credit.controller.ts — Credit Check & Refund Handlers ────
//
// Handles the /generate/check (legacy pre-deduct check) and /generate/refund
// endpoints. These are credit-domain operations served via the AI feature routes.
//
// Variable credit costs (from constants.MODEL_CREDIT_COST):
//   kimi-2-6          → 2 credits
//   gpt-5-6-luna      → 1 credit (default)
//   claude-sonnet-4-5 → 5 credits
//   gpt-4o            → 4 credits
//   gemini-1-5        → 2 credits

import { Request, Response } from 'express';
import { reserveCredits, refundCredits, logUsage } from './credit.service';
import { RefundRequest } from './credit.types';
import { ForbiddenError, BadRequestError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import { MODEL_CREDIT_COST, CREDIT_COST_GENERATE } from '../../config/constants';

// ── POST /api/features/generate/check ────────────────────────────────────────
//
// Atomically deducts model-appropriate credits and returns the updated balance.
// Accepts `model` key in body to determine the credit cost.

export async function checkGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits } = req.planState;
  const figmaUserId = req.figmaUserId;

  // Determine credit cost for the requested model
  const modelKey = (req.body?.model as string) || 'gpt-5-6-luna';
  const cost = MODEL_CREDIT_COST[modelKey] ?? CREDIT_COST_GENERATE;

  if (!isActive && credits === 0) {
    throw new ForbiddenError(
      'An active plan is required to generate wireframes. Please upgrade.',
      'plan_required'
    );
  }

  const totalCredits = credits + topup_credits;
  if (totalCredits < cost) {
    const message = plan === 'free'
      ? 'No credits remaining. Please upgrade to a plan.'
      : `Not enough credits. This model costs ${cost} credits and you have ${totalCredits} remaining.`;
    throw new ForbiddenError(message, 'insufficient_credits', isActive);
  }

  const result = await reserveCredits(figmaUserId, cost);
  if (!result.success) {
    throw new ForbiddenError(
      `Not enough credits for this model (requires ${cost} credits).`,
      'insufficient_credits',
      isActive
    );
  }

  const promptSnippet = req.body?.promptSnippet as string | undefined;
  logUsage(figmaUserId, 'generate_wireframe', cost, promptSnippet)
    .catch((err) => logger.warn('Log usage error:', err));

  sendSuccess(res, {
    ok:                 true,
    credits_left:       result.creditsLeft,
    topup_credits_left: result.topup_creditsLeft,
    total_credits_left: result.creditsLeft + result.topup_creditsLeft,
    pool:               result.pool,
    cost_deducted:      cost,
  });
}

// ── POST /api/features/generate/refund ───────────────────────────────────────
//
// Refunds credits to the specified pool. Called by the client if the stream
// fails after a successful /check deduction.
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
  sendSuccess(res, { ok: true, refunded: true, cost_refunded: refundCost });
}
