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
import { getUsersCollection } from '../../config/database';
import { PlanId, TopUpPackId, TOPUP_PACKS } from '../../config/constants';
import { BadRequestError, UnauthorizedError, AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

export async function dodoWebhookHandler(
  req: Request & { rawBody?: Buffer },
  res: Response
): Promise<void> {
  const signature = (
    req.headers['webhook-signature'] ||
    req.headers['x-dodo-signature'] ||
    req.headers['dodo-signature']
  ) as string | undefined;

  const msgId = (req.headers['webhook-id'] || req.headers['x-webhook-id']) as string | undefined;
  const timestamp = (req.headers['webhook-timestamp'] || req.headers['x-webhook-timestamp']) as string | undefined;
  const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  // ① Signature + timestamp MUST be verified first (supports Svix standard and legacy)
  if (!verifyWebhookSignature(rawBody, signature || '', { msgId, timestamp })) {
    logger.warn('[webhook.controller] Invalid webhook signature from IP:', req.ip);
    throw new UnauthorizedError('Invalid webhook signature', 'invalid_signature');
  }

  const payload   = req.body;
  const eventType = (payload.type || payload.event) as string | undefined;

  // Fix PAY-M-01: Use canonical payment_id or subscription_id as the idempotency key.
  const eventId = (payload.data?.payment_id || payload.data?.subscription_id || payload.event_id || payload.id) as string | undefined;

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

  // ── Handle payment / subscription success ─────────────────────────────────

  if (
    eventType === 'payment.succeeded' ||
    eventType === 'subscription.active' ||
    eventType === 'subscription.created' ||
    eventType === 'subscription.renewed' ||
    eventType === 'subscription.updated'
  ) {
    const metadata    = (payload.data?.metadata || payload.metadata || {}) as Record<string, unknown>;
    const figmaUserId = metadata.figmaUserId as string | undefined;

    // Fix PAY-M-02: Read canonical camelCase field — fallback to subscription if planId present
    const paymentType = (metadata.paymentType as 'subscription' | 'topup' | undefined) ||
      (metadata.planId ? 'subscription' : undefined);

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

      const dodoSubscriptionId = (
        payload.data?.subscription_id ||
        payload.subscription_id ||
        (payload.data?.object === 'subscription' ? payload.data?.id : undefined) ||
        null
      ) as string | null;

      try {
        const updatedUser = await activatePlan(figmaUserId, planId, dodoSubscriptionId);
        logger.info(`[webhook.controller] Plan activated: ${planId} for ${figmaUserId}${dodoSubscriptionId ? ` (sub: ${dodoSubscriptionId})` : ''}`);
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
    const figmaUserId = (metadata.figmaUserId as string | undefined) || (payload.data?.customer?.metadata?.figmaUserId as string | undefined);

    if (figmaUserId) {
      try {
        const users = await getUsersCollection();
        const updateFields: Record<string, unknown> = {
          subscription_cancelled: true,
          updatedAt: new Date(),
        };
        const rawEndsAt = payload.data?.next_billing_date || payload.data?.expires_at;
        if (rawEndsAt) {
          updateFields.subscription_ends_at = new Date(rawEndsAt);
        }
        await users.updateOne({ figmaUserId }, { $set: updateFields });
        logger.info(`[webhook.controller] Subscription marked cancelled for ${figmaUserId} — active until period ends`);
      } catch (err) {
        logger.warn('[webhook.controller] Failed to update subscription_cancelled in DB:', err);
      }
    }
    sendSuccess(res, { received: true, action: 'cancellation_noted' });
    return;
  }

  // All other event types — acknowledged but not acted on
  logger.info(`[webhook.controller] Ignored event type: ${eventType}`);
  sendSuccess(res, { received: true, ignored: true });
}
