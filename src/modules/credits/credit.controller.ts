// ─── modules/credits/credit.controller.ts — Credit Check & Refund Handlers ────
//
// Fix CREDIT-C-01: /generate/refund now requires reservationId only.
// The server looks up the authoritative cost and pool — clients cannot inflate refunds.
// Fix H-02: /generate/check is informational only (no credit deduction).
// Fix C-01: uses resolved model credit cost for free users.

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
// INFORMATIONAL ONLY — returns whether the user can afford the selected model.
// Does NOT deduct credits (Fix H-02).
// Uses resolved model cost so free users see the correct 1-credit cost (Fix C-01).

export async function checkGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { plan, isActive, credits, topup_credits } = req.planState;

  const modelKey        = (req.body?.model as string) || DEFAULT_MODEL_KEY;
  const rawModel        = MODEL_MAP[modelKey] ?? (modelKey.includes('/') ? modelKey : DEFAULT_MODEL);
  const resolvedModelId = resolveModel(rawModel, 0, plan);
  const resolvedKey     = Object.entries(MODEL_MAP).find(([, v]) => v === resolvedModelId)?.[0] ?? modelKey;
  const cost            = MODEL_CREDIT_COST[resolvedKey] ?? CREDIT_COST_GENERATE;

  if (!isActive && credits === 0) {
    throw new ForbiddenError('An active plan is required to generate wireframes.', 'plan_required');
  }

  const totalCredits = credits + topup_credits;
  if (totalCredits < cost) {
    const message = plan === 'free'
      ? 'No credits remaining. Please upgrade to a plan.'
      : `Not enough credits. This model costs ${cost} credits and you have ${totalCredits} remaining.`;
    throw new ForbiddenError(message, 'insufficient_credits', isActive);
  }

  sendSuccess(res, {
    ok:                 true,
    can_afford:         true,
    credits_left:       credits,
    topup_credits_left: topup_credits,
    total_credits_left: totalCredits,
    cost_required:      cost,
    resolved_model_key: resolvedKey,
  });
}

// ── POST /api/features/generate/refund ───────────────────────────────────────
//
// Fix CREDIT-C-01: Accepts only reservationId. Server looks up authoritative cost + pool.
// Clients cannot specify cost or pool — completely server-driven refund amount.

export async function refundGenerationHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { reservationId } = req.body as RefundRequest;

  if (!reservationId || typeof reservationId !== 'string' || !reservationId.trim()) {
    throw new BadRequestError('reservationId is required', 'invalid_request');
  }

  await refundCredits(req.figmaUserId, reservationId.trim());
  logger.info(`[credit.controller] Refund processed for reservation ${reservationId} — user ${req.figmaUserId}`);
  sendSuccess(res, { ok: true, refunded: true });
}
