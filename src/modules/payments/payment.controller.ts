// ─── modules/payments/payment.controller.ts — Checkout Handlers ───────────────

import { Request, Response } from 'express';
import { createPlanCheckout, createTopUpCheckout } from './providers/dodo.provider';
import { PLAN_CONFIG, TOPUP_PACKS } from '../../config/constants';
import { InitCheckoutRequest, TopUpCheckoutRequest } from './payment.types';
import { BadRequestError, ConflictError, ForbiddenError, AppError, BadGatewayError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

// ── POST /api/checkout/init ───────────────────────────────────────────────────

export async function initCheckoutHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { planId } = req.body as InitCheckoutRequest;
  const { plan: currentPlan, isActive, topup_credits, days_left, subscription_cancelled } = req.planState;

  if (!planId || planId !== 'pro') {
    throw new BadRequestError('planId must be "pro"', 'invalid_plan');
  }

  // BUG-C-01 fix: If the user cancelled auto-renewal, allow them to re-subscribe
  if (isActive && currentPlan === planId && !subscription_cancelled) {
    throw new ConflictError('You are already on the Pro plan with active auto-renewal.', 'already_on_plan');
  }

  if (!PLAN_CONFIG[planId].priceId) {
    logger.error(`[payment.controller] Dodo price ID not configured for plan: ${planId}`);
    throw new AppError('Payment provider not configured. Please contact support.', 500, 'configuration_error');
  }

  if (!process.env.DODO_API_KEY) {
    logger.error('[payment.controller] DODO_API_KEY is not set in environment');
    throw new AppError('Payment provider not configured. Please contact support.', 500, 'configuration_error');
  }

  try {
    const { checkoutUrl, checkoutId } = await createPlanCheckout(
      req.figmaUserId,
      planId,
      topup_credits,
      days_left
    );

    sendSuccess(res, { checkoutUrl, checkoutId });
  } catch (err) {
    logger.error('[payment.controller] createPlanCheckout error:', err);
    throw new BadGatewayError('Failed to create checkout session. Please try again.', 'checkout_failed');
  }
}

// ── POST /api/checkout/topup ──────────────────────────────────────────────────

export async function topupCheckoutHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { packId } = req.body as TopUpCheckoutRequest;
  const { isActive } = req.planState;

  if (!isActive) {
    throw new ForbiddenError(
      'An active Pro plan is required to purchase credit top-ups.',
      'plan_required'
    );
  }

  if (!packId || !['small', 'medium', 'large'].includes(packId)) {
    throw new BadRequestError('packId must be "small", "medium", or "large"', 'invalid_pack');
  }

  if (!TOPUP_PACKS[packId].priceId) {
    logger.error(`[payment.controller] Dodo price ID not configured for pack: ${packId}`);
    throw new AppError('Payment provider not configured. Please contact support.', 500, 'configuration_error');
  }

  try {
    const { checkoutUrl, checkoutId } = await createTopUpCheckout(
      req.figmaUserId,
      packId
    );

    sendSuccess(res, {
      checkoutUrl,
      checkoutId,
      pack_info: {
        credits: TOPUP_PACKS[packId].credits,
        price:   TOPUP_PACKS[packId].priceLabel,
      },
    });
  } catch (err) {
    logger.error('[payment.controller] createTopUpCheckout error:', err);
    throw new BadGatewayError('Failed to create checkout session. Please try again.', 'checkout_failed');
  }
}
