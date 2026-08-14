// ─── modules/webhooks/webhook.controller.ts — Webhook Handlers ────────────────
//
// Fixes applied:
//   PAY-M-01: eventId uses only canonical data.payment_id; falls back to event_id only
//   PAY-M-02: paymentType reads only canonical metadata.paymentType (camelCase)
//   PAY-H-02: Added handlers for payment.refunded and subscription.cancelled events

import { Request, Response } from 'express';
import { verifyWebhookSignature } from '../payments/providers/dodo.provider';
import { markEventProcessed, unmarkEventProcessed } from '../../utils/idempotency';
import { activatePlan, expirePass } from '../users/user.service';
import { addTopUpCredits } from '../credits/credit.service';
import { PlanId, TopUpPackId, TOPUP_PACKS } from '../../config/constants';
import { BadRequestError, UnauthorizedError, AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

export async function dodoWebhookHandler(
  req: Request & { rawBody?: Buffer },
  res: Response
): Promise<void> {
  const signature = req.headers['x-dodo-signature'] as string | undefined;
  const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  // ① Signature + timestamp MUST be verified first (PAY-C-01: timestamp check is now inside verifyWebhookSignature)
  if (!verifyWebhookSignature(rawBody, signature || '')) {
    logger.warn('[webhook.controller] Invalid webhook signature from IP:', req.ip);
    throw new UnauthorizedError('Invalid webhook signature', 'invalid_signature');
  }

  const payload   = req.body;
  const eventType = (payload.type || payload.event) as string | undefined;

  // Fix PAY-M-01: Use canonical payment_id as the idempotency key.
  // data.payment_id is the most stable and unique identifier across Dodo webhook formats.
  // Fall back to event_id only if data.payment_id is absent (older API versions).
  const eventId = (payload.data?.payment_id || payload.event_id || payload.id) as string | undefined;

  if (!eventId) {
    logger.error('[webhook.controller] Missing eventId in payload:', payload);
    throw new BadRequestError('Missing event identifier', 'invalid_payload');
  }

  // ② Idempotency check (before any business logic)
  const isNewEvent = await markEventProcessed(eventId);
  if (!isNewEvent) {
    logger.info(`[webhook.controller] Duplicate event ${eventId} — skipping`);
    sendSuccess(res, { received: true, duplicate: true });
    return;
  }

  // ── Handle payment success ────────────────────────────────────────────────

  if (eventType === 'payment.succeeded') {
    const metadata    = (payload.data?.metadata || payload.metadata || {}) as Record<string, unknown>;
    const figmaUserId = metadata.figmaUserId as string | undefined;

    // Fix PAY-M-02: Read only canonical camelCase field — avoid ambiguous snake_case fallback
    const paymentType = metadata.paymentType as 'subscription' | 'topup' | undefined;

    if (!figmaUserId || !paymentType) {
      logger.error('[webhook.controller] Missing required metadata:', { figmaUserId: !!figmaUserId, paymentType });
      await unmarkEventProcessed(eventId);
      throw new BadRequestError('Missing figmaUserId or paymentType in metadata', 'invalid_metadata');
    }

    if (paymentType === 'subscription') {
      const planId = metadata.planId as PlanId | undefined;
      if (!planId || planId !== 'pro') {
        logger.error('[webhook.controller] Invalid planId in metadata:', planId);
        throw new BadRequestError('Invalid planId — only "pro" is valid', 'invalid_plan_id');
      }

      try {
        const updatedUser = await activatePlan(figmaUserId, planId);
        logger.info(`[webhook.controller] Plan activated: ${planId} for ${figmaUserId}`);
        sendSuccess(res, {
          received:             true,
          activated_plan:       planId,
          credits:              updatedUser.credits,
          subscription_ends_at: updatedUser.subscription_ends_at,
        });
      } catch (err) {
        logger.error('[webhook.controller] activatePlan error — unmarking event for retry:', err);
        await unmarkEventProcessed(eventId).catch((e) =>
          logger.error('[webhook.controller] Failed to unmark event:', e)
        );
        throw new AppError('Subscription activation failed', 500, 'activation_failed');
      }
      return;
    }

    if (paymentType === 'topup') {
      const packId = metadata.packId as TopUpPackId | undefined;
      if (!packId || !['small', 'medium', 'large'].includes(packId)) {
        logger.error('[webhook.controller] Invalid packId in metadata:', packId);
        throw new BadRequestError('Invalid packId in metadata', 'invalid_pack_id');
      }

      const creditsToAdd = TOPUP_PACKS[packId].credits;
      try {
        const result = await addTopUpCredits(figmaUserId, creditsToAdd);
        logger.info(`[webhook.controller] Top-up added: +${creditsToAdd} (${packId}) for ${figmaUserId}`);
        sendSuccess(res, { received: true, topup_added: creditsToAdd, topup_credits: result.topup_credits });
      } catch (err) {
        logger.error('[webhook.controller] addTopUpCredits error — unmarking event for retry:', err);
        await unmarkEventProcessed(eventId).catch((e) =>
          logger.error('[webhook.controller] Failed to unmark event:', e)
        );
        throw new AppError('Top-up credit addition failed', 500, 'topup_failed');
      }
      return;
    }
  }

  // ── Fix PAY-H-02: Handle refund and cancellation events ──────────────────
  //
  // When Dodo issues a refund or the user cancels/disputes a charge,
  // immediately expire the user's plan so credits are no longer usable.
  // This is the primary defence against "pay → use credits → chargeback" abuse.

  if (eventType === 'payment.refunded' || eventType === 'payment.reversed') {
    const metadata    = (payload.data?.metadata || payload.metadata || {}) as Record<string, unknown>;
    const figmaUserId = metadata.figmaUserId as string | undefined;

    if (!figmaUserId) {
      logger.warn('[webhook.controller] Refund event missing figmaUserId — cannot revoke credits');
      sendSuccess(res, { received: true, action: 'no_action_missing_user' });
      return;
    }

    try {
      await expirePass(figmaUserId);
      logger.warn(`[webhook.controller] ⚠️ REFUND/REVERSAL: plan expired for ${figmaUserId} (event: ${eventType})`);
      sendSuccess(res, { received: true, action: 'plan_revoked', reason: eventType });
    } catch (err) {
      logger.error('[webhook.controller] expirePass after refund error — unmarking for retry:', err);
      await unmarkEventProcessed(eventId).catch((e) =>
        logger.error('[webhook.controller] Failed to unmark event:', e)
      );
      throw new AppError('Plan revocation failed', 500, 'revocation_failed');
    }
    return;
  }

  if (eventType === 'subscription.cancelled' || eventType === 'payment.cancelled') {
    const metadata    = (payload.data?.metadata || payload.metadata || {}) as Record<string, unknown>;
    const figmaUserId = metadata.figmaUserId as string | undefined;

    if (figmaUserId) {
      // Log the cancellation — plan expires naturally at subscription_ends_at
      // (runOnceExpire runs on next getActivePlanState call). No immediate action needed.
      logger.info(`[webhook.controller] Subscription cancelled for ${figmaUserId} — will expire at next login`);
    }
    sendSuccess(res, { received: true, action: 'cancellation_noted' });
    return;
  }

  // All other event types — acknowledged but not acted on
  logger.info(`[webhook.controller] Ignored event type: ${eventType}`);
  sendSuccess(res, { received: true, ignored: true });
}
